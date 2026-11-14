// Vendedor del documento soporte (el sujeto NO obligado a facturar), desde
// el proveedor del gasto o de la compra. Puro: valida y arma con lo que el
// proveedor tiene guardado; no inventa nada. Lo que falte se devuelve como
// lista para que la pantalla lo pida ANTES de gastar un número.
import { findMunicipioByCode } from "@/lib/dane/municipios";
import { computeNitDv } from "@/lib/erp/exogena";
import { findDianCountry, isValidPostalCode } from "./catalogs";
import {
  CUSTOMIZATION_NON_RESIDENT,
  CUSTOMIZATION_RESIDENT,
  TAX_LEVEL_NOT_APPLICABLE,
} from "./constants";
import type { SupportDocSeller } from "./types";

/** Lo que el documento soporte necesita de un proveedor. */
export type SupplierForSupportDoc = {
  id: string;
  name: string;
  taxId: string | null;
  /** NIT | CC | CE | PA (null = texto libre, sin tipo explícito). */
  taxIdType: string | null;
  /** natural | juridica (null = sin dato). */
  personType: string | null;
  address: string | null;
  notObligatedToInvoice: boolean;
  cityCode: string | null;
  postalCode: string | null;
  countryCode: string | null;
  foreignCityName: string | null;
};

export const SUPPLIER_DS_SELECT = {
  id: true,
  name: true,
  taxId: true,
  taxIdType: true,
  personType: true,
  address: true,
  notObligatedToInvoice: true,
  cityCode: true,
  postalCode: true,
  countryCode: true,
  foreignCityName: true,
} as const;

export type SellerMissing =
  | "not_flagged"
  | "name"
  | "document"
  | "resident_requires_nit"
  | "person_type"
  | "address"
  | "city"
  | "postal_code"
  | "country"
  | "foreign_city";

/** ¿Residente en Colombia? (sin país o "CO"). */
export function isResident(s: Pick<SupplierForSupportDoc, "countryCode">): boolean {
  const c = (s.countryCode ?? "").trim().toUpperCase();
  return !c || c === "CO";
}

/**
 * Tipo de persona (tabla 16.2.3): explícito si el proveedor lo tiene; si no,
 * se deduce SOLO cuando el documento lo deja claro (una cédula o un
 * pasaporte son de persona natural). Un NIT sin más dato puede ser de
 * cualquiera de las dos: se pregunta.
 */
export function sellerPersonType(s: Pick<SupplierForSupportDoc, "personType" | "taxIdType">): "1" | "2" | null {
  if (s.personType === "juridica") return "1";
  if (s.personType === "natural") return "2";
  if (s.taxIdType === "CC" || s.taxIdType === "CE" || s.taxIdType === "PA") return "2";
  return null;
}

/** Documento del residente: sólo dígitos, sin el DV escrito (se recalcula). */
function residentId(taxId: string | null, taxIdType: string | null): string {
  const raw = (taxId ?? "").trim();
  if (taxIdType === "PA") return "";
  const head = taxIdType === "NIT" || (taxIdType == null && raw.includes("-")) ? raw.split("-")[0] : raw;
  return head.replace(/\D/g, "");
}

/** Tipo de identificación del NO residente (tabla 16.2.1). */
export function foreignIdScheme(taxIdType: string | null): string {
  switch (taxIdType) {
    case "PA":
      return "41";
    case "CE":
      return "22";
    case "NIT":
      return "50"; // NIT de otro país
    default:
      return "42"; // Documento de identificación extranjero
  }
}

/** Qué le falta al proveedor para salir en un documento soporte. */
export function missingSellerFields(s: SupplierForSupportDoc): SellerMissing[] {
  const out: SellerMissing[] = [];
  if (!s.notObligatedToInvoice) out.push("not_flagged");
  if (!s.name.trim()) out.push("name");
  if (!sellerPersonType(s)) out.push("person_type");
  if (isResident(s)) {
    // DSAJ25a (pág. 147): con vendedor residente el tipo de documento DEBE
    // ser "31" (NIT) con DV. La persona natural se identifica con su cédula
    // como NIT; un pasaporte no sirve.
    if (s.taxIdType === "PA") out.push("resident_requires_nit");
    else if (!residentId(s.taxId, s.taxIdType)) out.push("document");
    // DSAJ08 (pág. 34): el conjunto completo de dirección con CustomizationID 10.
    const municipio = findMunicipioByCode(s.cityCode);
    if (!municipio) out.push("city");
    if (!isValidPostalCode(s.postalCode, municipio?.deptCode ?? null)) out.push("postal_code");
    if (!(s.address ?? "").trim()) out.push("address");
  } else {
    if (!findDianCountry(s.countryCode)) out.push("country");
    if (!(s.foreignCityName ?? "").trim()) out.push("foreign_city");
    if (!(s.taxId ?? "").replace(/[^A-Za-z0-9]/g, "")) out.push("document");
  }
  return out;
}

/** CustomizationID según la procedencia del vendedor (tabla 16.1.4.1). */
export function customizationFor(s: Pick<SupplierForSupportDoc, "countryCode">): "10" | "11" {
  return isResident(s) ? CUSTOMIZATION_RESIDENT : CUSTOMIZATION_NON_RESIDENT;
}

/**
 * Vendedor listo para el XML. Lanza si falta algo: el caller valida antes
 * con `missingSellerFields` (nunca se arma un vendedor con datos inventados).
 */
export function sellerFromSupplier(s: SupplierForSupportDoc): SupportDocSeller {
  const missing = missingSellerFields(s).filter((m) => m !== "not_flagged");
  if (missing.length) throw new Error(`seller_incomplete:${missing.join(",")}`);
  const personType = sellerPersonType(s)!;
  if (isResident(s)) {
    const municipio = findMunicipioByCode(s.cityCode)!;
    const companyId = residentId(s.taxId, s.taxIdType);
    return {
      personType,
      name: s.name.trim(),
      companyId,
      dv: computeNitDv(companyId),
      idSchemeName: "31",
      taxLevelCode: TAX_LEVEL_NOT_APPLICABLE,
      address: {
        kind: "resident",
        cityCode: municipio.code,
        cityName: municipio.name,
        postalZone: (s.postalCode ?? "").trim(),
        deptCode: municipio.deptCode,
        deptName: municipio.deptName,
        line: (s.address ?? "").trim(),
      },
    };
  }
  const country = findDianCountry(s.countryCode)!;
  return {
    personType,
    name: s.name.trim(),
    companyId: (s.taxId ?? "").replace(/[^A-Za-z0-9]/g, ""),
    dv: null,
    idSchemeName: foreignIdScheme(s.taxIdType),
    taxLevelCode: TAX_LEVEL_NOT_APPLICABLE,
    address: {
      kind: "foreign",
      cityName: (s.foreignCityName ?? "").trim(),
      countryCode: country.code,
      countryName: country.name,
      line: (s.address ?? "").trim() || null,
    },
  };
}
