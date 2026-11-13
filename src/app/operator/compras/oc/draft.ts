// «Nueva orden de compra» — LÓGICA PURA del formulario (sin React ni red).
//
// Cada producto de la orden es una FILA editable: insumo, cantidad, unidad
// (una presentación del proveedor o g/kg/ml/L/un), precio unitario,
// descuento, impuesto y total. Acá vive todo lo que no es pintar: precargar
// precio y presentación con lo último que se le pidió al proveedor, sumar
// filas repetidas, validar cada celda, las teclas de la tabla, los totales y
// el cuerpo del POST — el mismo que mandaba el formulario anterior, con los
// mismos ayudantes de descuento e impuesto que corre el servidor.

import {
  DISPLAY_UNITS,
  toBaseQty,
  type MeasureKind,
} from "@/lib/erp/units";
import { referenceLineCost, REFERENCE_PRICE_QTY_BASE } from "@/lib/erp/ingredientPrice";
import {
  parseDiscountInput,
  persistedOrderDiscounts,
  resolveOrderDiscounts,
} from "@/lib/erp/purchaseDiscount";
import { lineIncCents, PURCHASE_MAX_CENTS, type LineTaxChoice } from "@/lib/erp/purchaseLineTax";
import { poTotals } from "@/lib/erp/purchaseTax";
import type { PurchaseRetentionTotals } from "@/lib/erp/purchaseRetentions";
import type { SupplierHistoryItem } from "@/lib/erp/supplierHistory";
import { foldSearchText, supplierMatchTier } from "@/lib/suppliers/supplierSearch";

/* ───────────────────────────── Tipos ───────────────────────────────── */

/** Valor de la unidad de una fila cuando va en presentaciones del proveedor. */
export const PRES = "pres";

/** Tope de presentaciones de una línea (el mismo del API). */
const MAX_PRESENTATIONS = 100_000;

export type OcIngredient = {
  id: string;
  name: string;
  measureKind: MeasureKind;
  /** Precio de referencia por kg/L/un, en centavos. */
  referencePriceCents?: number | null;
};

/** Presentación de la lista de precios del proveedor (A0). */
export type OcSupplierItem = {
  id: string;
  presentationLabel: string;
  /** Contenido de UNA presentación, en unidad base. */
  contentQty: number;
  /** Último precio por presentación, en centavos. */
  lastPriceCents: number | null;
  ingredient: OcIngredient;
};

export type OcCatalog = {
  /** Lista de precios del proveedor (solo insumos activos). */
  priceList: OcSupplierItem[];
  /** Insumos activos del comercio. */
  ingredients: OcIngredient[];
  /** Lo que se le ha pedido a este proveedor, por insumo. */
  history: SupplierHistoryItem[];
};

/** De dónde salió el precio precargado (para la ayuda de la celda). */
export type PriceSource = "list" | "history" | "reference";

export type OcLine = {
  key: number;
  ingredient: OcIngredient | null;
  /** Presentación del proveedor para este insumo, si la tiene. */
  supplierItem: Omit<OcSupplierItem, "ingredient"> | null;
  /** PRES = en presentaciones del proveedor; si no, g/kg/ml/L/un. */
  unit: string;
  qtyRaw: string;
  /**
   * Precio unitario en pesos sin agrupar ("4500.5", como lo da MoneyInput):
   * por presentación, o por kg/L/un si la fila va en cantidad suelta.
   */
  priceRaw: string;
  /** Total de la línea escrito a mano: manda sobre cantidad × precio. */
  totalRaw: string | null;
  priceSource: PriceSource | null;
  tax: LineTaxChoice;
  incRaw: string;
  incIsPct: boolean;
  discRaw: string;
  discIsPct: boolean;
  /** Ya se respondió «Dejar separadas» al aviso de insumo repetido. */
  dupDismissed: boolean;
};

/** Lo que el POST necesita de una fila completa (como el formulario anterior). */
export type ResolvedOcLine = {
  ingredientId: string;
  supplierItemId: string | null;
  presentations: number | null;
  qtyBase: number;
  /** Neto de LISTA de la línea (antes de descuentos), en centavos. */
  expectedCostCents: number;
  taxPct: number;
  inc: boolean;
  incRaw: string;
  incIsPct: boolean;
  discRaw: string;
  discIsPct: boolean;
};

