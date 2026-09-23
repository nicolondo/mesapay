import { z } from "zod";
import { findMunicipioByCode } from "@/lib/dane/municipios";
import { normalizeCustomerDocument } from "@/lib/customerDocument";

/** Billing identities are restaurant-owned contacts, never login accounts. */
export const BILLING_CUSTOMER_WRITE_ROLES = ["operator", "platform_admin", "group_admin"] as const;
export const BILLING_CUSTOMER_READ_ROLES = [...BILLING_CUSTOMER_WRITE_ROLES, "mesero"] as const;

/**
 * Texto opcional: ausente, `null` o cadena vacía ⇒ `null`. Si viene con
 * contenido se valida como antes (largo mínimo) — la factura nominativa ya
 * no pide dirección ni municipio, pero si un cliente los manda igual no se
 * guardan a medias.
 */
function optionalText(min: number, max: number, message: string) {
  return z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((v) => v || null)
    .refine((v) => v === null || v.length >= min, { message });
}

export const billingCustomerSchema = z.object({
  customerName: z.string().trim().min(2).max(160),
  docType: z.enum(["CC", "CE", "NIT", "PA"]),
  docNumber: z.string().trim().min(4).max(40),
  verificationDigit: z.string().trim().regex(/^\d?$/).nullable().optional(),
  email: z.string().trim().email().max(160).transform((v) => v.toLowerCase()),
  phone: z.string().trim().max(40).nullable().optional(),
  address: optionalText(4, 240, "invalid_address"),
  municipalityCode: optionalText(5, 5, "invalid_municipality").refine(
    (v) => v === null || /^\d{5}$/.test(v),
    { message: "invalid_municipality" },
  ),
  country: z.literal("CO").optional(),
  // Crédito: opcionales para que los clientes viejos del formulario sigan
  // andando; un límite vacío/0 = sin tope. El plazo no puede ser negativo.
  creditEnabled: z.boolean().optional(),
  creditLimitCents: z.number().int().min(0).max(2_000_000_000).nullable().optional(),
  creditTermsDays: z.number().int().min(0).max(3650).optional(),
  // Descuento comercial fijo, en puntos base (1000 = 10 %; tope 50 %).
  discountEnabled: z.boolean().optional(),
  discountBps: z.number().int().min(0).max(5000).optional(),
}).transform((input, ctx) => {
  // El municipio sólo se resuelve si vino: el catálogo DANE sigue siendo la
  // única fuente de ciudad/departamento, nunca texto libre del cliente.
  const municipality = input.municipalityCode ? findMunicipioByCode(input.municipalityCode) : null;
  if (input.municipalityCode && !municipality) {
    ctx.addIssue({ code: "custom", path: ["municipalityCode"], message: "invalid_municipality" });
    return z.NEVER;
  }
  // Identificación: sólo el número. Para un NIT el DV se CALCULA acá y se
  // guarda aparte (`verificationDigit`); el formulario ya no lo pide. Si
  // igual llega —como sufijo "-D" o por el campo viejo de la API— se
  // contrasta con el calculado. Ver src/lib/customerDocument.ts.
  const document = normalizeCustomerDocument(input.docType, input.docNumber, input.verificationDigit);
  if (!document.ok) {
    // El error se marca sobre el campo que el operador ve: el número. El
    // campo aparte sólo se señala si fue él quien trajo el DV equivocado.
    const path = document.error === "invalid_verification_digit" && input.verificationDigit ? "verificationDigit" : "docNumber";
    ctx.addIssue({ code: "custom", path: [path], message: document.error });
    return z.NEVER;
  }
  return {
    customerName: input.customerName,
    docType: input.docType,
    docNumber: document.docNumber,
    verificationDigit: document.verificationDigit,
    email: input.email,
    phone: input.phone || null,
    address: input.address,
    municipalityCode: municipality?.code ?? null,
    city: municipality?.name ?? null,
    department: municipality?.deptName ?? null,
    country: "CO" as const,
    // Si el cliente no manda los campos de crédito quedan `undefined`: en el
    // alta Prisma aplica los defaults y en la edición no los toca (un
    // formulario viejo no puede apagar el crédito sin querer).
    creditEnabled: input.creditEnabled,
    creditLimitCents:
      input.creditLimitCents === undefined ? undefined : input.creditLimitCents || null,
    creditTermsDays: input.creditTermsDays,
    discountEnabled: input.discountEnabled,
    discountBps: input.discountBps,
  };
});

export type BillingCustomerData = z.output<typeof billingCustomerSchema>;
