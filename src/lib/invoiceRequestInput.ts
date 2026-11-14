import { z } from "zod";
import { normalizeCustomerDocument, type CustomerDocumentError } from "@/lib/customerDocument";
import { normalizeExtraEmails, type ExtraEmailsError } from "@/lib/invoiceEmails";

/**
 * Datos de una solicitud de factura PERSONALIZADA y su validación — la
 * MISMA para lo que el comensal o el mesero escriben y para lo que sale de
 * un cliente guardado ("Usar estos datos"): un registro guardado se valida
 * igual que uno nuevo antes de emitir. Vive acá (y no en la ruta) porque la
 * usan la ruta `invoice-request` y la memoria de clientes
 * (`invoiceCustomerMemory`).
 *
 * Dirección, ciudad y departamento son OPCIONALES: el formulario ya no los
 * pide. Si un cliente viejo los manda igual, se validan y se guardan;
 * ausentes o vacíos ⇒ null.
 */

const optionalText = (min: number, max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((v) => v || null)
    .refine((v) => v === null || v.length >= min);

export const invoiceDocTypeSchema = z.enum(["CC", "CE", "NIT", "PA"]);

export const invoiceRequestFieldsSchema = z.object({
  customerName: z.string().trim().min(2).max(160),
  docType: invoiceDocTypeSchema,
  docNumber: z.string().trim().min(4).max(40),
  address: optionalText(4, 240),
  city: optionalText(2, 80),
  department: optionalText(2, 80),
  email: z.string().email().max(160),
  // Correos adicionales (ver src/lib/invoiceEmails.ts). Crudos acá; la
  // normalización y el tope van en `validateInvoiceFields`.
  ccEmails: z.array(z.string().max(160)).max(20).nullish(),
});

export type InvoiceRequestFields = {
  customerName: string;
  docType: "CC" | "CE" | "NIT" | "PA";
  /** Ya normalizado: sólo el número, sin puntos, espacios ni DV. */
  docNumber: string;
  address: string | null;
  city: string | null;
  department: string | null;
  email: string;
  /** Adicionales: normalizados, sin el principal, como mucho 4. */
  ccEmails: string[];
};

export type ValidatedInvoiceFields =
  | { ok: true; fields: InvoiceRequestFields }
  | { ok: false; error: "invalid"; code?: CustomerDocumentError | ExtraEmailsError; index?: number };

/**
 * Valida y normaliza los datos de facturación (escritos o guardados). El
 * documento queda sin DV (ver src/lib/customerDocument.ts).
 */
export function validateInvoiceFields(input: unknown): ValidatedInvoiceFields {
  const parsed = invoiceRequestFieldsSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "invalid" };
  const document = normalizeCustomerDocument(parsed.data.docType, parsed.data.docNumber);
  if (!document.ok) return { ok: false, error: "invalid", code: document.error };
  const extras = normalizeExtraEmails(parsed.data.email, parsed.data.ccEmails);
  if (!extras.ok) return { ok: false, error: "invalid", code: extras.error, index: extras.index };
  return {
    ok: true,
    fields: {
      customerName: parsed.data.customerName,
      docType: parsed.data.docType,
      docNumber: document.docNumber,
      address: parsed.data.address,
      city: parsed.data.city,
      department: parsed.data.department,
      email: parsed.data.email.trim(),
      ccEmails: extras.emails,
    },
  };
}
