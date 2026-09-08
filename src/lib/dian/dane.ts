// Códigos DANE (DIVIPOLA) del establecimiento, para el bloque de dirección
// del EMISOR en el XML UBL.
//
// PORQUÉ EXISTE ESTE ARCHIVO
// --------------------------
// El emisor mandaba `cityCode: "11001"` / `deptCode: "11"` fijos (Bogotá
// D.C.) para TODOS los comercios. Son & Melona está en Envigado, Antioquia
// (05266 / 05) y su factura igual declaraba Bogotá. La DIAN resuelve el
// punto de facturación por la ubicación del establecimiento, así que ese
// dato fijo es candidato directo a las reglas FAB10a y FAJ50 ("el prefijo
// de numeración no es igual al código de la sucursal correspondiente a
// este punto de facturación").
//
// FUENTE Y ALCANCE
// ----------------
// La codificación es DIVIPOLA (DANE): 2 dígitos de departamento + 3 de
// municipio. El código de municipio SIEMPRE empieza por el de su
// departamento, así que el departamento se DERIVA del municipio y no hay
// forma de que queden inconsistentes.
//
// - `DANE_DEPARTMENTS` es la lista COMPLETA y cerrada: 32 departamentos +
//   Bogotá D.C. Nunca crece. Es lo que valida que un código sea real.
// - `DANE_CITIES` es una lista ACOTADA de conveniencia para el selector:
//   las 32 capitales (en DIVIPOLA la capital siempre lleva el sufijo 001,
//   salvo Cundinamarca cuya capital es Bogotá y vive en el departamento
//   11), los 10 municipios del Valle de Aburrá y un puñado de municipios
//   grandes. NO pretende ser el censo de los 1.100+ municipios: es un
//   atajo. Cualquier comercio fuera de la lista carga su código de 5
//   dígitos a mano y se valida igual contra `DANE_DEPARTMENTS`.
//
// El operador NO tiene que adivinar el código: está impreso en su RUT
// (casilla Ciudad/Municipio) y en la resolución de numeración.

/** Departamentos DIVIPOLA — lista completa y cerrada (32 + Bogotá D.C.). */
export const DANE_DEPARTMENTS: Record<string, string> = {
  "05": "Antioquia",
  "08": "Atlántico",
  "11": "Bogotá, D.C.",
  "13": "Bolívar",
  "15": "Boyacá",
  "17": "Caldas",
  "18": "Caquetá",
  "19": "Cauca",
  "20": "Cesar",
  "23": "Córdoba",
  "25": "Cundinamarca",
  "27": "Chocó",
  "41": "Huila",
  "44": "La Guajira",
  "47": "Magdalena",
  "50": "Meta",
  "52": "Nariño",
  "54": "Norte de Santander",
  "63": "Quindío",
  "66": "Risaralda",
  "68": "Santander",
  "70": "Sucre",
  "73": "Tolima",
  "76": "Valle del Cauca",
  "81": "Arauca",
  "85": "Casanare",
  "86": "Putumayo",
  "88": "Archipiélago de San Andrés, Providencia y Santa Catalina",
  "91": "Amazonas",
  "94": "Guainía",
  "95": "Guaviare",
  "97": "Vaupés",
  "99": "Vichada",
};

export type DaneCity = { code: string; name: string };

/**
 * Municipios de conveniencia para el selector. Acotada a propósito (ver
 * cabecera): capitales + Valle de Aburrá + municipios grandes. El campo
 * libre de 5 dígitos cubre todo lo demás.
 */
export const DANE_CITIES: DaneCity[] = [
  // Capitales de departamento (sufijo 001 en DIVIPOLA).
  { code: "05001", name: "Medellín" },
  { code: "08001", name: "Barranquilla" },
  { code: "11001", name: "Bogotá, D.C." },
  { code: "13001", name: "Cartagena de Indias" },
  { code: "15001", name: "Tunja" },
  { code: "17001", name: "Manizales" },
  { code: "18001", name: "Florencia" },
  { code: "19001", name: "Popayán" },
  { code: "20001", name: "Valledupar" },
  { code: "23001", name: "Montería" },
  { code: "27001", name: "Quibdó" },
  { code: "41001", name: "Neiva" },
  { code: "44001", name: "Riohacha" },
  { code: "47001", name: "Santa Marta" },
  { code: "50001", name: "Villavicencio" },
  { code: "52001", name: "Pasto" },
  { code: "54001", name: "Cúcuta" },
  { code: "63001", name: "Armenia" },
  { code: "66001", name: "Pereira" },
  { code: "68001", name: "Bucaramanga" },
  { code: "70001", name: "Sincelejo" },
  { code: "73001", name: "Ibagué" },
  { code: "76001", name: "Cali" },
  { code: "81001", name: "Arauca" },
  { code: "85001", name: "Yopal" },
  { code: "86001", name: "Mocoa" },
  { code: "88001", name: "San Andrés" },
  { code: "91001", name: "Leticia" },
  { code: "94001", name: "Inírida" },
  { code: "95001", name: "San José del Guaviare" },
  { code: "97001", name: "Mitú" },
  { code: "99001", name: "Puerto Carreño" },
  // Valle de Aburrá (Antioquia) — donde está la mayor parte del portafolio.
  { code: "05079", name: "Barbosa" },
  { code: "05088", name: "Bello" },
  { code: "05129", name: "Caldas" },
  { code: "05212", name: "Copacabana" },
  { code: "05266", name: "Envigado" },
  { code: "05308", name: "Girardota" },
  { code: "05360", name: "Itagüí" },
  { code: "05380", name: "La Estrella" },
  { code: "05631", name: "Sabaneta" },
  // Otros municipios grandes.
  { code: "05615", name: "Rionegro" },
  { code: "08758", name: "Soledad" },
  { code: "25754", name: "Soacha" },
  { code: "66170", name: "Dosquebradas" },
  { code: "68276", name: "Floridablanca" },
  { code: "76520", name: "Palmira" },
];

const CITY_BY_CODE = new Map(DANE_CITIES.map((c) => [c.code, c.name]));

/** Ubicación resuelta, tal como la espera `DianParty["address"]`. */
export type DaneLocation = {
  cityCode: string;
  cityName: string;
  deptCode: string;
  deptName: string;
};

/** ¿El código tiene forma DIVIPOLA y un departamento que existe? */
export function isValidDaneCode(code: string | null | undefined): boolean {
  if (!code || !/^\d{5}$/.test(code)) return false;
  return code.slice(0, 2) in DANE_DEPARTMENTS;
}

/**
 * Resuelve un código DIVIPOLA a la cuaterna que va al XML. Devuelve null
 * si el código no es válido — el caller NO debe enviar en ese caso, porque
 * inventar una ubicación es exactamente el bug que estamos arreglando.
 *
 * `fallbackCityName` es el texto libre que el comercio ya cargó
 * (`legalCity`): se usa como nombre visible cuando el municipio no está en
 * la lista acotada. El nombre es cosmético; lo que la DIAN contrasta es el
 * código.
 */
export function resolveDaneLocation(
  code: string | null | undefined,
  fallbackCityName?: string | null,
): DaneLocation | null {
  if (!isValidDaneCode(code)) return null;
  const cityCode = code!;
  const deptCode = cityCode.slice(0, 2);
  const known = CITY_BY_CODE.get(cityCode);
  const cityName = known ?? fallbackCityName?.trim();
  if (!cityName) return null;
  return {
    cityCode,
    cityName,
    deptCode,
    deptName: DANE_DEPARTMENTS[deptCode],
  };
}
