// Catálogos del anexo técnico del documento soporte que no tiene el resto
// del repo. Los JSON los genera scripts/generate-dian-ds-catalogs.mjs desde
// la caja de herramientas oficial de la DIAN (no editar a mano).
import postalCodes from "./data/postalCodes.json";
import countries from "./data/countries.json";

const POSTAL = new Set<string>(postalCodes as string[]);

export type DianCountry = { code: string; name: string };
export const DIAN_COUNTRIES: readonly DianCountry[] = countries as DianCountry[];
const COUNTRY_BY_CODE = new Map(DIAN_COUNTRIES.map((c) => [c.code, c]));

/**
 * ¿El código postal existe en la tabla 16.4.4 y pertenece al departamento?
 * DSAJ73 (pág. 35) rechaza un código que no esté en la tabla. Los códigos
 * postales colombianos empiezan por el código DANE del departamento, así
 * que además se exige que coincida con el municipio elegido: un código de
 * otro departamento pasaría la tabla pero declararía otro lugar.
 */
export function isValidPostalCode(code: string | null | undefined, deptCode?: string | null): boolean {
  const c = (code ?? "").trim();
  if (!POSTAL.has(c)) return false;
  return deptCode ? c.startsWith(deptCode) : true;
}

/** País de la tabla 16.4.1 por código alfa-2 (o null si no existe). */
export function findDianCountry(code: string | null | undefined): DianCountry | null {
  return COUNTRY_BY_CODE.get((code ?? "").trim().toUpperCase()) ?? null;
}
