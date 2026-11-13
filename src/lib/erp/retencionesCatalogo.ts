// Catálogo de conceptos de retención de Colombia para «Nuevo concepto»
// (Contabilidad › Impuestos › Retenciones). PURO y sin textos: los nombres
// y las notas de cada concepto viven en los catálogos de i18n
// (`opErp.retCat.<key>.name` / `.note`, en es/en/pt); aquí solo las cifras.
//
// ── Cómo actualizarlo cada año ───────────────────────────────────────────
//  1. Cambia RETENTION_CATALOG_YEAR y RETENTION_CATALOG_UVT_PESOS (la UVT
//     del año la fija una resolución de la DIAN a finales del año anterior).
//     Agrega también el año a UVT_POR_ANO en exogena/normativa.ts: el test
//     de este archivo exige que coincidan.
//  2. Revisa tarifas y bases contra el Decreto 1625 de 2016 (DUR) compilado
//     en el normograma de la DIAN y los decretos del año. Cita la norma en
//     `source` de cada concepto. Si una cifra no se confirma en una fuente
//     oficial, NO se agrega: el comercio puede crear el concepto a mano.
//  3. Los conceptos YA creados por los comercios no cambian solos: son una
//     copia que su contador edita.
//
// ── Fuentes oficiales (consultadas el 2026-11-13) ────────────────────────
//  · UVT 2026 = $52.374: Resolución DIAN 000238 de 2025, art. 1.
//    https://normograma.dian.gov.co/dian/compilacion/docs/resolucion_dian_0238_2025.htm
//  · DUR 1625 de 2016 (texto vigente, con el Decreto 572 de 2025):
//    https://normograma.dian.gov.co/dian/compilacion/docs/decreto_1625_2016.htm
//  · Decreto 572 de 2025 (bases: servicios 2 UVT, compras/otros ingresos
//    10 UVT, agrícolas 70 UVT). El Consejo de Estado lo suspendió el
//    7-may-2026 (DIAN, Comunicado 070 de 2026) y revocó la suspensión el
//    2-jun-2026 (Rad. 11001-03-27-000-2025-00055-00 (30229)); rige de nuevo
//    desde el 1-jul-2026 (DIAN, Concepto 017683 de 2026).
//    https://normograma.dian.gov.co/dian/compilacion/docs/decreto_0572_2025.htm
//    https://normograma.dian.gov.co/dian/compilacion/docs/oficio_dian_17683_2026.htm
//  · Arrendamiento de inmuebles, base 10 UVT: DIAN, Oficio 010721 de 2025.
//    https://normograma.dian.gov.co/dian/compilacion/docs/oficio_dian_10721_2025.htm
//  · Estatuto Tributario arts. 392, 401, 437-1, 462-1 (Secretaría del Senado).
//    http://www.secretariasenado.gov.co/senado/basedoc/estatuto_tributario.html
//
// FUERA del catálogo a propósito (crearlos como «Personalizado» con lo que
// diga el contador): arrendamiento de bienes muebles (4 %) y combustibles
// (0,1 %) — la tarifa está en el DUR (1.2.4.4.10 y 1.2.4.10.5) pero la base
// mínima no se pudo confirmar en una fuente oficial —, y las tarifas de
// reteICA por municipio y actividad (en Bogotá el Acuerdo 1084 de 2026
// cambió la tabla en octubre de 2026 y su base mínima no se confirmó en
// texto oficial): la reteICA del catálogo pide la tarifa por mil.

import type { RetentionKind } from "./retencionesCore";

/** Año gravable de las cifras del catálogo. */
export const RETENTION_CATALOG_YEAR = 2026;

/** UVT del año del catálogo, en pesos (Res. DIAN 000238 de 2025). */
export const RETENTION_CATALOG_UVT_PESOS = 52_374;

/** Partes por millón: 1 % = 10.000 ppm, 1 ‰ = 1.000 ppm. */
const PCT = 10_000;

