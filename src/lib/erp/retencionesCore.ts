// Motor PURO de retenciones (retefuente / reteIVA / reteICA): sin BD, así
// lo importan el server (compras, gastos, cron de recurrentes) y el
// formulario de gastos en el cliente — la sugerencia en pantalla y la que
// recalcula el servidor salen de la MISMA función. La siembra y la
// configuración (que sí usan la BD) viven en retenciones.ts.

/** UVT 2026 = $52.374 (Res. DIAN 000238/2025), en centavos. */
export const UVT_DEFAULT_CENTS = 5_237_400;

export type RetentionKind = "retefuente" | "reteiva" | "reteica";

export type RetentionConceptInput = {
  id: string;
  kind: RetentionKind | string;
  name: string;
  /**
   * Tarifa EFECTIVA en basis points; puede tener decimales (reteICA
   * 4,14 ‰ = 41,4 bps). La de la BD pasa por `conceptRateBps`.
   */
  rateBps: number;
  base: "subtotal" | "tax" | string;
  thresholdUvt: number;
  accountCode: string;
  /** Clave del catálogo de donde nació (elige la retefuente por tema). */
  catalogKey?: string | null;
};

export const RETENTION_KINDS = ["retefuente", "reteiva", "reteica"] as const;

export function isRetentionKind(v: unknown): v is RetentionKind {
  return typeof v === "string" && (RETENTION_KINDS as readonly string[]).includes(v);
}

// ── Tarifa: basis points (columna vieja) y partes por millón (exacta) ─────

/** Partes por millón en 1 %: la tarifa 1 % = 10.000 ppm; 1 ‰ = 1.000 ppm. */
export const PPM_PER_PCT = 10_000;
/** Tope de una tarifa: 100 % (la reteIVA puede ser el 100 % del IVA). */
export const MAX_RATE_PPM = 1_000_000;

/**
 * Tarifa efectiva en bps de una fila de la BD: `ratePpm` (exacta) si la
 * tiene; si no, `rateBps` (conceptos y fotos anteriores a la columna).
 */
export function conceptRateBps(c: { rateBps: number; ratePpm?: number | null }): number {
  return c.ratePpm != null ? c.ratePpm / 100 : c.rateBps;
}

/** Tarifa exacta en ppm de una fila de la BD. */
export function conceptRatePpm(c: { rateBps: number; ratePpm?: number | null }): number {
  return c.ratePpm != null ? c.ratePpm : Math.round(c.rateBps * 100);
}

/**
 * Columnas a guardar para una tarifa: la exacta (`ratePpm`) y `rateBps`
 * redondeado, que es lo que lee la versión anterior del código.
 */
export function rateColumns(ratePpm: number): { rateBps: number; ratePpm: number } {
  return { rateBps: Math.round(ratePpm / 100), ratePpm };
}

/**
 * La tarifa como la escribe la persona → ppm. `unit` "pct" (1 = 1 %) o
 * "permil" (4,14 = 4,14 ‰, la reteICA). Acepta coma o punto decimal; más
 * de un separador, letras, cero o más de 100 % → null. Precisión: 1 ppm
 * (0,0001 % o 0,001 ‰); más decimales → null (no se redondea a escondidas).
 */
export function parseRateToPpm(raw: string, unit: "pct" | "permil"): number | null {
  const s = raw.trim().replace(/\s/g, "").replace(",", ".");
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  const n = Number(s);
  const ppm = n * (unit === "pct" ? PPM_PER_PCT : 1_000);
  const rounded = Math.round(ppm);
  if (Math.abs(ppm - rounded) > 1e-6) return null;
  if (rounded <= 0 || rounded > MAX_RATE_PPM) return null;
  return rounded;
}

/** ppm → número en la unidad (sin formato): 25.000 ppm → 2,5 (%); 4.140 → 4,14 (‰). */
export function ppmToRate(ppm: number, unit: "pct" | "permil"): number {
  return ppm / (unit === "pct" ? PPM_PER_PCT : 1_000);
}

/** Base de cálculo de cada tipo: la reteIVA es un % del IVA; las demás, del subtotal. */
export function baseForKind(kind: string): "subtotal" | "tax" {
  return kind === "reteiva" ? "tax" : "subtotal";
}

/** La unidad con la que se escribe y se lee la tarifa de cada tipo. */
export function rateUnitFor(kind: string): "pct" | "permil" {
  return kind === "reteica" ? "permil" : "pct";
}

// ── Validación de un concepto (crear / editar) ───────────────────────────

