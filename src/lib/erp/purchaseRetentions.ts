// Retenciones de una compra MANUAL (la factura del proveedor al recibir la
// mercancía) — LÓGICA PURA, sin BD. La importan el formulario (sugerencia y
// resumen en vivo) y el servidor (validación antes de guardar).
//
// Regla de las compras recibidas por partes: las retenciones se practican en
// CADA recepción, sobre lo que llega en ella (es la factura de esa entrega):
//  · base de retefuente y reteICA = neto recibido después de descuentos, SIN
//    IVA ni impuesto al consumo; base de reteIVA = el IVA de la entrega;
//  · el umbral en UVT de cada concepto se mide contra la base de la entrega;
//  · lo practicado se SUMA a las retenciones de la compra
//    (`PurchaseOrder.retefuenteCents`…, y `receptionRetentionCents`), que es
//    lo que ya leen el asiento «Compras del día» (2365/2367/2368), la exógena
//    y los impuestos del período, y cuenta completo en la cuenta por pagar
//    desde esa entrega.
// Es el mismo motor de conceptos del resto del ERP (`computeRetentions`).
import { computeRetentions, type RetentionConceptInput } from "./retencionesCore";

export const PURCHASE_RETENTION_KINDS = ["retefuente", "reteiva", "reteica"] as const;
export type PurchaseRetentionKind = (typeof PURCHASE_RETENTION_KINDS)[number];

export function isPurchaseRetentionKind(v: unknown): v is PurchaseRetentionKind {
  return typeof v === "string" && (PURCHASE_RETENTION_KINDS as readonly string[]).includes(v);
}

/** Base de la factura (o de la entrega) sobre la que se retiene. */
export type RetentionDoc = {
  /** Neto después de descuentos, sin IVA ni consumo. */
  baseCents: number;
  ivaCents: number;
  incCents: number;
};

export type PurchaseRetentionTotals = {
  retefuenteCents: number;
  reteIvaCents: number;
  reteIcaCents: number;
};

/** Una retención sugerida, con lo que la pantalla necesita para mostrarla. */
export type SuggestedPurchaseRetention = {
  conceptId: string;
  kind: PurchaseRetentionKind;
  name: string;
  rateBps: number;
  base: "subtotal" | "tax";
  baseCents: number;
  amountCents: number;
};

/**
 * El concepto de RETEFUENTE de una compra de insumos: el de «compras» si el
 * comercio lo tiene activo; si no, el primero activo. A una factura se le
 * aplica UNO (no «compras» y «servicios» a la vez, aunque los dos estén
 * activos para los gastos).
 */
export function pickPurchaseRetefuenteConcept<T extends Pick<RetentionConceptInput, "kind" | "name">>(
  concepts: readonly T[],
): T | null {
  const candidates = concepts.filter((c) => c.kind === "retefuente");
  return candidates.find((c) => /compra/i.test(c.name)) ?? candidates[0] ?? null;
}

/** Base de un concepto: el IVA (reteIVA) o la base neta de la factura. */
export function retentionConceptBaseCents(concept: Pick<RetentionConceptInput, "base">, doc: Pick<RetentionDoc, "baseCents" | "ivaCents">): number {
  return concept.base === "tax" ? doc.ivaCents : doc.baseCents;
}

/** Monto con la tarifa del concepto (sin umbral): lo que se recalcula al editar la base. */
export function retentionAmountForRate(rateBps: number, baseCents: number): number {
  if (!(baseCents > 0) || !(rateBps > 0)) return 0;
  return Math.round((baseCents * rateBps) / 10_000);
}

/**
 * Retenciones SUGERIDAS para la factura con los conceptos ACTIVOS del
 * comercio y el umbral en UVT: una retefuente (la de compras), la reteIVA y
 * la reteICA activas. Sin conceptos activos (el comercio no es agente
 * retenedor) no sugiere nada.
 */
export function suggestPurchaseRetentions<T extends RetentionConceptInput & { active?: boolean }>(
  concepts: readonly T[],
  doc: Pick<RetentionDoc, "baseCents" | "ivaCents">,
  uvtCents: number,
): SuggestedPurchaseRetention[] {
  const active = concepts.filter((c) => c.active !== false && isPurchaseRetentionKind(c.kind));
  const picked: T[] = [];
  const retefuente = pickPurchaseRetefuenteConcept(active);
  if (retefuente) picked.push(retefuente);
  for (const kind of ["reteiva", "reteica"] as const) {
    const c = active.find((x) => x.kind === kind);
    if (c) picked.push(c);
  }
  const result = computeRetentions(picked, { subtotalCents: doc.baseCents, taxCents: doc.ivaCents }, uvtCents);
  const byId = new Map(picked.map((c) => [c.id, c]));
  return result.lines.map((l) => {
    const c = byId.get(l.conceptId)!;
    return {
      conceptId: c.id,
      kind: c.kind as PurchaseRetentionKind,
      name: c.name,
      rateBps: c.rateBps,
      base: c.base === "tax" ? "tax" : "subtotal",
      baseCents: retentionConceptBaseCents(c, doc),
      amountCents: l.amountCents,
    };
  });
}

/** Suma por tipo de las retenciones de la factura (las tres columnas de la compra). */
export function purchaseRetentionTotals(lines: readonly { kind: string; amountCents: number }[]): PurchaseRetentionTotals {
  const out: PurchaseRetentionTotals = { retefuenteCents: 0, reteIvaCents: 0, reteIcaCents: 0 };
  for (const l of lines) {
    const amount = Number.isFinite(l.amountCents) && l.amountCents > 0 ? Math.round(l.amountCents) : 0;
    if (l.kind === "reteiva") out.reteIvaCents += amount;
    else if (l.kind === "reteica") out.reteIcaCents += amount;
    else out.retefuenteCents += amount;
  }
  return out;
}

export function retentionTotalCents(r: PurchaseRetentionTotals): number {
  return r.retefuenteCents + r.reteIvaCents + r.reteIcaCents;
}

export type PurchaseRetentionError = "retention_exceeds_base" | "retention_exceeds_total";

/**
 * Reglas de las retenciones de una factura de compra:
 *  · retefuente y reteICA, cada una ≤ la base neta; reteIVA ≤ el IVA;
 *  · entre todas, no más que el total de la factura (base + IVA + consumo):
 *    la cuenta por pagar nunca queda negativa.
 * Montos negativos o no enteros ya los rechaza el esquema del API.
 */
export function purchaseRetentionError(r: PurchaseRetentionTotals, doc: RetentionDoc): PurchaseRetentionError | null {
  if (r.retefuenteCents > doc.baseCents || r.reteIcaCents > doc.baseCents || r.reteIvaCents > doc.ivaCents) {
    return "retention_exceeds_base";
  }
  if (retentionTotalCents(r) > doc.baseCents + doc.ivaCents + doc.incCents) return "retention_exceeds_total";
  return null;
}

/**
 * Total a pagar de la factura: base + IVA + consumo − retenciones (el
 * descuento ya está dentro de la base). El mismo de la revisión con IA.
 */
export function purchasePayableCents(doc: RetentionDoc, r: PurchaseRetentionTotals): number {
  return doc.baseCents + doc.ivaCents + doc.incCents - retentionTotalCents(r);
}