export const NO_TAX: LineTaxChoice = { ivaPct: 0, inc: false };

/**
 * Cómo se escriben los números en la pantalla: el separador decimal del
 * idioma y el paso al que se redondea un precio CALCULADO (de la última
 * orden o de un cambio de unidad): 100 centavos en monedas sin decimales
 * (COP), para no proponer «$ 5.916,67/kg»; 1 en las demás.
 */
export type DraftFmt = { dec: string; step: number };
export const DEFAULT_FMT: DraftFmt = { dec: ",", step: 1 };

function roundTo(cents: number, step: number): number {
  return step > 1 ? Math.round(cents / step) * step : Math.round(cents);
}

/* ───────────────────────── Números y unidades ──────────────────────── */

/** "2,5" o "2.5" → 2.5; vacío, cero o basura → null. */
export function parseQty(raw: string): number | null {
  const t = raw.trim();
  if (t === "") return null;
  const n = Number(t.replace(",", "."));
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Pesos sin agrupar ("4500.5") → centavos; vacío o inválido → null. */
export function parsePesos(raw: string): number | null {
  const t = raw.trim();
  if (t === "") return null;
  const n = Number(t.replace(",", "."));
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 100);
}

/** Centavos → pesos sin agrupar, para MoneyInput ("4500.5"). */
export function centsToRaw(cents: number): string {
  return String(Math.round(cents) / 100);
}

/** Cantidad para mostrar en un input (hasta 3 decimales, con el separador del idioma). */
export function formatQty(n: number, decimalSep = ","): string {
  return String(Math.round(n * 1000) / 1000).replace(".", decimalSep);
}

/** Unidad en que se cotiza el precio de una fila suelta: kg, L o un. */
export function priceUnitSymbol(kind: MeasureKind): string {
  return { mass: "kg", volume: "L", count: "un" }[kind];
}

/** Presentaciones de la fila (entero ≥1) o null. */
export function linePresentations(l: OcLine): number | null {
  if (l.unit !== PRES || !l.supplierItem) return null;
  const n = parseQty(l.qtyRaw);
  return n != null && Number.isInteger(n) && n >= 1 && n <= MAX_PRESENTATIONS ? n : null;
}

/** Cantidad de la fila en unidad base, o null si no es válida. */
export function lineQtyBase(l: OcLine): number | null {
  if (!l.ingredient) return null;
  if (l.unit === PRES) {
    const n = linePresentations(l);
    if (n == null || !l.supplierItem) return null;
    const base = n * l.supplierItem.contentQty;
    return base >= 1 && base <= PURCHASE_MAX_CENTS ? base : null;
  }
  const q = parseQty(l.qtyRaw);
  return q == null ? null : toBaseQty(q, l.ingredient.measureKind, l.unit);
}

/** Cantidad × precio (centavos), sin el total manual. */
export function computedLineCents(l: OcLine): number | null {
  const price = parsePesos(l.priceRaw);
  if (price == null) return null;
  if (l.unit === PRES) {
    const n = linePresentations(l);
    return n == null ? null : n * price;
  }
  const base = lineQtyBase(l);
  // Precio por kg/L/un (1000 base), redondeado igual que la sugerencia anterior.
  return base == null ? null : referenceLineCost(price, base);
}

/** Neto de lista de la fila: el total escrito a mano o cantidad × precio. */
export function lineListCents(l: OcLine): number | null {
  if (l.totalRaw != null) return parsePesos(l.totalRaw);
  return computedLineCents(l);
}

/** Precio unitario efectivo (si el total va a mano, el que resulta de él). */
export function effectiveUnitCents(l: OcLine): number | null {
  if (l.totalRaw == null) return parsePesos(l.priceRaw);
  const total = parsePesos(l.totalRaw);
  if (total == null) return null;
  if (l.unit === PRES) {
    const n = linePresentations(l);
    return n == null ? null : Math.round(total / n);
  }
  const base = lineQtyBase(l);
  return base == null ? null : Math.round((total * REFERENCE_PRICE_QTY_BASE) / base);
}

/* ───────────────────────── Filas: crear y cambiar ──────────────────── */

