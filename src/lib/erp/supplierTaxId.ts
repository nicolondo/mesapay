// Identificación de un PROVEEDOR — lógica PURA (cliente y servidor).
//
// `Supplier.taxId` es texto libre desde siempre ("900123456-7", "NIT
// 900.123.456", "1020304050"). El alta rápida (formulario de gastos) pide
// tipo de documento y número, calcula el DV del NIT con la misma regla de
// la factura electrónica (`normalizeCustomerDocument`) y guarda el NIT como
// «número-DV»: es el formato que la exógena ya lee como NIT
// (`supplierTercero`).
//
// `supplierTaxKey` es la clave para detectar duplicados: sólo el número, sin
// puntos, espacios, prefijo «NIT» ni DV — "900.123.456-7" y "900123456"
// son el mismo proveedor.
import {
  normalizeCustomerDocument,
  type CustomerDocType,
  type CustomerDocumentError,
} from "@/lib/customerDocument";

export const SUPPLIER_TAX_ID_TYPES = ["NIT", "CC", "CE", "PA"] as const satisfies readonly CustomerDocType[];
export type SupplierTaxIdType = (typeof SUPPLIER_TAX_ID_TYPES)[number];

export const SUPPLIER_PERSON_TYPES = ["natural", "juridica"] as const;
export type SupplierPersonType = (typeof SUPPLIER_PERSON_TYPES)[number];

/** Clave de comparación de un documento (null si no hay documento). */
export function supplierTaxKey(raw: string | null | undefined): string | null {
  let s = (raw ?? "").trim().replace(/^nit\.?\s*/i, "");
  // DV escrito al final ("900123456-7"): no es parte del número.
  s = s.replace(/^(.*\d)\s*-\s*\d$/, "$1");
  const key = s.replace(/[\s.\-]/g, "").toUpperCase();
  return key.length > 0 ? key : null;
}

/** ¿Dos documentos son el mismo tercero? */
export function sameSupplierTaxId(a: string | null | undefined, b: string | null | undefined): boolean {
  const ka = supplierTaxKey(a);
  return ka !== null && ka === supplierTaxKey(b);
}

export type NormalizedSupplierTaxId =
  | { ok: true; taxId: string; docNumber: string; verificationDigit: string | null }
  | { ok: false; error: CustomerDocumentError };

/**
 * Del tipo y número que escribió el operador al `taxId` que se guarda: el
 * NIT con su DV calculado ("900123456-7"); los demás, sólo el número. Un
 * DV escrito que no corresponde es un error (NIT mal tecleado).
 */
export function normalizeSupplierTaxId(type: SupplierTaxIdType, raw: string): NormalizedSupplierTaxId {
  const n = normalizeCustomerDocument(type, raw);
  if (!n.ok) return n;
  return {
    ok: true,
    taxId: n.verificationDigit ? `${n.docNumber}-${n.verificationDigit}` : n.docNumber,
    docNumber: n.docNumber,
    verificationDigit: n.verificationDigit,
  };
}

/** Tipo de persona por defecto del tipo de documento (el operador lo puede cambiar). */
export function defaultPersonType(type: SupplierTaxIdType): SupplierPersonType {
  return type === "NIT" ? "juridica" : "natural";
}

/** Busca entre `suppliers` uno con el mismo documento. */
export function findSupplierByTaxId<T extends { taxId: string | null }>(
  suppliers: readonly T[],
  taxId: string | null | undefined,
): T | null {
  const key = supplierTaxKey(taxId);
  if (!key) return null;
  return suppliers.find((s) => supplierTaxKey(s.taxId) === key) ?? null;
}
