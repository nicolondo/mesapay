/**
 * IMPUESTOS DEL PERÍODO — impuestos DOCUMENTALES (lógica pura). Portado
 * de zenith `reportes/impuestos/impuestos-documentos.ts`, adaptado a lo
 * que MESAPAY congela en sus documentos:
 *
 *  · VENTAS: cada `SimpleInvoice` congela en su snapshot la tarifa del
 *    comercio al emitir (`frozenSalesTax`) y el impuesto embebido de los
 *    platos (`embeddedTaxCents` / `embeddedBaseCents`). Es la MISMA cifra
 *    que declara el XML a la DIAN y que asienta el motor (`posting.ts`,
 *    vía `computeTaxSummary`): se agrupa por `kind:tarifa`.
 *  · COMPRAS: IVA por línea recibida (`taxPct` × neto recibido, como
 *    `computeTaxSummary`), agrupado por tarifa; INC de cabecera sin
 *    tarifa; retenciones practicadas de cabecera por concepto
 *    (retefuente / reteIVA / reteICA).
 *  · NOTAS CRÉDITO: las notas electrónicas ACEPTADAS por la DIAN con
 *    fecha fiscal en el período restan del tramo de cada línea lo que
 *    declararon (base e impuesto por tarifa, de su snapshot). El tramo
 *    guarda aparte cuánto restaron, así el contador ve bruto, notas y neto.
 *  · DEVOLUCIONES: los reembolsos de la pasarela SIN nota crédito no
 *    tienen documento que los congele; el motor les calcula el impuesto
 *    embebido con el tramo dominante del período (`posting.ts`, asiento
 *    `refund`). Acá se hace lo mismo y se restan del tramo. Un reembolso
 *    ligado a una nota (antes o después de ella) ya lo resta la nota: no
 *    entra en `refundsCents` (ver `creditNoteAccounting.loadUnlinkedRefundsCents`).
 *
 * Todo en centavos enteros: no hay redondeo intermedio.
 */
import { embeddedTaxCents } from "../accounting";

export type SalesTaxKind = "none" | "inc" | "iva";

export type SaleTaxInput = {
  invoiceId: string;
  /** Número legal del documento (prefijo + consecutivo, como en la DIAN). */
  document: string;
  /** Instante de pago de la cuenta, ISO (UTC). */
  dateIso: string;
  taxKind: SalesTaxKind;
  taxPct: number;
  /** Base gravable congelada (bruto de los platos − impuesto embebido). */
  baseCents: number;
  /** Impuesto embebido congelado. */
  taxCents: number;
  /** Adquiriente si la factura es NOMINATIVA; null = consumidor final. */
  customer: { name: string; docType: string; docNumber: string } | null;
};

export type PurchaseTaxInput = {
  purchaseId: string;
  /** Factura del proveedor si se capturó; si no, el consecutivo de la OC. */
  document: string;
  /** Recepción completa de la compra, ISO (UTC). */
  dateIso: string;
  supplierName: string;
  supplierTaxId: string | null;
  lines: {
    /** Neto recibido de la línea (sin IVA). */
    netCents: number;
    taxPct: number;
    /** Parte del IVA de la línea que NO es descontable (gasto). */
    nonDeductibleTaxCents: number;
  }[];
  incCents: number;
  retefuenteCents: number;
  reteIvaCents: number;
  reteIcaCents: number;
};

export type CurrentSalesTax = { kind: SalesTaxKind; pct: number };

/** Una nota crédito aceptada, con fecha fiscal en el período. */
export type CreditNoteTaxInput = {
  creditNoteId: string;
  /** Número de la nota (prefijo + consecutivo, «NC12»). */
  document: string;
  /** Número de la factura que ajusta («FE345»). */
  reference: string;
  /** Fecha fiscal (día colombiano) como ISO al mediodía UTC: su día UTC es el fiscal. */
  dateIso: string;
  /** Adquiriente de la factura original; null = consumidor final. */
  customer: { name: string; docType: string; docNumber: string } | null;
  /** Tramos de la nota (base e impuesto por tarifa, POSITIVOS). */
  slices: { kind: SalesTaxKind; pct: number; baseCents: number; taxCents: number }[];
};