export function blankLine(key: number, tax: LineTaxChoice = NO_TAX): OcLine {
  return {
    key,
    ingredient: null,
    supplierItem: null,
    unit: "",
    qtyRaw: "",
    priceRaw: "",
    totalRaw: null,
    priceSource: null,
    tax,
    incRaw: "",
    incIsPct: true,
    discRaw: "",
    discIsPct: true,
    dupDismissed: false,
  };
}

/** Siguiente key libre (determinista: el mayor + 1). */
export function nextKey(lines: readonly OcLine[]): number {
  return lines.reduce((m, l) => Math.max(m, l.key), 0) + 1;
}

/** ¿Fila sin nada escrito? No cuenta, no se valida ni se manda. */
export function isBlankLine(l: OcLine): boolean {
  return (
    !l.ingredient &&
    l.qtyRaw.trim() === "" &&
    l.priceRaw.trim() === "" &&
    (l.totalRaw == null || l.totalRaw.trim() === "")
  );
}

export function insertBlankAfter(lines: readonly OcLine[], index: number, tax?: LineTaxChoice): { lines: OcLine[]; key: number } {
  const key = nextKey(lines);
  const next = [...lines];
  next.splice(Math.min(Math.max(index + 1, 0), next.length), 0, blankLine(key, tax));
  return { lines: next, key };
}

export function removeLine(lines: readonly OcLine[], key: number): OcLine[] {
  return lines.filter((l) => l.key !== key);
}

export function patchLine(lines: readonly OcLine[], key: number, patch: Partial<OcLine>): OcLine[] {
  return lines.map((l) => (l.key === key ? { ...l, ...patch } : l));
}

/** Precio sugerido para un insumo en una unidad, y de dónde sale. */
export function suggestPrice(
  ingredient: OcIngredient,
  supplierItem: OcLine["supplierItem"],
  history: SupplierHistoryItem | undefined,
  unit: string,
  step = 1,
): { cents: number; source: PriceSource } | null {
  const perRef = (cents: number, base: number) => roundTo((cents * REFERENCE_PRICE_QTY_BASE) / base, step);
  if (unit === PRES && supplierItem && supplierItem.contentQty > 0) {
    if (supplierItem.lastPriceCents != null) return { cents: supplierItem.lastPriceCents, source: "list" };
    if (history && history.supplierItemId === supplierItem.id && history.presentations) {
      return { cents: roundTo(history.listCostCents / history.presentations, step), source: "history" };
    }
    if (history && history.qtyBase > 0) {
      return { cents: roundTo((history.listCostCents * supplierItem.contentQty) / history.qtyBase, step), source: "history" };
    }
    if (ingredient.referencePriceCents != null) {
      return {
        cents: roundTo((ingredient.referencePriceCents * supplierItem.contentQty) / REFERENCE_PRICE_QTY_BASE, step),
        source: "reference",
      };
    }
    return null;
  }
  if (history && history.qtyBase > 0) return { cents: perRef(history.listCostCents, history.qtyBase), source: "history" };
  if (supplierItem && supplierItem.lastPriceCents != null && supplierItem.contentQty > 0) {
    return { cents: perRef(supplierItem.lastPriceCents, supplierItem.contentQty), source: "list" };
  }
  if (ingredient.referencePriceCents != null) return { cents: ingredient.referencePriceCents, source: "reference" };
  return null;
}

/** Cantidad base → texto en la unidad pedida (PRES = presentaciones). */
function baseToUnitQty(base: number, unit: string, kind: MeasureKind, contentQty: number | null, dec: string): string {
  if (unit === PRES) return contentQty ? formatQty(base / contentQty, dec) : "";
  const u = DISPLAY_UNITS[kind].find((x) => x.symbol === unit);
  return u ? formatQty(base / u.factor, dec) : "";
}

/**
 * Unidad con la que entra un insumo: la presentación del proveedor, salvo
 * que la última vez se le pidiera suelto; suelta, siempre en la unidad en
 * que se cotiza (kg, L, un): «3» son 3 kg aunque la última vez se pidieran
 * 500 g (0,5 kg). g y ml quedan en el selector.
 */
export function defaultUnit(kind: MeasureKind, hasPresentation: boolean, hist: SupplierHistoryItem | null | undefined): string {
  return hasPresentation && (!hist || hist.supplierItemId != null) ? PRES : priceUnitSymbol(kind);
}

