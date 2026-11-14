// De un gasto o de una compra recibida al contenido del documento soporte:
// líneas, IVA, retenciones, forma de pago y fecha de la operación. Las
// funciones de cálculo son PURAS (testeables sin DB); los loaders leen la
// fila con todo lo que hace falta.
//
// El documento soporte NO recalcula nada contable: copia lo que el gasto o
// la compra ya registraron (base, IVA, retenciones). Si algo de eso no cabe
// en el anexo, se bloquea con un motivo claro o —si es opcional— se deja
// fuera del XML y se dice cuál (ver `untransmittedWithholdings`).
import { addDaysIso } from "@/lib/bogota";
import { db } from "@/lib/db";
import { dianIssueDateTime } from "@/lib/dian/dianDateTime";
import { lineTaxCents, receivedPurchaseLineAmounts, PURCHASE_LINE_AMOUNTS_SELECT } from "@/lib/erp/purchaseTax";
import { expenseBaseCents, expensePayableCents } from "@/lib/erp/expenseTax";
import { UNIT_CODE, WEEKLY_MAX_DAYS, type GenerationForm } from "./constants";
import { SupportDocError } from "./errors";
import { SUPPLIER_DS_SELECT, type SupplierForSupportDoc } from "./seller";
import type {
  SupportDocLine,
  SupportDocPaymentMeans,
  SupportDocSourceType,
  SupportDocWithholding,
  UntransmittedWithholding,
} from "./types";

// ── Fechas ──────────────────────────────────────────────────────────────────

/** Días calendario de `from` a `to` ("YYYY-MM-DD"). */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/**
 * Forma de generación de las líneas (tabla 16.1.6) según cuándo se firma:
 *   · compra del mismo día de la firma → "1 Por operación" (DSFC02b exige
 *     StartDate = fecha del SigningTime);
 *   · compra de los 6 días anteriores → "2 Acumulado semanal" (art. 2 num.
 *     2.2 y art. 10 Res. 000167; DSFC02c);
 *   · más vieja → la DIAN la rechaza: no se genera (se avisa por qué);
 *   · futura → no hay operación todavía.
 */
export function generationFormFor(operationDate: string, signingDate: string): GenerationForm {
  const days = daysBetween(operationDate, signingDate);
  if (days < 0) throw new SupportDocError("operation_in_future");
  if (days === 0) return "1";
  if (days <= WEEKLY_MAX_DAYS) return "2";
  throw new SupportDocError("operation_too_old");
}

/** Último día (inclusive) en que todavía se puede transmitir la operación. */
export function lastTransmissionDate(operationDate: string): string {
  return addDaysIso(operationDate, WEEKLY_MAX_DAYS);
}

// ── Retenciones ─────────────────────────────────────────────────────────────

/** Una retención tal como la registró el gasto o la compra. */
export type RecordedRetention = {
  kind: "retefuente" | "reteiva" | "reteica";
  amountCents: number;
  /** Tarifa en puntos básicos (250 = 2,50 %), si se conoce. */
  rateBps: number | null;
  /** Base declarada por el registro, si se conoce. */
  baseCents: number | null;
};

/** Tolerancia de los valores monetarios del anexo (§6.3.1): ±2,00 pesos. */
const MONEY_TOLERANCE_CENTS = 200;

/** Reparte `amount` en proporción a `weights` (resto mayor): Σ = amount exacto. */
export function proportionalSplit(amount: number, weights: readonly number[]): number[] {
  const total = weights.reduce((a, w) => a + w, 0);
  if (total <= 0) return weights.map(() => 0);
  const raw = weights.map((w) => (amount * w) / total);
  const out = raw.map(Math.floor);
  let left = amount - out.reduce((a, v) => a + v, 0);
  const order = raw.map((r, i) => ({ i, frac: r - Math.floor(r) })).sort((a, b) => b.frac - a.frac);
  for (const { i } of order) {
    if (left <= 0) break;
    out[i] += 1;
    left -= 1;
  }
  return out;
}

/**
 * Pone en cada línea las retenciones que el anexo permite informar
 * (cac:WithholdingTaxTotal, DSAY01–DSAY13) y devuelve las que no:
 *   · ReteICA: no existe en la tabla 16.2.2 → no se transmite.
 *   · ReteRenta (retefuente) sobre la base de las líneas; ReteIVA sobre su
 *     IVA (DSAY05). Si la base registrada no es esa, o el valor no es
 *     base × tarifa (±2,00, DSAT07/DSAY07), la DIAN rechazaría el documento:
 *     como informar retenciones es opcional (0..N), esa retención no viaja y
 *     queda listada. La contabilidad del gasto o la compra no cambia.
 * El valor registrado se reparte entre las líneas en proporción a su base,
 * así el total del documento es EXACTAMENTE el registrado.
 */
