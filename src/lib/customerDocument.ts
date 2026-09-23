import { computeNitDv } from "@/lib/erp/exogena";

/**
 * Identificación del cliente de una factura (comensal o cliente de
 * facturación): normalización y DV — lógica PURA, sin DB.
 *
 * El dueño lo pidió así: "la identificación SIN el código de verificación".
 * Al cliente se le pide SÓLO el número. Para un NIT el dígito de
 * verificación no se captura ni se muestra: se CALCULA acá (`computeNitDv`)
 * y sólo lo consumen quienes lo necesitan de verdad (el XML de la DIAN, la
 * exógena). Si alguien igual escribe "901.944.469-1", se acepta: el número
 * queda sin el DV y el DV escrito se contrasta con el calculado — un DV que
 * no corresponde es señal de que el NIT está mal tecleado, y un NIT mal
 * tecleado en una factura electrónica sólo se corrige con nota crédito.
 *
 * Es el ÚNICO lugar donde se separa número y DV: lo usan el alta/edición de
 * clientes de facturación (`billingCustomerSchema`) y la solicitud de
 * factura nominativa (`invoice-request`). Si viviera en dos regex, tarde o
 * temprano aceptarían cosas distintas.
 */

export type CustomerDocType = "CC" | "CE" | "NIT" | "PA";

export type CustomerDocumentError = "invalid_document" | "invalid_verification_digit";

export type NormalizedCustomerDocument =
  | {
      ok: true;
      /** Sólo el número: dígitos para CC/NIT, alfanumérico en mayúsculas para CE/PA. */
      docNumber: string;
      /** DV calculado para NIT; null para los demás tipos. */
      verificationDigit: string | null;
    }
  | { ok: false; error: CustomerDocumentError };

/** Quita puntos y espacios (el comensal escribe "1.020.304" o "901 944 469"). */
export function compactDocumentNumber(raw: string): string {
  return raw.trim().replace(/[.\s]/g, "").toUpperCase();
}

/**
 * Normaliza lo que el cliente escribió como número de documento.
 *
 * `givenDigit` es el DV que llegue por un campo aparte (clientes de la API
 * que todavía lo mandan): se contrasta igual que el sufijo "-D".
 */
export function normalizeCustomerDocument(
  docType: CustomerDocType,
  raw: string,
  givenDigit?: string | null,
): NormalizedCustomerDocument {
  const compact = compactDocumentNumber(raw);
  const separate = (givenDigit ?? "").trim();
  if (docType === "NIT") {
    const match = /^(\d{4,15})(?:-(\d))?$/.exec(compact);
    if (!match) return { ok: false, error: "invalid_document" };
    const docNumber = match[1];
    const verificationDigit = computeNitDv(docNumber);
    if (!verificationDigit) return { ok: false, error: "invalid_document" };
    if ((match[2] && match[2] !== verificationDigit) || (separate && separate !== verificationDigit)) {
      return { ok: false, error: "invalid_verification_digit" };
    }
    return { ok: true, docNumber, verificationDigit };
  }
  // Un DV sólo existe en el NIT: en una cédula o pasaporte es un error.
  if (separate) return { ok: false, error: "invalid_document" };
  const valid = docType === "CC" ? /^\d{4,20}$/.test(compact) : /^[A-Z0-9]{4,20}$/.test(compact);
  if (!valid) return { ok: false, error: "invalid_document" };
  return { ok: true, docNumber: compact, verificationDigit: null };
}