/**
 * Elige el insumo de una fila. Recuerda cómo se le pidió a ESTE proveedor la
 * última vez (presentación o unidad, cantidad, IVA y consumo) y precarga el
 * precio: el último de la lista de precios, el de la última orden o el de
 * referencia del insumo, en ese orden.
 */
export function pickIngredient(
  line: OcLine,
  ingredient: OcIngredient,
  catalog: Pick<OcCatalog, "priceList" | "history">,
  fmt: DraftFmt = DEFAULT_FMT,
): OcLine {
  const { dec } = fmt;
  const item = catalog.priceList.find((i) => i.ingredient.id === ingredient.id) ?? null;
  const supplierItem = item
    ? { id: item.id, presentationLabel: item.presentationLabel, contentQty: item.contentQty, lastPriceCents: item.lastPriceCents }
    : null;
  const hist = catalog.history.find((h) => h.ingredientId === ingredient.id);
  const kind = ingredient.measureKind;
  const unit = defaultUnit(kind, supplierItem != null, hist);

  let qtyRaw = "1";
  if (hist && hist.qtyBase > 0) {
    if (unit === PRES && hist.supplierItemId === supplierItem?.id && hist.presentations) qtyRaw = String(hist.presentations);
    else if (unit !== PRES) qtyRaw = baseToUnitQty(hist.qtyBase, unit, kind, null, dec);
  }
  const price = suggestPrice(ingredient, supplierItem, hist, unit, fmt.step);
  const tax: LineTaxChoice = hist ? { ivaPct: hist.taxPct, inc: hist.incPct != null } : line.tax;
  return {
    ...line,
    ingredient,
    supplierItem,
    unit,
    qtyRaw,
    priceRaw: price ? centsToRaw(price.cents) : "",
    priceSource: price?.source ?? null,
    totalRaw: null,
    tax,
    incRaw: hist?.incPct != null ? formatQty(hist.incPct, dec) : hist ? "" : line.incRaw,
    incIsPct: hist ? true : line.incIsPct,
    dupDismissed: false,
  };
}

/**
 * Cambia la unidad de la fila conservando lo físico y la plata: la cantidad
 * se convierte (2 bultos de 50 kg → 100 kg) y el precio unitario también
 * ($180.000 el bulto → $3.600 el kg). El total escrito a mano se conserva.
 */
export function changeUnit(l: OcLine, unit: string, fmt: DraftFmt = DEFAULT_FMT): OcLine {
  const { dec, step } = fmt;
  if (!l.ingredient || unit === l.unit) return { ...l, unit };
  const kind = l.ingredient.measureKind;
  const content = l.supplierItem?.contentQty ?? null;
  if (unit === PRES && !content) return l;
  const base = lineQtyBase(l);
  const qtyRaw = base != null ? baseToUnitQty(base, unit, kind, content, dec) : l.qtyRaw;
  const price = parsePesos(l.priceRaw);
  let priceRaw = l.priceRaw;
  if (price != null && content) {
    if (l.unit === PRES && unit !== PRES) priceRaw = centsToRaw(roundTo((price * REFERENCE_PRICE_QTY_BASE) / content, step));
    else if (l.unit !== PRES && unit === PRES) priceRaw = centsToRaw(roundTo((price * content) / REFERENCE_PRICE_QTY_BASE, step));
  }
  return { ...l, unit, qtyRaw, priceRaw };
}

/**
 * La fila sin la presentación de su proveedor (al cambiar de proveedor): si
 * iba en presentaciones pasa a kg/L/un con la misma cantidad física y el
 * mismo total; el precio de la lista del otro proveedor deja de rotularse
 * como tal.
 */
export function detachLine(l: OcLine, fmt: DraftFmt = DEFAULT_FMT): OcLine {
  if (!l.ingredient || !l.supplierItem) return l;
  const next = l.unit === PRES ? changeUnit(l, priceUnitSymbol(l.ingredient.measureKind), fmt) : l;
  return { ...next, supplierItem: null, priceSource: next.priceSource === "list" ? null : next.priceSource };
}

/** Otra fila con el mismo insumo (la primera), o null. */
export function duplicateOf(lines: readonly OcLine[], key: number): OcLine | null {
  const line = lines.find((l) => l.key === key);
  if (!line?.ingredient) return null;
  return lines.find((l) => l.key !== key && l.ingredient?.id === line.ingredient!.id) ?? null;
}

