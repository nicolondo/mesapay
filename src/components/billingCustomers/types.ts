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
  /** Crédito: la cuenta se puede cobrar "a crédito" a este cliente. */
  creditEnabled: boolean;
  /** null = sin tope. */
  creditLimitCents: number | null;
  creditTermsDays: number;
  /** Descuento comercial fijo, en puntos base (1000 = 10 %). */
  discountEnabled: boolean;
  discountBps: number;
  /** Lo que debe hoy por ventas a crédito (lo agrega el listado). */
  debtCents?: number;
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

/** Cupo disponible con tope; null sin tope. */
export function creditAvailableCents(customer: Pick<BillingCustomerRecord, "creditLimitCents" | "debtCents">): number | null {
  if (customer.creditLimitCents == null) return null;
  return Math.max(0, customer.creditLimitCents - (customer.debtCents ?? 0));
}

/** "12.5" para 1250 puntos base (lo que se muestra y se edita). */
export function discountBpsToPctText(bps: number): string {
  return (bps / 100).toFixed(bps % 100 === 0 ? 0 : bps % 10 === 0 ? 1 : 2);
}

/** "12,5" / "12.5" → 1250 puntos base; null si no es un número válido. */
export function discountPctTextToBps(text: string): number | null {
  const n = Number(text.trim().replace(",", "."));
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 100);
}