export function applyWithholdings(
  lines: SupportDocLine[],
  recorded: readonly RecordedRetention[],
): { lines: SupportDocLine[]; untransmitted: UntransmittedWithholding[] } {
  const out = lines.map((l) => ({ ...l, withholdings: [] as SupportDocWithholding[] }));
  const untransmitted: UntransmittedWithholding[] = [];
  for (const r of recorded) {
    if (r.amountCents <= 0) continue;
    if (r.kind === "reteica") {
      untransmitted.push({ kind: "reteica", amountCents: r.amountCents, reason: "not_in_annex" });
      continue;
    }
    const schemeId = r.kind === "reteiva" ? "05" : "06";
    const weights = out.map((l) => (schemeId === "05" ? l.ivaCents : l.lineTotalCents));
    const base = weights.reduce((a, w) => a + w, 0);
    if (base <= 0 || (r.baseCents != null && Math.abs(r.baseCents - base) > MONEY_TOLERANCE_CENTS)) {
      untransmitted.push({ kind: r.kind, amountCents: r.amountCents, reason: "base_mismatch" });
      continue;
    }
    // Tarifa con 2 decimales: la registrada o la que resulta del valor.
    const pctTimes100 = r.rateBps != null && r.rateBps > 0 ? r.rateBps : Math.round((r.amountCents * 10_000) / base);
    if (Math.abs((base * pctTimes100) / 10_000 - r.amountCents) > MONEY_TOLERANCE_CENTS) {
      untransmitted.push({ kind: r.kind, amountCents: r.amountCents, reason: "rate_mismatch" });
      continue;
    }
    const pct = (pctTimes100 / 100).toFixed(2);
    const shares = proportionalSplit(r.amountCents, weights);
    out.forEach((l, i) => {
      if (weights[i] <= 0) return;
      l.withholdings.push({ schemeId, taxableCents: weights[i], amountCents: shares[i], pct });
    });
  }
  return { lines: out, untransmitted };
}

// ── IVA ─────────────────────────────────────────────────────────────────────

/**
 * Tarifa del IVA de una línea con 2 decimales. Tolerancia del IVA ±5 pesos
 * (§6.3.1): si el IVA registrado no es base × tarifa, la DIAN rechaza
 * (DSAS07); se bloquea antes de gastar un número.
 */
export function ivaPctFor(baseCents: number, ivaCents: number, pct: number): string {
  if (ivaCents <= 0) return "0.00";
  let p = pct;
  if (!(p > 0)) p = Math.round((ivaCents * 100) / Math.max(1, baseCents));
  if (Math.abs(lineTaxCents(baseCents, p) - ivaCents) > 500) throw new SupportDocError("iva_mismatch");
  return p.toFixed(2);
}

// ── Gasto ───────────────────────────────────────────────────────────────────

export const EXPENSE_DS_SELECT = {
  id: true,
  restaurantId: true,
  category: true,
  description: true,
  date: true,
  amountCents: true,
  baseCents: true,
  ivaPct: true,
  ivaCents: true,
  incCents: true,
  payableCents: true,
  paidCents: true,
  paidAt: true,
  dueAt: true,
  documentNumber: true,
  recurring: true,
  supplier: { select: SUPPLIER_DS_SELECT },
  retentions: { select: { kind: true, rateBps: true, baseCents: true, amountCents: true } },
} as const;

export type ExpenseForSupportDoc = {
  id: string;
  category: string;
  description: string | null;
  date: Date;
  amountCents: number;
  baseCents: number;
  ivaPct: number;
  ivaCents: number;
  incCents: number;
  payableCents: number;
  paidCents: number;
  paidAt: Date | null;
  dueAt: Date | null;
  documentNumber: string | null;
  recurring: boolean;
  supplier: SupplierForSupportDoc | null;
  retentions: { kind: string; rateBps: number; baseCents: number; amountCents: number }[];
};

/** Contenido del documento: lo que sale del gasto o de la compra. */
export type SupportDocDraft = {
  sourceType: SupportDocSourceType;
  sourceId: string;
  sourceLabel: string | null;
  supplier: SupplierForSupportDoc | null;
  operationDate: string;
  lines: SupportDocLine[];
  paymentMeans: SupportDocPaymentMeans;
  untransmittedWithholdings: UntransmittedWithholding[];
};