/**
 * Suma la fila `sourceKey` a `targetKey` (mismo insumo) y la quita. La
 * cantidad queda en la unidad de la fila destino (o en kg/L/un si las
 * presentaciones no dan exactas) y el total es la suma de los dos; si las
 * dos iban al mismo precio unitario, se sigue calculando con él.
 * null si alguna de las dos no tiene cantidad y precio válidos.
 */
export function mergeLines(lines: readonly OcLine[], targetKey: number, sourceKey: number, fmt: DraftFmt = DEFAULT_FMT): OcLine[] | null {
  const { dec } = fmt;
  const target = lines.find((l) => l.key === targetKey);
  const source = lines.find((l) => l.key === sourceKey);
  if (!target?.ingredient || !source?.ingredient || target.ingredient.id !== source.ingredient.id) return null;
  const tBase = lineQtyBase(target);
  const sBase = lineQtyBase(source);
  const tList = lineListCents(target);
  const sList = lineListCents(source);
  if (tBase == null || sBase == null || tList == null || sList == null) return null;
  const kind = target.ingredient.measureKind;
  const total = tBase + sBase;
  let merged: OcLine;
  if (target.unit === PRES && target.supplierItem && total % target.supplierItem.contentQty === 0) {
    merged = { ...target, qtyRaw: String(total / target.supplierItem.contentQty) };
  } else {
    const unit = target.unit === PRES ? priceUnitSymbol(kind) : target.unit;
    const asUnit = changeUnit(target, unit, fmt);
    merged = { ...asUnit, qtyRaw: baseToUnitQty(total, unit, kind, null, dec) };
  }
  const samePrice =
    target.totalRaw == null &&
    source.totalRaw == null &&
    effectiveUnitCents(changeUnit(source, merged.unit, fmt)) === parsePesos(merged.priceRaw);
  merged = { ...merged, totalRaw: null };
  if (!samePrice || computedLineCents(merged) !== tList + sList) {
    merged = { ...merged, totalRaw: centsToRaw(tList + sList) };
  }
  return lines.filter((l) => l.key !== sourceKey).map((l) => (l.key === targetKey ? merged : l));
}

/* ───────────────────────────── Validación ──────────────────────────── */

export type LineIssue =
  | "itemRequired"
  | "qtyRequired"
  | "qtyInvalid"
  | "qtyWhole"
  | "priceRequired"
  | "priceInvalid";

export type LineIssues = { item?: LineIssue; qty?: LineIssue; price?: LineIssue };

/** Problemas de cada celda de la fila (vacío = fila lista, o en blanco). */
export function lineIssues(l: OcLine): LineIssues {
  if (isBlankLine(l)) return {};
  const out: LineIssues = {};
  if (!l.ingredient) out.item = "itemRequired";
  const q = parseQty(l.qtyRaw);
  if (l.qtyRaw.trim() === "") out.qty = "qtyRequired";
  else if (q == null) out.qty = "qtyInvalid";
  else if (l.ingredient && lineQtyBase(l) == null) {
    out.qty = l.unit === PRES && !Number.isInteger(q) ? "qtyWhole" : "qtyInvalid";
  }
  const moneyRaw = l.totalRaw ?? l.priceRaw;
  if (moneyRaw.trim() === "") out.price = "priceRequired";
  else if (parsePesos(moneyRaw) == null) out.price = "priceInvalid";
  else if (!out.qty && !out.item) {
    const list = lineListCents(l);
    if (list == null || list > PURCHASE_MAX_CENTS) out.price = "priceInvalid";
  }
  return out;
}

export function hasIssues(i: LineIssues): boolean {
  return i.item != null || i.qty != null || i.price != null;
}

/** La fila lista para el POST, o null (en blanco o con problemas). */
export function resolveLine(l: OcLine): ResolvedOcLine | null {
  if (isBlankLine(l) || hasIssues(lineIssues(l)) || !l.ingredient) return null;
  const qtyBase = lineQtyBase(l);
  const list = lineListCents(l);
  if (qtyBase == null || list == null) return null;
  const pres = l.unit === PRES && l.supplierItem ? linePresentations(l) : null;
  return {
    ingredientId: l.ingredient.id,
    supplierItemId: pres != null ? l.supplierItem!.id : null,
    presentations: pres,
    qtyBase,
    expectedCostCents: list,
    taxPct: l.tax.ivaPct,
    inc: l.tax.inc,
    incRaw: l.incRaw,
    incIsPct: l.incIsPct,
    discRaw: l.discRaw,
    discIsPct: l.discIsPct,
  };
}

