/**
 * Qué correo recibe el comensal cuando hay una factura para él.
 *
 * Hay DOS correos posibles y se confundían:
 *
 *   · El COMPROBANTE de MESAPAY (`sendSimpleInvoiceEmail`): la tirilla con
 *     el link a /factura/[id]. Es un comprobante nuestro, no un documento
 *     fiscal.
 *   · La FACTURA ELECTRÓNICA (`sendDianInvoiceEmail`): el AttachedDocument
 *     con el XML firmado y el acuse de la DIAN. Es lo que el emisor está
 *     obligado a entregar.
 *
 * Con facturación electrónica activa salían los dos, o —peor— sólo el
 * comprobante cuando la factura DIAN todavía no tenía destinatario. El
 * dueño lo dijo textual: "si la empresa maneja facturación electrónica
 * nunca necesito que mande comprobantes, solamente las facturas
 * electrónicas". Esta es la única regla, y vive en un solo lugar:
 *
 *   · SIN módulo `einvoicing`  ⇒ comprobante, como siempre.
 *   · CON módulo `einvoicing`  ⇒ NUNCA comprobante. La factura electrónica
 *     sale sola cuando la DIAN acepta (ver sendInvoiceEmail.ts). Acá sólo
 *     cubrimos el hueco de "el correo llegó DESPUÉS de la aceptación": si
 *     el documento ya está aceptado y nunca se envió, se manda ahora.
 *
 * Nunca lanza: un correo no puede tumbar un cobro ni una solicitud.
 */
import { db } from "@/lib/db";
import { isModuleEnabled } from "@/lib/modules";
import { sendSimpleInvoiceEmail } from "@/lib/simpleInvoice";
import type { InvoiceSnapshot } from "@/lib/invoice";

export type InvoiceDeliveryMode = "comprobante" | "factura_electronica";

/**
 * Regla pura: ¿qué correo corresponde a este comercio?
 * Separada para poder testearla sin DB ni correo.
 */
export function invoiceDeliveryMode(enabledModules: unknown): InvoiceDeliveryMode {
  return isModuleEnabled(enabledModules, "einvoicing")
    ? "factura_electronica"
    : "comprobante";
}

export type DeliverInvoiceEmailArgs = {
  tenant: { id: string; enabledModules: unknown };
  invoice: {
    invoiceId: string;
    invoiceNumber: number;
    invoiceUrl: string;
    snapshot: InvoiceSnapshot;
    email: string | null;
    locale: string | null;
  };
  /**
   * `true` si la tirilla se acaba de emitir en esta llamada. El comprobante
   * sólo sale la primera vez (como siempre fue) — salvo que el correo recién
   * se conozca ahora, ver `emailJustProvided`.
   */
  firstIssuance: boolean;
  /**
   * `true` cuando el comensal acaba de dejar su correo sobre una tirilla ya
   * emitida sin correo. Antes ese correo se descartaba y no salía nada.
   */
  emailJustProvided?: boolean;
};

export type DeliverInvoiceEmailResult =
  | { sent: "comprobante" }
  | { sent: "factura_electronica" }
  | { sent: "none"; reason: "no_email" | "not_first_issuance" | "dian_not_ready" | "already_emailed" | "no_environment" | "error" };

export async function deliverInvoiceEmail(
  args: DeliverInvoiceEmailArgs,
): Promise<DeliverInvoiceEmailResult> {
  try {
    const email = args.invoice.email?.trim();
    if (!email) return { sent: "none", reason: "no_email" };

    if (invoiceDeliveryMode(args.tenant.enabledModules) === "comprobante") {
      if (!args.firstIssuance && !args.emailJustProvided) {
        return { sent: "none", reason: "not_first_issuance" };
      }
      // Best-effort, igual que siempre: la tirilla ya existe y su link es
      // válido aunque el correo demore o falle. `sendSimpleInvoiceEmail` no lanza.
      void sendSimpleInvoiceEmail({
        invoiceId: args.invoice.invoiceId,
        snapshot: args.invoice.snapshot,
        invoiceNumber: args.invoice.invoiceNumber,
        invoiceUrl: args.invoice.invoiceUrl,
        email,
        locale: args.invoice.locale,
      });
      return { sent: "comprobante" };
    }

    // Facturación electrónica: NUNCA el comprobante. Si la DIAN ya aceptó
    // y el documento sigue sin enviarse (típico: el correo se conoció
    // después de la aceptación), se manda ahora. Si todavía no está
    // aceptado, no hay nada que hacer: la aceptación lo dispara sola y ya
    // va a encontrar el destinatario que acabamos de guardar.
    const doc = await db.dianDocument.findUnique({
      where: { simpleInvoiceId: args.invoice.invoiceId },
      select: { id: true, state: true, emailedAt: true },
    });
    if (!doc || doc.state !== "accepted") return { sent: "none", reason: "dian_not_ready" };
    if (doc.emailedAt) return { sent: "none", reason: "already_emailed" };

    // Imports diferidos a propósito: el camino del comprobante (y sus tests)
    // no tiene por qué cargar el módulo de la DIAN.
    const [{ dianEnvironment }, { sendDianInvoiceEmail }] = await Promise.all([
      import("@/lib/dian/config"),
      import("@/lib/dian/sendInvoiceEmail"),
    ]);
    const environment = await dianEnvironment(args.tenant.id);
    if (!environment) return { sent: "none", reason: "no_environment" };
    void sendDianInvoiceEmail({ documentId: doc.id, environment });
    return { sent: "factura_electronica" };
  } catch (err) {
    console.error("[invoice-delivery] no se pudo decidir/enviar el correo", {
      invoiceId: args.invoice.invoiceId,
      err,
    });
    return { sent: "none", reason: "error" };
  }
}