export type DocTaxKind = "iva" | "inc" | "retefuente" | "reteiva" | "reteica";

export type TaxBucket = {
  /** `${kind}:${pct ?? "-"}`. */
  key: string;
  kind: DocTaxKind;
  /** null = el documento no discrimina tarifa (INC de cabecera, retenciones). */
  pct: number | null;
  /** Base NETA de devoluciones y notas crédito. */
  baseCents: number;
  /** Impuesto NETO de devoluciones y notas crédito. */
  taxCents: number;
  refundBaseCents: number;
  refundTaxCents: number;
  /** Lo que restaron las notas crédito del período (positivo). */
  creditNoteBaseCents: number;
  creditNoteTaxCents: number;
};

export type DocumentTaxTotals = {
  /** Σ impuesto generado en ventas (IVA + INC), neto de devoluciones. */
  generadosCents: number;
  ivaGeneradoCents: number;
  incGeneradoCents: number;
  /** IVA registrado en compras (todas las líneas). */
  ivaComprasCents: number;
  /** Parte del IVA de compras que NO es descontable. */
  ivaNoDescontableCents: number;
  /** IVA de compras que el motor lleva al descontable (24081001). */
  ivaDescontableCents: number;
  incComprasCents: number;
  retefuenteCents: number;
  reteIvaCents: number;
  reteIcaCents: number;
  refundsCents: number;
  refundTaxCents: number;
  /** Σ total (base + impuesto) de las notas crédito del período. */
  creditNotesCents: number;
  /** Σ impuesto (IVA + INC) que restaron las notas crédito. */
  creditNoteTaxCents: number;
};

export type DocumentTaxes = {
  sales: TaxBucket[];
  purchases: TaxBucket[];
  retentions: TaxBucket[];
  totals: DocumentTaxTotals;
  /** IVA generado en ventas − IVA registrado en compras (referencia, no la declaración). */
  ivaDiferenciaDocumentalCents: number;
};

/** IVA de una línea de compra, igual que `purchaseTax.lineTaxCents`. */
export function purchaseLineTaxCents(netCents: number, taxPct: number): number {
  if (!(taxPct > 0)) return 0;
  return Math.round((netCents * taxPct) / 100);
}

const KIND_ORDER: Record<DocTaxKind, number> = {
  iva: 0,
  inc: 1,
  retefuente: 2,
  reteiva: 3,
  reteica: 4,
};

function bucketKey(kind: DocTaxKind, pct: number | null): string {
  return `${kind}:${pct ?? "-"}`;
}

function newBucket(kind: DocTaxKind, pct: number | null): TaxBucket {
  return {
    key: bucketKey(kind, pct),
    kind,
    pct,
    baseCents: 0,
    taxCents: 0,
    refundBaseCents: 0,
    refundTaxCents: 0,
    creditNoteBaseCents: 0,
    creditNoteTaxCents: 0,
  };
}

/** Impuesto BRUTO de un tramo: el neto más lo que restaron devoluciones y notas. */
export function grossBucketTax(b: TaxBucket): number {
  return b.taxCents + b.refundTaxCents + b.creditNoteTaxCents;
}

