// Retenciones colombianas (retefuente / reteIVA / reteICA) — port del núcleo
// de zenith-erp adaptado a Prisma. Los CONCEPTOS viven por comercio
// (RetentionConcept): tarifa en basis points, base subtotal o impuesto y
// umbral en UVT. El cálculo es puro; la siembra y la config usan la BD.
import { db } from "@/lib/db";

/** UVT 2026 = $52.374 (Res. DIAN 000238/2025), en centavos. */
export const UVT_DEFAULT_CENTS = 5_237_400;

export type RetentionKind = "retefuente" | "reteiva" | "reteica";

export type RetentionConceptInput = {
  id: string;
  kind: RetentionKind | string;
  name: string;
  rateBps: number;
  base: "subtotal" | "tax" | string;
  thresholdUvt: number;
  accountCode: string;
};

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
 * Set estándar sembrado INACTIVO — el contador activa lo que aplique al
 * régimen del comercio (la mayoría de restaurantes pequeños no son agentes
 * retenedores). Tarifas y umbrales 2026 de referencia, editables.
 */
export const DEFAULT_RETENTION_CONCEPTS: Omit<RetentionConceptInput, "id">[] = [
  {
    kind: "retefuente",
    name: "Compras (2,5%) — umbral 27 UVT",
    rateBps: 250,
    base: "subtotal",
    thresholdUvt: 27,
    accountCode: "236505",
  },
  {
    kind: "retefuente",
    name: "Servicios (4%) — umbral 4 UVT",
    rateBps: 400,
    base: "subtotal",
    thresholdUvt: 4,
    accountCode: "236505",
  },
  {
    kind: "retefuente",
    name: "Arrendamientos (3,5%)",
    rateBps: 350,
    base: "subtotal",
    thresholdUvt: 27,
    accountCode: "236505",
  },
  {
    kind: "reteiva",
    name: "ReteIVA (15% del IVA)",
    rateBps: 1500,
    base: "tax",
    thresholdUvt: 27,
    accountCode: "236705",
  },
  {
    kind: "reteica",
    name: "ReteICA (7×1.000)",
    rateBps: 70,
    base: "subtotal",
    thresholdUvt: 0,
    accountCode: "236805",
  },
];

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

/** Conceptos del comercio, sembrando el set estándar la primera vez. */
export async function loadRetentionConcepts(restaurantId: string) {
  const count = await db.retentionConcept.count({ where: { restaurantId } });
  if (count === 0) {
    await db.retentionConcept.createMany({
      data: DEFAULT_RETENTION_CONCEPTS.map((c) => ({ restaurantId, ...c })),
    });
  }
  return db.retentionConcept.findMany({
    where: { restaurantId },
    orderBy: [{ kind: "asc" }, { name: "asc" }],
  });
}