/**
 * Forma y medio de pago (DSAN01–DSAN04). Pagado completo → contado. Con
 * saldo y vencimiento → crédito con ese vencimiento (nunca antes de la
 * emisión). Sin dato del medio: "1 Instrumento no definido" (tabla
 * 16.3.4.2), que es lo honesto cuando no se sabe cómo se pagó.
 */
export function paymentMeansFor(
  paid: boolean,
  dueAt: Date | null,
  issueDate: string,
): SupportDocPaymentMeans {
  if (!paid && dueAt) {
    const due = dianIssueDateTime(dueAt).date;
    return { id: "2", code: "1", dueDate: due < issueDate ? issueDate : due };
  }
  return { id: "1", code: "1", dueDate: null };
}

function itemCodeFrom(label: string, n: number): string {
  // El código del ítem es libre (esquema 999), pero mejor sin espacios.
  return `${label.replace(/[^A-Za-z0-9-]/g, "") || "ITEM"}-${n}`;
}

export function draftFromExpense(e: ExpenseForSupportDoc, now: Date): SupportDocDraft {
  if (e.recurring) throw new SupportDocError("source_not_ready");
  if (e.incCents > 0) throw new SupportDocError("inc_not_supported");
  const issueDate = dianIssueDateTime(now).date;
  const operationDate = dianIssueDateTime(e.date).date;
  const form = generationFormFor(operationDate, issueDate);
  const base = expenseBaseCents(e);
  if (base <= 0) throw new SupportDocError("empty_document");
  const ivaPct = ivaPctFor(base, e.ivaCents, e.ivaPct);
  const description = (e.description ?? "").trim() || e.category.trim();
  const line: SupportDocLine = {
    description,
    quantity: 1,
    unitCode: UNIT_CODE,
    unitPriceCents: base,
    lineTotalCents: base,
    ivaCents: e.ivaCents,
    ivaPct,
    itemCode: itemCodeFrom("G", 1),
    purchaseDate: operationDate,
    generationForm: form,
    withholdings: [],
  };
  const { lines, untransmitted } = applyWithholdings(
    [line],
    e.retentions.map((r) => ({
      kind: r.kind === "reteiva" ? "reteiva" : r.kind === "reteica" ? "reteica" : "retefuente",
      amountCents: r.amountCents,
      rateBps: r.rateBps,
      baseCents: r.baseCents,
    })),
  );
  const payable = expensePayableCents(e);
  return {
    sourceType: "expense",
    sourceId: e.id,
    sourceLabel: e.documentNumber,
    supplier: e.supplier,
    operationDate,
    lines,
    paymentMeans: paymentMeansFor(e.paidCents >= payable, e.dueAt, issueDate),
    untransmittedWithholdings: untransmitted,
  };
}

// ── Compra ──────────────────────────────────────────────────────────────────

export const PURCHASE_DS_SELECT = {
  id: true,
  restaurantId: true,
  number: true,
  status: true,
  supplierInvoiceNumber: true,
  receivedAt: true,
  createdAt: true,
  invoiceDueAt: true,
  paidAt: true,
  incCents: true,
  retefuenteCents: true,
  reteIvaCents: true,
  reteIcaCents: true,
  supplier: { select: SUPPLIER_DS_SELECT },
  items: {
    select: {
      ...PURCHASE_LINE_AMOUNTS_SELECT,
      id: true,
      lastReceivedAt: true,
      ingredient: { select: { name: true, measureKind: true } },
    },
    orderBy: { id: "asc" as const },
  },
} as const;

export type PurchaseForSupportDoc = {
  id: string;
  number: number;
  status: string;
  supplierInvoiceNumber: string | null;
  receivedAt: Date | null;
  createdAt: Date;
  invoiceDueAt: Date | null;
  paidAt: Date | null;
  incCents: number;
  retefuenteCents: number;
  reteIvaCents: number;
  reteIcaCents: number;
  supplier: SupplierForSupportDoc | null;
  items: Array<{
    id: string;
    expectedCostCents: number;
    expectedTaxCents: number | null;
    expectedIncCents: number;
    qtyOrderedBase: number;
    taxPct: number;
    receivedCostCents: number;
    receivedQtyBase: number;
    lastReceivedAt: Date | null;
    ingredient: { name: string; measureKind: string };
  }>;
};

const UNIT_LABEL: Record<string, string> = { mass: "g", volume: "ml", count: "un" };