export type RetentionCatalogEntry = {
  /** Clave estable: se guarda en `RetentionConcept.catalogKey`. */
  key: string;
  kind: RetentionKind;
  /** Tarifa en ppm; null = la pone el comercio (reteICA de su municipio). */
  ratePpm: number | null;
  base: "subtotal" | "tax";
  /** Base mínima en UVT (0 = desde el primer peso). */
  thresholdUvt: number;
  /** Cuenta PUC sugerida (Decreto 2650 de 1993). */
  accountCode: string;
  /**
   * Tema, para elegir la retefuente que le queda a una compra o un gasto
   * (`retentionTopic`): compras, servicios, honorarios, arrendamientos…
   */
  topic: RetentionTopic;
  /** ¿Tiene nota (`opErp.retCat.<key>.note`) que conviene leer antes? */
  hasNote: boolean;
  /** Norma que respalda la tarifa y la base (para el contador). */
  source: string;
};

export type RetentionTopic =
  | "compras"
  /** Servicios en general (la retefuente por defecto de un gasto). */
  | "servicios"
  /** Hoteles, restaurantes y hospedaje (3,5 %). */
  | "hoteles"
  /** Temporales, vigilancia y aseo (sobre el AIU). */
  | "servicios_aiu"
  | "honorarios"
  | "arrendamientos"
  | "transporte"
  | "agricolas"
  | "vehiculos"
  | "reteiva"
  | "reteica";

export const RETENTION_CATALOG: readonly RetentionCatalogEntry[] = [
  // ── Retención en la fuente (renta) ─────────────────────────────────────
  {
    key: "compras_declarante",
    kind: "retefuente",
    ratePpm: 2.5 * PCT,
    base: "subtotal",
    thresholdUvt: 10,
    accountCode: "236540",
    topic: "compras",
    hasNote: false,
    source: "DUR 1625/2016 arts. 1.2.4.9.1 (lit. i, D. 572/2025) y 1.2.4.9.2",
  },
  {
    key: "compras_no_declarante",
    kind: "retefuente",
    ratePpm: 3.5 * PCT,
    base: "subtotal",
    thresholdUvt: 10,
    accountCode: "236540",
    topic: "compras",
    hasNote: false,
    source: "DUR 1.2.4.9.2 par. 3; ET art. 401",
  },
  {
    key: "servicios_declarante",
    kind: "retefuente",
    ratePpm: 4 * PCT,
    base: "subtotal",
    thresholdUvt: 2,
    accountCode: "236525",
    topic: "servicios",
    hasNote: false,
    source: "DUR 1.2.4.4.14 y 1.2.4.4.1 (D. 572/2025)",
  },
  {
    key: "servicios_no_declarante",
    kind: "retefuente",
    ratePpm: 6 * PCT,
    base: "subtotal",
    thresholdUvt: 2,
    accountCode: "236525",
    topic: "servicios",
    hasNote: true,
    source: "ET art. 392 inc. 4; DUR 1.2.4.4.1 y 1.2.4.4.14",
  },
  {
    key: "honorarios_pj",
    kind: "retefuente",
    ratePpm: 11 * PCT,
    base: "subtotal",
    thresholdUvt: 0,
    accountCode: "236515",
    topic: "honorarios",
    hasNote: false,
    source: "DUR 1.2.4.3.1 inc. 1; ET art. 392",
  },
  {
    key: "honorarios_pn",
    kind: "retefuente",
    ratePpm: 10 * PCT,
    base: "subtotal",
    thresholdUvt: 0,
    accountCode: "236515",
    topic: "honorarios",
    hasNote: true,
    source: "DUR 1.2.4.3.1 inc. 2; ET art. 392",
  },
  {
    key: "arrendamiento_inmuebles",
    kind: "retefuente",
    ratePpm: 3.5 * PCT,
    base: "subtotal",
    thresholdUvt: 10,
    accountCode: "236530",
    topic: "arrendamientos",
    hasNote: false,
    source: "DUR 1.2.4.10.6 inc. 2; DIAN Oficio 010721/2025",
  },
  {
    key: "hoteles_restaurantes",
    kind: "retefuente",
    ratePpm: 3.5 * PCT,
    base: "subtotal",
    thresholdUvt: 2,
    accountCode: "236525",
    topic: "hoteles",
    hasNote: false,
    source: "DUR 1.2.4.10.6 inc. 1 (tarifa) y 1.2.4.4.1 (base de servicios)",
  },
  {
    key: "transporte_carga",
    kind: "retefuente",
    ratePpm: 1 * PCT,
    base: "subtotal",
    thresholdUvt: 2,
    accountCode: "236525",
    topic: "transporte",
    hasNote: false,
    source: "DUR 1.2.4.4.8 (tarifa) y 1.2.4.4.1 (base de servicios)",
  },
  {
    key: "transporte_pasajeros",
    kind: "retefuente",
    ratePpm: 3.5 * PCT,
    base: "subtotal",
    thresholdUvt: 10,
    accountCode: "236525",
    topic: "transporte",
    hasNote: false,
    source: "DUR 1.2.4.10.6 inc. 2 y 1.2.4.9.1 lit. i",
  },
  {
    key: "servicios_temporales",
    kind: "retefuente",
    ratePpm: 1 * PCT,
    base: "subtotal",
    thresholdUvt: 2,
    accountCode: "236525",
    topic: "servicios_aiu",
    hasNote: true,
    source: "DUR 1.2.4.4.10 inc. 1; ET art. 462-1",
  },
  {
    key: "vigilancia_aseo",
    kind: "retefuente",
    ratePpm: 2 * PCT,
    base: "subtotal",
    thresholdUvt: 2,
    accountCode: "236525",
    topic: "servicios_aiu",
    hasNote: true,
    source: "DUR 1.2.4.4.10 inc. 2; ET art. 462-1",
  },
  {
    key: "agricolas_sin_procesar",
    kind: "retefuente",
    ratePpm: 1.5 * PCT,
    base: "subtotal",
    thresholdUvt: 70,
    accountCode: "236540",
    topic: "agricolas",
    hasNote: true,
    source: "DUR 1.2.4.6.7 (D. 572/2025 art. 3)",
  },
  {
    key: "compra_vehiculos",
    kind: "retefuente",
    ratePpm: 1 * PCT,
    base: "subtotal",
    thresholdUvt: 10,
    accountCode: "236540",
    topic: "vehiculos",
    hasNote: true,
    source: "DUR 1.2.4.9.1 inc. 2 y lit. i",
  },
  // ── ReteIVA ────────────────────────────────────────────────────────────
  {
    key: "reteiva_compras",
    kind: "reteiva",
    ratePpm: 15 * PCT,
    base: "tax",
    thresholdUvt: 10,
    accountCode: "236705",
    topic: "reteiva",
    hasNote: false,
    source: "ET art. 437-1; DUR 1.3.2.1.6 y 1.3.2.1.12",
  },
  {
    key: "reteiva_servicios",
    kind: "reteiva",
    ratePpm: 15 * PCT,
    base: "tax",
    thresholdUvt: 2,
    accountCode: "236705",
    topic: "reteiva",
    hasNote: false,
    source: "ET art. 437-1; DUR 1.3.2.1.6 y 1.3.2.1.12",
  },
  // ── ReteICA ────────────────────────────────────────────────────────────
  {
    key: "reteica_municipio",
    kind: "reteica",
    ratePpm: null,
    base: "subtotal",
    thresholdUvt: 0,
    accountCode: "236805",
    topic: "reteica",
    hasNote: true,
    source: "Acuerdo de ICA del municipio (en Bogotá, Acuerdo 65 de 2002 y Acuerdo 1084 de 2026)",
  },
];

