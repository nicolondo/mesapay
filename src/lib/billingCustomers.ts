import { z } from "zod";
import { findMunicipioByCode } from "@/lib/dane/municipios";
import { computeNitDv } from "@/lib/erp/exogena";

/** Billing identities are restaurant-owned contacts, never login accounts. */
export const BILLING_CUSTOMER_WRITE_ROLES = ["operator", "platform_admin", "group_admin"] as const;
export const BILLING_CUSTOMER_READ_ROLES = [...BILLING_CUSTOMER_WRITE_ROLES, "mesero"] as const;

export const billingCustomerSchema = z.object({
  customerName: z.string().trim().min(2).max(160),
  docType: z.enum(["CC", "CE", "NIT", "PA"]),
  docNumber: z.string().trim().min(4).max(40),
  verificationDigit: z.string().trim().regex(/^\d?$/).nullable().optional(),
  email: z.string().trim().email().max(160).transform((v) => v.toLowerCase()),
  phone: z.string().trim().max(40).nullable().optional(),
  address: z.string().trim().min(4).max(240),
  municipalityCode: z.string().trim().regex(/^\d{5}$/),
  country: z.literal("CO").optional(),
}).transform((input, ctx) => {
  const municipality = findMunicipioByCode(input.municipalityCode);
  if (!municipality) {
    ctx.addIssue({ code: "custom", path: ["municipalityCode"], message: "invalid_municipality" });
    return z.NEVER;
  }
  const compact = input.docNumber.replace(/[.\s]/g, "").toUpperCase();
  let docNumber = compact;
  let verificationDigit: string | null = null;
  if (input.docType === "NIT") {
    const match = /^(\d{4,15})(?:-(\d))?$/.exec(compact);
    if (!match) {
      ctx.addIssue({ code: "custom", path: ["docNumber"], message: "invalid_document" });
      return z.NEVER;
    }
    docNumber = match[1];
    verificationDigit = computeNitDv(docNumber);
    if ((match[2] && match[2] !== verificationDigit) || (input.verificationDigit && input.verificationDigit !== verificationDigit)) {
      ctx.addIssue({ code: "custom", path: ["verificationDigit"], message: "invalid_verification_digit" });
      return z.NEVER;
    }
  } else {
    const valid = input.docType === "CC" ? /^\d{4,20}$/.test(compact) : /^[A-Z0-9]{4,20}$/.test(compact);
    if (!valid || input.verificationDigit) {
      ctx.addIssue({ code: "custom", path: [!valid ? "docNumber" : "verificationDigit"], message: "invalid_document" });
      return z.NEVER;
    }
  }
  return {
    customerName: input.customerName,
    docType: input.docType,
    docNumber,
    verificationDigit,
    email: input.email,
    phone: input.phone || null,
    address: input.address,
    municipalityCode: municipality.code,
    city: municipality.name,
    department: municipality.deptName,
    country: "CO" as const,
  };
});

export type BillingCustomerData = z.output<typeof billingCustomerSchema>;