function sortBuckets(buckets: Iterable<TaxBucket>): TaxBucket[] {
  return [...buckets].sort(
    (a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || (b.pct ?? -1) - (a.pct ?? -1),
  );
}

/**
 * Tramo DOMINANTE del período: el que más impuesto causó (el mismo criterio
 * con el que `computeTaxSummary` etiqueta el mes), o la configuración
 * actual del comercio si ninguna factura causó impuesto.
 */
export function dominantSalesTax(
  sales: readonly SaleTaxInput[],
  current: CurrentSalesTax,
): CurrentSalesTax {
  const byRate = new Map<string, { kind: SalesTaxKind; pct: number; taxCents: number }>();
  for (const s of sales) {
    if (s.taxKind === "none" || s.taxCents <= 0) continue;
    const key = `${s.taxKind}:${s.taxPct}`;
    const prev = byRate.get(key) ?? { kind: s.taxKind, pct: s.taxPct, taxCents: 0 };
    prev.taxCents += s.taxCents;
    byRate.set(key, prev);
  }
  let best: { kind: SalesTaxKind; pct: number; taxCents: number } | null = null;
  for (const r of byRate.values()) if (!best || r.taxCents > best.taxCents) best = r;
  if (best) return { kind: best.kind, pct: best.pct };
  return current.kind === "none" ? { kind: "none", pct: 0 } : current;
}

export function aggregateDocumentTaxes({
  sales,
  purchases,
  refundsCents = 0,
  currentTax = { kind: "none", pct: 0 },
  creditNotes = [],
}: {
  sales: readonly SaleTaxInput[];
  purchases: readonly PurchaseTaxInput[];
  /** Σ reembolsos de la pasarela del período SIN nota crédito ligada. */
  refundsCents?: number;
  /** Tarifa vigente del comercio (para devoluciones sin ventas en el período). */
  currentTax?: CurrentSalesTax;
  /** Notas crédito aceptadas con fecha fiscal en el período. */
  creditNotes?: readonly CreditNoteTaxInput[];
}): DocumentTaxes {
  // ── Ventas por `kind:tarifa` (lo que cada factura congeló) ──────────────
  const salesBuckets = new Map<string, TaxBucket>();
  for (const s of sales) {
    if (s.taxKind === "none") continue;
    if (s.taxCents === 0 && s.baseCents === 0) continue;
    const key = bucketKey(s.taxKind, s.taxPct);
    const b = salesBuckets.get(key) ?? newBucket(s.taxKind, s.taxPct);
    b.baseCents += s.baseCents;
    b.taxCents += s.taxCents;
    salesBuckets.set(key, b);
  }

  // ── Notas crédito: restan del tramo de cada línea lo que declararon ─────
  let creditNotesCents = 0;
  let creditNoteTaxCents = 0;
  for (const n of creditNotes) {
    for (const sl of n.slices) {
      creditNotesCents += sl.baseCents + sl.taxCents;
      if (sl.kind === "none") continue;
      const key = bucketKey(sl.kind, sl.pct);
      const b = salesBuckets.get(key) ?? newBucket(sl.kind, sl.pct);
      b.creditNoteBaseCents += sl.baseCents;
      b.creditNoteTaxCents += sl.taxCents;
      b.baseCents -= sl.baseCents;
      b.taxCents -= sl.taxCents;
      creditNoteTaxCents += sl.taxCents;
      salesBuckets.set(key, b);
    }
  }

  // ── Devoluciones sin nota: restan del tramo dominante ──────────────────
  const dominant = dominantSalesTax(sales, currentTax);
  let refundTaxCents = 0;
  if (refundsCents > 0 && dominant.kind !== "none") {
    refundTaxCents = embeddedTaxCents(refundsCents, dominant.pct);
    const key = bucketKey(dominant.kind, dominant.pct);
    const b = salesBuckets.get(key) ?? newBucket(dominant.kind, dominant.pct);
    const refundBase = refundsCents - refundTaxCents;
    b.refundBaseCents += refundBase;
    b.refundTaxCents += refundTaxCents;
    b.baseCents -= refundBase;
    b.taxCents -= refundTaxCents;
    salesBuckets.set(key, b);
  }

  // ── Compras: IVA por tarifa (líneas), INC de cabecera, retenciones ──────
  const purchaseBuckets = new Map<string, TaxBucket>();
  const retentionBuckets = new Map<string, TaxBucket>();
  let ivaNoDescontable = 0;
  let incCompras = 0;
  const addRetention = (kind: DocTaxKind, baseCents: number, taxCents: number) => {
    if (taxCents === 0) return;
    const b = retentionBuckets.get(bucketKey(kind, null)) ?? newBucket(kind, null);
    b.baseCents += baseCents;
    b.taxCents += taxCents;
    retentionBuckets.set(b.key, b);
  };
  for (const p of purchases) {
    let netTotal = 0;
    let ivaTotal = 0;
    for (const l of p.lines) {
      const tax = purchaseLineTaxCents(l.netCents, l.taxPct);
      netTotal += l.netCents;
      ivaTotal += tax;
      ivaNoDescontable += l.nonDeductibleTaxCents;
      if (tax === 0 && !(l.taxPct > 0)) continue;
      const key = bucketKey("iva", l.taxPct);
      const b = purchaseBuckets.get(key) ?? newBucket("iva", l.taxPct);
      b.baseCents += l.netCents;
      b.taxCents += tax;
      purchaseBuckets.set(key, b);
    }
    if (p.incCents !== 0) {
      const b = purchaseBuckets.get(bucketKey("inc", null)) ?? newBucket("inc", null);
      b.baseCents += netTotal;
      b.taxCents += p.incCents;
      purchaseBuckets.set(b.key, b);
      incCompras += p.incCents;
    }
    // Base de referencia: subtotal para retefuente/reteICA, el IVA para reteIVA.
    addRetention("retefuente", netTotal, p.retefuenteCents);
    addRetention("reteiva", ivaTotal, p.reteIvaCents);
    addRetention("reteica", netTotal, p.reteIcaCents);
  }

  const salesRows = sortBuckets(salesBuckets.values());
  const purchaseRows = sortBuckets(purchaseBuckets.values());
  const retentionRows = sortBuckets(retentionBuckets.values());

  const sumKind = (rows: TaxBucket[], kind: DocTaxKind) =>
    rows.filter((r) => r.kind === kind).reduce((s, r) => s + r.taxCents, 0);
  const ivaGenerado = sumKind(salesRows, "iva");
  const incGenerado = sumKind(salesRows, "inc");
  const ivaCompras = sumKind(purchaseRows, "iva");

  const totals: DocumentTaxTotals = {
    generadosCents: ivaGenerado + incGenerado,
    ivaGeneradoCents: ivaGenerado,
    incGeneradoCents: incGenerado,
    ivaComprasCents: ivaCompras,
    ivaNoDescontableCents: ivaNoDescontable,
    ivaDescontableCents: ivaCompras - ivaNoDescontable,
    incComprasCents: incCompras,
    retefuenteCents: sumKind(retentionRows, "retefuente"),
    reteIvaCents: sumKind(retentionRows, "reteiva"),
    reteIcaCents: sumKind(retentionRows, "reteica"),
    refundsCents: refundsCents > 0 ? refundsCents : 0,
    refundTaxCents,
    creditNotesCents,
    creditNoteTaxCents,
  };

  return {
    sales: salesRows,
    purchases: purchaseRows,
    retentions: retentionRows,
    totals,
    ivaDiferenciaDocumentalCents: ivaGenerado - ivaCompras,
  };
}

/** Familias documentales presentes (IVA siempre primero; INC si hubo). */
export function documentFamilies(docs: DocumentTaxes): ("iva" | "inc")[] {
  const present = new Set<"iva" | "inc">(["iva"]);
  for (const b of [...docs.sales, ...docs.purchases]) {
    if (b.kind === "inc") present.add("inc");
  }
  return [...present];
}

/** Σ impuesto de los buckets de una familia. */
export function familyTax(rows: readonly TaxBucket[], kind: DocTaxKind): number {
  return rows.filter((r) => r.kind === kind).reduce((s, r) => s + r.taxCents, 0);
}