/** Filas completas, en orden, y cuántas tienen algo escrito pero no sirven. */
export function resolveLines(lines: readonly OcLine[]): { lines: ResolvedOcLine[]; keys: number[]; invalidKeys: number[] } {
  const out: ResolvedOcLine[] = [];
  const keys: number[] = [];
  const invalidKeys: number[] = [];
  for (const l of lines) {
    if (isBlankLine(l)) continue;
    const r = resolveLine(l);
    if (r) {
      out.push(r);
      keys.push(l.key);
    } else invalidKeys.push(l.key);
  }
  return { lines: out, keys, invalidKeys };
}

/* ────────────────────────────── Totales ────────────────────────────── */

/**
 * Totales de la orden con el mismo cálculo del servidor: descuento de cada
 * línea, después el del pie prorrateado sobre lo que quedó; IVA por línea
 * sobre el neto y consumo sobre el neto ya descontado.
 */
export function draftTotals(lines: readonly ResolvedOcLine[], orderDiscRaw: string, orderDiscIsPct: boolean) {
  const persisted = persistedOrderDiscounts(
    lines.map((l) => ({ listCents: l.expectedCostCents, discRaw: l.discRaw, discIsPct: l.discIsPct })),
    orderDiscRaw,
    orderDiscIsPct,
  );
  const applied = resolveOrderDiscounts(
    lines.map((l, i) => ({ listCents: l.expectedCostCents, discount: persisted.lines[i]! })),
    persisted.order,
  );
  const lineIncs = lines.map((l, i) =>
    l.inc ? lineIncCents(applied.lines[i]?.netCents ?? 0, parseDiscountInput(l.incRaw, l.incIsPct)) : 0,
  );
  const breakdownLines = applied.lines.map((a, i) => ({ costCents: a.netCents, taxPct: lines[i]!.taxPct }));
  const { taxCents, totalCents } = poTotals(breakdownLines);
  const incCents = lineIncs.reduce((s, c) => s + c, 0);
  return {
    persisted,
    applied,
    lineIncs,
    breakdownLines,
    subtotalCents: applied.subtotalCents,
    discountCents: applied.discountCents,
    ivaCents: taxCents,
    incCents,
    /** Neto + IVA + consumo (antes de retenciones). */
    totalCents: totalCents + incCents,
    /** Lo que ve la retención: base neta, IVA y consumo de la factura. */
    invoiceDoc: { baseCents: applied.netCents, ivaCents: taxCents, incCents },
  };
}

export type DraftTotals = ReturnType<typeof draftTotals>;

/* ─────────────────────────────── POST ──────────────────────────────── */

/** "2026-07-10" (input date) → ISO al mediodía local (sin corrimiento de día). */
export function dateInputToIso(value: string): string {
  return new Date(`${value}T12:00:00`).toISOString();
}

export type CreateOrderInput = {
  supplierId: string;
  lines: readonly ResolvedOcLine[];
  orderDiscRaw: string;
  orderDiscIsPct: boolean;
  notes: string;
  /** Entrega esperada (input date) — solo si no se recibe ya. */
  expectedAt: string;
  receivedNow: boolean;
  invoiceNumber: string;
  invoiceDueAt: string;
  retentions: PurchaseRetentionTotals;
};

/**
 * Cuerpo del POST /api/operator/purchase-orders: el mismo contrato del
 * formulario anterior. Los descuentos viajan con los nombres que lee el API
 * (`discountPct` / `discountCents`, por línea y del pie).
 */
