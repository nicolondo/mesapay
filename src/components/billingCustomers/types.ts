import type { DocType } from "@/components/invoice/types";

export type BillingCustomerRecord = {
  id: string;
  customerName: string;
  docType: DocType;
  docNumber: string;
  verificationDigit: string | null;
  email: string;
  phone: string | null;
  address: string;
  municipalityCode: string;
  city: string;
  department: string;
  country: string;
};

export function billingDocument(customer: Pick<BillingCustomerRecord, "docType" | "docNumber" | "verificationDigit">): string {
  return customer.docType === "NIT" && customer.verificationDigit
    ? `${customer.docNumber}-${customer.verificationDigit}`
    : customer.docNumber;
}
