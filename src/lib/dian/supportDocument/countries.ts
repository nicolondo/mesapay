// Tabla 16.4.1 «Países» del anexo técnico del documento soporte (código
// alfa-2 y "Nombre común", DSAJ16/DSAJ17). Módulo aparte del de códigos
// postales: el formulario del vendedor la usa en el navegador (~8 KB) sin
// arrastrar los 3.679 códigos postales.
import countries from "./data/countries.json";

export type DianCountry = { code: string; name: string };
export const DIAN_COUNTRIES: readonly DianCountry[] = countries as DianCountry[];
const COUNTRY_BY_CODE = new Map(DIAN_COUNTRIES.map((c) => [c.code, c]));

/** País de la tabla 16.4.1 por código alfa-2 (o null si no existe). */
export function findDianCountry(code: string | null | undefined): DianCountry | null {
  return COUNTRY_BY_CODE.get((code ?? "").trim().toUpperCase()) ?? null;
}