export function buildCreateOrderPayload(input: CreateOrderInput) {
  const totals = draftTotals(input.lines, input.orderDiscRaw, input.orderDiscIsPct);
  const discount = (d: { pct: number | null; cents: number | null }) => ({
    discountPct: d.pct,
    discountCents: d.cents,
  });
  return {
    supplierId: input.supplierId,
    lines: input.lines.map((l, i) =>
      l.supplierItemId
        ? {
            ingredientId: l.ingredientId,
            supplierItemId: l.supplierItemId,
            presentations: l.presentations,
            expectedCostCents: l.expectedCostCents,
            taxPct: l.taxPct,
            expectedIncCents: totals.lineIncs[i] ?? 0,
            ...discount(totals.persisted.lines[i]!),
          }
        : {
            ingredientId: l.ingredientId,
            qtyBase: l.qtyBase,
            expectedCostCents: l.expectedCostCents,
            taxPct: l.taxPct,
            expectedIncCents: totals.lineIncs[i] ?? 0,
            ...discount(totals.persisted.lines[i]!),
          },
    ),
    ...discount(totals.persisted.order),
    notes: input.notes.trim() || null,
    expectedAt: !input.receivedNow && input.expectedAt ? dateInputToIso(input.expectedAt) : null,
    ...(input.receivedNow
      ? {
          receive: {
            supplierInvoiceNumber: input.invoiceNumber.trim() || null,
            invoiceDueAt: input.invoiceDueAt ? dateInputToIso(input.invoiceDueAt) : null,
            ...input.retentions,
          },
        }
      : {}),
  };
}

/* ──────────────────────── Teclado de la tabla ──────────────────────── */

export type OcCol = "item" | "qty" | "unit" | "price" | "disc" | "tax" | "total";

/** Columnas de texto: ↑/↓ cambian de fila (en los select cambian el valor). */
const TEXT_COLS: ReadonlySet<OcCol> = new Set(["qty", "price", "disc", "total"]);

export type GridKeyInput = {
  key: string;
  /** Ctrl o ⌘. */
  mod: boolean;
  shift: boolean;
  col: OcCol;
  row: number;
  rowCount: number;
  /** ¿La fila está en blanco? */
  rowBlank: boolean;
  /** ¿La fila siguiente existe y está en blanco? */
  nextRowBlank: boolean;
  /** ¿El input con el foco está vacío? */
  inputEmpty: boolean;
  /** ¿La lista del buscador de insumos está abierta? */
  listOpen: boolean;
};

export type GridKeyAction =
  | { kind: "none" }
  | { kind: "submit" }
  | { kind: "addBelow"; row: number }
  | { kind: "focus"; row: number; col: OcCol }
  | { kind: "remove"; row: number; focusRow: number };

/**
 * Teclas de la tabla de productos (pura, para probarla sin DOM):
 *  · Enter: fila nueva debajo con el foco en su insumo (o la siguiente si
 *    ya está en blanco); en una fila en blanco no hace nada.
 *  · Ctrl/⌘ + Enter: crear la orden.
 *  · Retroceso en el insumo vacío de una fila en blanco: la quita y sube.
 *  · ↑/↓ en cantidad, precio, descuento y total: misma columna, otra fila.
 * Con la lista del buscador abierta, Enter y las flechas son del buscador.
 */
export function gridKeyAction(i: GridKeyInput): { action: GridKeyAction; preventDefault: boolean } {
  const none = { action: { kind: "none" } as GridKeyAction, preventDefault: false };
  if (i.key === "Enter") {
    if (i.mod) return { action: { kind: "submit" }, preventDefault: true };
    if (i.listOpen || i.shift) return none;
    if (i.rowBlank) return { action: { kind: "none" }, preventDefault: true };
    if (i.nextRowBlank) return { action: { kind: "focus", row: i.row + 1, col: "item" }, preventDefault: true };
    return { action: { kind: "addBelow", row: i.row }, preventDefault: true };
  }
  if (i.key === "Backspace") {
    if (i.col === "item" && i.inputEmpty && i.rowBlank && i.rowCount > 1) {
      return { action: { kind: "remove", row: i.row, focusRow: Math.max(0, i.row - 1) }, preventDefault: true };
    }
    return none;
  }
  if ((i.key === "ArrowDown" || i.key === "ArrowUp") && TEXT_COLS.has(i.col) && !i.mod && !i.shift) {
    const row = i.row + (i.key === "ArrowDown" ? 1 : -1);
    if (row < 0 || row >= i.rowCount) return none;
    return { action: { kind: "focus", row, col: i.col }, preventDefault: true };
  }
  return none;
}

/* ──────────────────────── Buscador de insumos ──────────────────────── */