const BY_KEY = new Map(RETENTION_CATALOG.map((e) => [e.key, e]));

export function retentionCatalogEntry(key: string | null | undefined): RetentionCatalogEntry | null {
  return key ? (BY_KEY.get(key) ?? null) : null;
}

/** Cuenta «madre» de cada tipo: la cuenta de un concepto debe colgar de ella. */
export const RETENTION_ACCOUNT_PREFIX: Record<RetentionKind, string> = {
  retefuente: "2365",
  reteiva: "2367",
  reteica: "2368",
};

/**
 * Tema de un concepto para elegir la retefuente que le queda a una compra o
 * a un gasto: el del catálogo si nació de él; si no, por las palabras del
 * nombre (los conceptos sembrados antes del catálogo y los personalizados).
 */
export function retentionTopic(c: { name: string; catalogKey?: string | null }): RetentionTopic | null {
  const entry = retentionCatalogEntry(c.catalogKey);
  if (entry) return entry.topic;
  const n = c.name.toLowerCase();
  if (/(arrend|alquil)/.test(n)) return "arrendamientos";
  if (/honorar/.test(n)) return "honorarios";
  if (/compra/.test(n)) return "compras";
  if (/servici/.test(n)) return "servicios";
  if (/transport/.test(n)) return "transporte";
  return null;
}
