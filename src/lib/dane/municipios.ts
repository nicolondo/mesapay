import raw from "./municipios.json";

/**
 * Catálogo DIVIPOLA (DANE) de municipios de Colombia.
 *
 * POR QUÉ: la factura electrónica declara la ubicación del
 * establecimiento con el código DANE del municipio (5 dígitos) y del
 * departamento (2 dígitos). La DIAN resuelve el punto de facturación a
 * partir de ahí, así que un código equivocado no es un detalle
 * cosmético: la factura se rechaza (FAB10a / FAJ50). Por eso la ciudad
 * de los datos legales se elige de este catálogo y no se escribe a mano.
 *
 * El JSON lo genera `scripts/generate-dane-municipios.mjs` desde el
 * dataset oficial del DANE en datos.gov.co (`gdxc-w37w`, DIVIPOLA a
 * corte 30-dic-2024). No editar a mano: correr el script.
 *
 * Este módulo es puro (sin DB, sin red) para poder testearlo. El
 * catálogo son ~100 KB; se consulta SIEMPRE desde el server (ver
 * /api/operator/dane/municipios) para no mandárselo al navegador.
 */
export type DaneMunicipio = {
  /** Código DANE del municipio, 5 dígitos, con ceros a la izquierda. */
  code: string;
  /** Nombre oficial DANE ("Santiago de Cali", "Bogotá, D.C."). */
  name: string;
  /** Código DANE del departamento, 2 dígitos. Siempre prefijo de `code`. */
  deptCode: string;
  deptName: string;
};

export const DANE_MUNICIPIOS: readonly DaneMunicipio[] =
  raw as readonly DaneMunicipio[];

/**
 * Normaliza para comparar: minúsculas y sin tildes. Mismo criterio que
 * los otros buscadores del repo (insumos, proveedores, compras…), así
 * "Bogota" encuentra "Bogotá" y "MEDELLIN" encuentra "Medellín".
 */
export function fold(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
}

/** Índice de búsqueda precomputado (se arma una vez por proceso). */
type Indexed = DaneMunicipio & { fName: string; fFull: string };
const INDEX: Indexed[] = DANE_MUNICIPIOS.map((m) => ({
  ...m,
  fName: fold(m.name),
  // "envigado, antioquia" — permite escribir municipio + departamento
  // para desambiguar los repetidos (hay 5 "San Juan", 3 "Providencia"…).
  fFull: fold(`${m.name}, ${m.deptName}`),
}));

const BY_CODE = new Map(INDEX.map((m) => [m.code, m]));

/** Devuelve el municipio con ese código DANE, o null si no existe. */
export function findMunicipioByCode(
  code: string | null | undefined,
): DaneMunicipio | null {
  if (!code) return null;
  return BY_CODE.get(code.trim()) ?? null;
}

/** ¿Es un código de municipio válido del catálogo? */
export function isValidMunicipioCode(code: string): boolean {
  return BY_CODE.has(code.trim());
}

/**
 * Busca municipios por nombre (o por departamento, o por código).
 * Ordena por qué tan "al principio" pega la consulta para que lo que
 * el operador está escribiendo aparezca primero: "med" → Medellín antes
 * que "San Pedro de los Milagros".
 */
export function searchMunicipios(query: string, limit = 8): DaneMunicipio[] {
  const q = fold(query.trim());
  if (q.length < 2) return [];

  // Si escribieron dígitos, buscamos por código DANE directo.
  if (/^\d+$/.test(q)) {
    return INDEX.filter((m) => m.code.startsWith(q))
      .slice(0, limit)
      .map(strip);
  }

  const hits: { m: Indexed; rank: number }[] = [];
  for (const m of INDEX) {
    let rank: number;
    if (m.fName === q) rank = 0;
    else if (m.fName.startsWith(q)) rank = 1;
    // Palabra interna que arranca con la consulta: "cali" → "Santiago
    // de Cali", que es como el DANE nombra a Cali.
    else if (m.fName.includes(` ${q}`)) rank = 2;
    else if (m.fName.includes(q)) rank = 3;
    else if (m.fFull.includes(q)) rank = 4;
    else continue;
    hits.push({ m, rank });
  }
  hits.sort(
    (a, b) => a.rank - b.rank || a.m.fName.localeCompare(b.m.fName, "es"),
  );
  return hits.slice(0, limit).map((h) => strip(h.m));
}

function strip(m: Indexed | DaneMunicipio): DaneMunicipio {
  return {
    code: m.code,
    name: m.name,
    deptCode: m.deptCode,
    deptName: m.deptName,
  };
}

/**
 * Etiqueta para mostrar: "Envigado, Antioquia". Bogotá queda
 * "Bogotá, D.C." a secas porque municipio y departamento son lo mismo.
 */
export function municipioLabel(m: DaneMunicipio): string {
  return m.name === m.deptName ? m.name : `${m.name}, ${m.deptName}`;
}

/**
 * SUGERENCIA para comercios viejos que tienen `legalCity` en texto
 * libre y ningún código.
 *
 * Devuelve un candidato SOLO si el texto coincide de forma exacta (ya
 * normalizada) con un único municipio. Deliberadamente NO hace match
 * difuso: si "San Juan" pega con cinco municipios, o si el texto dice
 * "Bogota DC" con basura alrededor, preferimos no sugerir nada a
 * sugerir mal. Y lo que devuelve es una SUGERENCIA: la UI la muestra
 * para que el operador la confirme; nunca se guarda sola. Un código
 * adivinado manda las facturas al municipio equivocado, que es
 * exactamente el bug que este catálogo viene a cerrar.
 */
export function suggestMunicipioFromText(
  text: string | null | undefined,
): DaneMunicipio | null {
  if (!text) return null;
  const q = fold(text.trim());
  if (q.length < 3) return null;
  const exact = INDEX.filter((m) => m.fName === q || m.fFull === q);
  if (exact.length === 1) return strip(exact[0]);
  // "Bogotá" / "Bogota D.C." / "Bogotá D.C." son el mismo lugar y es el
  // texto libre más frecuente en la base; lo resolvemos sin ambigüedad.
  if (/^bogota(,?\s*d\.?\s*c\.?)?$/.test(q)) {
    return findMunicipioByCode("11001");
  }
  return null;
}
