import type { DocType } from "@/components/invoice/types";

export type BillingCustomerRecord = {
  id: string;
  customerName: string;
  docType: DocType;
  docNumber: string;
  verificationDigit: string | null;
  email: string;
  phone: string | null;
  /** Dirección y municipio: null salvo en clientes cargados cuando aún se pedían. */
  address: string | null;
  municipalityCode: string | null;
  city: string | null;
  department: string | null;
  country: string;
};

/**
 * Identificación tal como se MUESTRA (y se carga en un formulario): sólo el
 * número, sin el dígito de verificación. El DV del NIT se guarda aparte
 * (`verificationDigit`) para quien lo necesita de verdad —el XML de la DIAN
 * y la exógena lo leen de ese campo o lo recalculan— pero al operador y al
 * comensal no se les pide ni se les enseña.
 */
export function billingDocument(customer: Pick<BillingCustomerRecord, "docType" | "docNumber" | "verificationDigit">): string {
  return customer.docNumber;
}

/** "Dirección · Ciudad, Departamento" con lo que haya; "" cuando el cliente no dejó dirección. */
export function billingLocation(customer: Pick<BillingCustomerRecord, "address" | "city" | "department">): string {
  const cityDept = [customer.city, customer.department].filter(Boolean).join(", ");
  return [customer.address, cityDept].filter(Boolean).join(" · ");
}
