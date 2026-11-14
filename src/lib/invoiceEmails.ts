import { z } from "zod";

/**
 * Varios correos para una factura. El dueño: "poder crear más de 1 correo
 * para las facturas … para que la factura electrónica vaya a más de un
 * correo".
 *
 *  - `email` sigue siendo el PRINCIPAL: es el único que va en el XML de la
 *    DIAN (cac:Contact del adquiriente) y el que se muestra en todas partes.
 *    La estructura UBL no cambia.
 *  - `ccEmails` son los ADICIONALES: el correo de la factura (PDF/enlace y
 *    AttachedDocument) sale al principal y en copia a estos, también en el
 *    reenvío.
 *  - Máximo `MAX_INVOICE_EMAILS` en total (principal + adicionales), sin
 *    repetir (sin distinguir mayúsculas), validados como correo.
 *
 * Lógica PURA, compartida por la solicitud de factura, el cliente de
 * facturación (Clientes y "Recordar mis datos") y el envío.
 */

export const MAX_INVOICE_EMAILS = 5;
export const MAX_EXTRA_INVOICE_EMAILS = MAX_INVOICE_EMAILS - 1;

const emailSchema = z.string().trim().email().max(160);

export type ExtraEmailsError = "invalid_email" | "too_many_emails";

export type NormalizedExtraEmails =
  | { ok: true; emails: string[] }
  | { ok: false; error: ExtraEmailsError; index?: number };

/**
 * Limpia los correos adicionales: quita vacíos, pasa a minúsculas, saca los
 * repetidos y el que ya es el principal. Uno mal escrito es un error (con su
 * posición, para que el formulario lo marque); más de 4 también.
 */
export function normalizeExtraEmails(primary: string | null | undefined, extras: readonly string[] | null | undefined): NormalizedExtraEmails {
  const seen = new Set<string>();
  const main = primary?.trim().toLowerCase();
  if (main) seen.add(main);
  const emails: string[] = [];
  for (const [index, raw] of (extras ?? []).entries()) {
    const value = raw.trim().toLowerCase();
    if (!value) continue;
    if (!emailSchema.safeParse(value).success) return { ok: false, error: "invalid_email", index };
    if (seen.has(value)) continue;
    seen.add(value);
    emails.push(value);
  }
  if (emails.length > MAX_EXTRA_INVOICE_EMAILS) return { ok: false, error: "too_many_emails" };
  return { ok: true, emails };
}

/** Lo que guarda la DB, filtrado: sólo correos válidos, sin repetidos, como mucho 4. */
export function storedExtraEmails(primary: string | null | undefined, extras: readonly string[] | null | undefined): string[] {
  const main = primary?.trim().toLowerCase();
  const seen = new Set<string>(main ? [main] : []);
  const emails: string[] = [];
  for (const raw of extras ?? []) {
    const value = raw.trim().toLowerCase();
    if (!value || seen.has(value) || !emailSchema.safeParse(value).success) continue;
    seen.add(value);
    emails.push(value);
    if (emails.length === MAX_EXTRA_INVOICE_EMAILS) break;
  }
  return emails;
}

/** Destinatarios del envío: el principal en `to` y los demás en copia. */
export function invoiceRecipients(primary: string, extras: readonly string[] | null | undefined): { to: string; cc: string[] } {
  return { to: primary.trim(), cc: storedExtraEmails(primary, extras) };
}

/** Mismo conjunto de adicionales (sin importar orden ni mayúsculas). */
export function sameExtraEmails(a: readonly string[], b: readonly string[]): boolean {
  const norm = (list: readonly string[]) => [...new Set(list.map((e) => e.trim().toLowerCase()))].sort().join("\n");
  return norm(a) === norm(b);
}