export type OcOption = {
  ingredient: OcIngredient;
  supplierItem: OcSupplierItem | null;
  history: SupplierHistoryItem | null;
  /** ¿Está en la lista de precios o ya se le pidió a este proveedor? */
  fromSupplier: boolean;
};

/** Todos los insumos activos, con lo que este proveedor sabe de cada uno. */
export function ingredientOptions(catalog: OcCatalog): OcOption[] {
  const items = new Map(catalog.priceList.map((i) => [i.ingredient.id, i]));
  const hist = new Map(catalog.history.map((h) => [h.ingredientId, h]));
  return catalog.ingredients.map((ingredient) => {
    const supplierItem = items.get(ingredient.id) ?? null;
    const history = hist.get(ingredient.id) ?? null;
    return { ingredient, supplierItem, history, fromSupplier: supplierItem != null || history != null };
  });
}

const collator = new Intl.Collator("es", { sensitivity: "base", numeric: true });

/**
 * Opciones para lo escrito: primero lo de ESTE proveedor (lista de precios
 * y lo que ya se le pidió, lo más pedido arriba), después el resto de los
 * insumos. Busca sin tildes, por nombre y por presentación.
 */
export function rankOptions(options: readonly OcOption[], query: string, limit = 50): OcOption[] {
  const hasQuery = foldSearchText(query) !== "";
  const scored: { o: OcOption; tier: number }[] = [];
  for (const o of options) {
    if (!hasQuery) {
      scored.push({ o, tier: 0 });
      continue;
    }
    const tier = supplierMatchTier(
      { id: o.ingredient.id, name: o.ingredient.name, aliases: o.supplierItem ? [o.supplierItem.presentationLabel] : [] },
      query,
    );
    if (tier !== null) scored.push({ o, tier });
  }
  scored.sort(
    (a, b) =>
      Number(b.o.fromSupplier) - Number(a.o.fromSupplier) ||
      a.tier - b.tier ||
      (b.o.history?.orders ?? 0) - (a.o.history?.orders ?? 0) ||
      collator.compare(a.o.ingredient.name, b.o.ingredient.name),
  );
  return scored.slice(0, limit).map((s) => s.o);
}

/** Insumo cuyo nombre es exactamente lo escrito (sin tildes), si hay uno solo. */
export function exactOption(options: readonly OcOption[], text: string): OcOption | null {
  const needle = foldSearchText(text);
  if (!needle) return null;
  const hits = options.filter((o) => foldSearchText(o.ingredient.name) === needle);
  return hits.length === 1 ? hits[0]! : null;
}

/* ─────────────────── Habituales y sugeridos por reorden ────────────── */

/**
 * Filas nuevas para insumos (en orden), saltando los que ya están en la
 * orden. Cada una con lo que se recuerda del proveedor (pickIngredient) y,
 * si se da, la cantidad/presentación pedida.
 */
export function linesForIngredients(
  existing: readonly OcLine[],
  picks: readonly { ingredientId: string; presentations?: number | null }[],
  catalog: OcCatalog,
  fmt: DraftFmt = DEFAULT_FMT,
): { lines: OcLine[]; added: number; skipped: number } {
  const have = new Set(existing.filter((l) => l.ingredient).map((l) => l.ingredient!.id));
  const byId = new Map(catalog.ingredients.map((i) => [i.id, i]));
  let key = nextKey(existing);
  const added: OcLine[] = [];
  let skipped = 0;
  for (const p of picks) {
    const ing = byId.get(p.ingredientId);
    if (!ing || have.has(ing.id)) {
      skipped += 1;
      continue;
    }
    have.add(ing.id);
    let line = pickIngredient(blankLine(key++), ing, catalog, fmt);
    if (p.presentations != null && line.supplierItem) {
      line = { ...changeUnit(line, PRES, fmt), qtyRaw: String(p.presentations), totalRaw: null };
      if (line.supplierItem!.lastPriceCents != null) {
        line = { ...line, priceRaw: centsToRaw(line.supplierItem!.lastPriceCents), priceSource: "list" };
      }
    }
    added.push(line);
  }
  // Las filas en blanco del final quedan al final.
  const filled = existing.filter((l) => !isBlankLine(l));
  const blanks = existing.filter((l) => isBlankLine(l));
  return { lines: [...filled, ...added, ...blanks], added: added.length, skipped };
}