/** "OC-0007" (y el número de la factura del proveedor, si lo hay). */
export function purchaseLabel(p: Pick<PurchaseForSupportDoc, "number" | "supplierInvoiceNumber">): string {
  const oc = `OC-${String(p.number).padStart(4, "0")}`;
  return p.supplierInvoiceNumber ? `${oc} · ${p.supplierInvoiceNumber}` : oc;
}

/**
 * Una línea por insumo RECIBIDO, por su valor neto recibido (con los
 * descuentos ya prorrateados, como los guarda la compra). La cantidad va
 * como 1 con la cantidad física en la descripción: así cantidad × precio =
 * valor de la línea al centavo (DSAV06); en gramos o mililitros el precio
 * unitario tendría fracciones de centavo y descuadraría.
 */
export function draftFromPurchase(p: PurchaseForSupportDoc, now: Date): SupportDocDraft {
  if (p.status !== "received") throw new SupportDocError("source_not_ready");
  const issueDate = dianIssueDateTime(now).date;
  const lastItem = p.items
    .map((i) => i.lastReceivedAt?.getTime() ?? 0)
    .reduce((a, b) => Math.max(a, b), 0);
  const operationAt = p.receivedAt ?? (lastItem > 0 ? new Date(lastItem) : p.createdAt);
  const operationDate = dianIssueDateTime(operationAt).date;
  const form = generationFormFor(operationDate, issueDate);
  const received = p.items
    .map((item) => ({ item, amounts: receivedPurchaseLineAmounts(item) }))
    .filter(({ amounts }) => amounts.netCents > 0);
  if (received.length === 0) throw new SupportDocError("empty_document");
  const lineInc = received.reduce((a, { amounts }) => a + amounts.incCents, 0);
  if (lineInc > 0 || p.incCents > 0) throw new SupportDocError("inc_not_supported");
  const lines: SupportDocLine[] = received.map(({ item, amounts }, idx) => {
    const unit = UNIT_LABEL[item.ingredient.measureKind] ?? "";
    const qty = item.receivedQtyBase > 0 ? ` (${item.receivedQtyBase} ${unit})`.replace(/ \)$/, ")") : "";
    return {
      description: `${item.ingredient.name.trim()}${qty}`,
      quantity: 1,
      unitCode: UNIT_CODE,
      unitPriceCents: amounts.netCents,
      lineTotalCents: amounts.netCents,
      ivaCents: amounts.taxCents,
      ivaPct: ivaPctFor(amounts.netCents, amounts.taxCents, item.taxPct),
      itemCode: itemCodeFrom("OC", idx + 1),
      purchaseDate: operationDate,
      generationForm: form,
      withholdings: [],
    };
  });
  const { lines: withW, untransmitted } = applyWithholdings(lines, [
    { kind: "retefuente", amountCents: p.retefuenteCents, rateBps: null, baseCents: null },
    { kind: "reteiva", amountCents: p.reteIvaCents, rateBps: null, baseCents: null },
    { kind: "reteica", amountCents: p.reteIcaCents, rateBps: null, baseCents: null },
  ]);
  return {
    sourceType: "purchase_order",
    sourceId: p.id,
    sourceLabel: purchaseLabel(p),
    supplier: p.supplier,
    operationDate,
    lines: withW,
    paymentMeans: paymentMeansFor(p.paidAt != null, p.invoiceDueAt, issueDate),
    untransmittedWithholdings: untransmitted,
  };
}

// ── Loaders ─────────────────────────────────────────────────────────────────

/** Lee el gasto o la compra (del comercio) y arma el borrador. */
export async function loadSupportDocDraft(
  restaurantId: string,
  sourceType: SupportDocSourceType,
  sourceId: string,
  now: Date,
): Promise<SupportDocDraft> {
  if (sourceType === "expense") {
    const e = await db.expense.findFirst({ where: { id: sourceId, restaurantId }, select: EXPENSE_DS_SELECT });
    if (!e) throw new SupportDocError("source_not_found");
    return draftFromExpense(e as unknown as ExpenseForSupportDoc, now);
  }
  const p = await db.purchaseOrder.findFirst({ where: { id: sourceId, restaurantId }, select: PURCHASE_DS_SELECT });
  if (!p) throw new SupportDocError("source_not_found");
  return draftFromPurchase(p as unknown as PurchaseForSupportDoc, now);
}

/** Llave del documento soporte VIGENTE de un gasto o compra (única). */
export function activeKeyFor(sourceType: SupportDocSourceType, sourceId: string): string {
  return `${sourceType}:${sourceId}`;
}