/** Nombre comparable: sin mayúsculas, tildes ni espacios de más. */
export function normalizeConceptName(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

export const CONCEPT_NAME_MIN = 2;
export const CONCEPT_NAME_MAX = 120;
export const CONCEPT_THRESHOLD_MAX_UVT = 100_000;

export type ConceptFields = {
  kind: string;
  name: string;
  ratePpm: number;
  base: string;
  thresholdUvt: number;
  accountCode: string;
};

export type ConceptFieldError =
  | "kind_invalid"
  | "name_invalid"
  | "rate_invalid"
  | "base_invalid"
  | "threshold_invalid"
  | "account_invalid"
  | "name_taken";

/**
 * Reglas de un concepto, puras (el servidor las corre al crear y al editar;
 * el formulario, para avisar antes de enviar):
 *  · tipo retefuente / reteIVA / reteICA;
 *  · nombre de 2 a 120 caracteres, único por comercio y tipo (sin importar
 *    mayúsculas ni tildes);
 *  · tarifa > 0 y ≤ 100 %, en ppm enteros;
 *  · base: la del tipo (`baseForKind`: la reteIVA va sobre el IVA; la
 *    retefuente y la reteICA, sobre el subtotal);
 *  · umbral entero en UVT, de 0 a 100.000;
 *  · cuenta: una de `allowedAccounts` (las imputables del plan bajo
 *    2365 / 2367 / 2368 según el tipo).
 */
export function validateConceptFields(
  f: ConceptFields,
  ctx: {
    /** Conceptos del comercio (para el nombre único), sin el que se edita. */
    others: readonly { kind: string; name: string }[];
    allowedAccounts: readonly string[];
  },
): ConceptFieldError | null {
  if (!isRetentionKind(f.kind)) return "kind_invalid";
  const name = f.name.trim();
  if (name.length < CONCEPT_NAME_MIN || name.length > CONCEPT_NAME_MAX) return "name_invalid";
  if (!Number.isInteger(f.ratePpm) || f.ratePpm <= 0 || f.ratePpm > MAX_RATE_PPM) return "rate_invalid";
  if (f.base !== baseForKind(f.kind)) return "base_invalid";
  if (!Number.isInteger(f.thresholdUvt) || f.thresholdUvt < 0 || f.thresholdUvt > CONCEPT_THRESHOLD_MAX_UVT) {
    return "threshold_invalid";
  }
  if (!ctx.allowedAccounts.includes(f.accountCode)) return "account_invalid";
  const key = normalizeConceptName(name);
  if (ctx.others.some((o) => o.kind === f.kind && normalizeConceptName(o.name) === key)) return "name_taken";
  return null;
}

export type RetentionLine = {
  conceptId: string;
  kind: string;
  name: string;
  accountCode: string;
  amountCents: number;
};

export type RetentionResult = {
  lines: RetentionLine[];
  /** Totales mapeados a los campos que ya llevan las compras de MESAPAY. */
  retefuenteCents: number;
  reteIvaCents: number;
  reteIcaCents: number;
  totalCents: number;
};

/**
 * Retenciones de un documento de COMPRA según los conceptos ACTIVOS: por
 * concepto, la base es el subtotal o el impuesto; si la base alcanza el
 * umbral (thresholdUvt × uvtCents; 0 = siempre), retiene rateBps/10000 de
 * la base, redondeado al centavo. Puro — testeable sin BD.
 */
export function computeRetentions(
  concepts: RetentionConceptInput[],
  doc: { subtotalCents: number; taxCents: number },
  uvtCents: number,
): RetentionResult {
  const lines: RetentionLine[] = [];
  let retefuente = 0;
  let reteIva = 0;
  let reteIca = 0;
  for (const c of concepts) {
    const baseCents = c.base === "tax" ? doc.taxCents : doc.subtotalCents;
    if (baseCents <= 0) continue;
    const thresholdCents = c.thresholdUvt * uvtCents;
    if (thresholdCents > 0 && doc.subtotalCents < thresholdCents) continue;
    const amountCents = Math.round((baseCents * c.rateBps) / 10_000);
    if (amountCents <= 0) continue;
    lines.push({
      conceptId: c.id,
      kind: c.kind,
      name: c.name,
      accountCode: c.accountCode,
      amountCents,
    });
    if (c.kind === "reteiva") reteIva += amountCents;
    else if (c.kind === "reteica") reteIca += amountCents;
    else retefuente += amountCents;
  }
  return {
    lines,
    retefuenteCents: retefuente,
    reteIvaCents: reteIva,
    reteIcaCents: reteIca,
    totalCents: retefuente + reteIva + reteIca,
  };
}
