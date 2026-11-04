// Retenciones colombianas (retefuente / reteIVA / reteICA) — port del núcleo
// de zenith-erp adaptado a Prisma. Los CONCEPTOS viven por comercio
// (RetentionConcept): tarifa en basis points, base subtotal o impuesto y
// umbral en UVT. El cálculo es puro (retencionesCore.ts, lo usa también el
// cliente); la siembra y la config usan la BD.
import { db } from "@/lib/db";

export {
  UVT_DEFAULT_CENTS,
  computeRetentions,
  type RetentionConceptInput,
  type RetentionKind,
  type RetentionLine,
  type RetentionResult,
} from "./retencionesCore";
import type { RetentionConceptInput } from "./retencionesCore";

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
