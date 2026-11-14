// Conciliación de las columnas de impuesto de una factura de compra leída
// con IA — LÓGICA PURA, sin BD ni IA.
//
// La IA TRANSCRIBE el valor de cada celda de impuesto (IVA, consumo / ICO /
// INC) tal cual, sin multiplicar ni dividir, y da su hipótesis de qué
// significa la columna. Aquí se decide con aritmética:
//
//  · "unit"    → el valor es POR UNIDAD: impuesto de la línea = valor × cantidad.
//  · "line"    → el valor ya es el TOTAL de la línea.
//  · "percent" → el valor es una TARIFA: impuesto = base neta de la línea × %.
//
// Se prueban las hipótesis contra el pie de la factura (IVA / impuesto al
// consumo impresos); si el pie no trae ese impuesto, contra el total general
// (subtotal − descuentos + IVA + consumo − retenciones + ajustes = total); y
// para el IVA, también contra su tarifa línea por línea. Una sola lectura que
// cuadra → se aplica. Ninguna, varias distintas o nada contra qué comparar →
// la factura queda «por revisar»; la hipótesis de la IA solo preselecciona.
//
// Encabezados que no dicen "unitario" (p. ej. «ICO» de licores, que es un
// valor fijo por unidad) son justamente el caso que esto resuelve: el pie
// manda, no el nombre de la columna.
import { parseInvoiceTaxPct, type InvoiceTaxBasis } from "./invoiceAmounts";

export const TAX_CELL_SCOPES = ["unit", "line", "percent"] as const;
export type TaxCellScope = (typeof TAX_CELL_SCOPES)[number];
export type TaxColumnKey = "iva" | "consumo";
export type TaxColumnStatus =
  /** Una sola lectura cuadra con el pie / el total / la tarifa. */
  | "matched"
  /** Todas las lecturas dan lo mismo (p. ej. todas las cantidades son 1). */
  | "equivalent"
  /** Más de una lectura cuadra y dan montos distintos. */
  | "ambiguous"
  /** Ninguna lectura cuadra. */
  | "mismatch"
  /** No hay pie ni total contra qué comparar. */
  | "unverified";

/** Valor impreso en la celda de impuesto de UNA línea, sin interpretar. */
export type TaxCell = {
  /** Monto impreso en centavos (null si la celda es una tarifa con «%»). */
  cents: number | null;
  /** Tarifa impresa con «%» (0–100), null si no la trae. */
  pct: number | null;
  /** Celda impresa pero ilegible: exige revisión manual de esa línea. */
  invalid?: boolean;
};

export type TaxColumnHypothesis = {
  header: string | null;
  scope: TaxCellScope | "unknown";
  evidence: string | null;
};

export type TaxColumnResolution = {
  header: string | null;
  aiScope: TaxCellScope | "unknown";
  aiEvidence: string | null;
  /** Lecturas que se pueden calcular con lo impreso (las del control). */
  options: TaxCellScope[];
  /** Lecturas que cuadran con la evidencia. */
  candidates: TaxCellScope[];
  status: TaxColumnStatus;
  /** Lectura aplicada (preseleccionada en la revisión); null = sin decidir. */
  scope: TaxCellScope | null;
  /** Impuesto impreso en el pie para esta columna, si lo hay. */
  printedCents: number | null;
  /** Σ de la columna con la lectura aplicada (null si no se puede sumar). */
  computedCents: number | null;
};

export type ReconcileLine = {
  quantity: number;
  unitPriceCents: number | null;
  lineTotalCents: number | null;
  unitPriceTaxBasis?: InvoiceTaxBasis;
  lineTotalTaxBasis?: InvoiceTaxBasis;
  taxPct?: string | null;
  lineDiscountCents?: number | null;
  lineTaxCell?: TaxCell | null;
  lineIncCell?: TaxCell | null;
};

export type ReconcileDocument = {
  lines: ReconcileLine[];
  invoiceSubtotalCents?: number | null;
  invoiceDiscountCents?: number | null;
  invoiceTaxCents?: number | null;
  invoiceIncCents?: number | null;
  retefuenteCents?: number | null;
  reteIvaCents?: number | null;
  reteIcaCents?: number | null;
  /** «Ajustes» / ajuste al peso impreso, con su signo. */
  invoiceAdjustmentCents?: number | null;
  invoiceTotalCents?: number | null;
};

const MAX_CENTS = 2_000_000_000;
/** Holgura global: un pie impreso en pesos enteros. */
const GLOBAL_TOLERANCE = 100;
/** Tope de un «ajuste al peso» que se acepta como redondeo (1.000 en la moneda). */
export const ROUNDING_MAX_CENTS = 100_000;
const validCents = (value: number | null | undefined): value is number =>
  value != null && Number.isSafeInteger(value) && Math.abs(value) <= MAX_CENTS;
const positive = (value: number | null | undefined) => (validCents(value) && value > 0 ? value : 0);

/** Un valor impreso en pesos enteros admite el redondeo del proveedor. */
function granularity(cents: number): number {
  return cents % 100 === 0 ? 100 : 1;
}

/** Tolerancia de cantidad × unitario frente al total de la línea. */
function arithmeticTolerance(unitCents: number, quantity: number): number {
  return Math.ceil((quantity * granularity(unitCents)) / 2) + 1;
}

/**
 * Base neta de la línea, sin depender de los impuestos: el total impreso si
 * cuadra con cantidad × unitario (− descuento); si no, cantidad × unitario.
 * Null si solo hay importes con impuestos incluidos.
 */
export function reconcileLineNetCents(line: ReconcileLine): number | null {
  const quantity = line.quantity;
  if (!Number.isFinite(quantity) || quantity <= 0) return null;
  const discount = positive(line.lineDiscountCents);
  const unit = line.unitPriceCents;
  const total = line.lineTotalCents;
  const unitNet = validCents(unit) && line.unitPriceTaxBasis !== "gross" ? unit : null;
  const fromUnit = unitNet != null ? [Math.round(unitNet * quantity) - discount, Math.round(unitNet * quantity)] : [];
  if (validCents(total) && line.lineTotalTaxBasis !== "gross") {
    if (!fromUnit.length || fromUnit.some(base => Math.abs(base - total) <= arithmeticTolerance(unitNet!, quantity))) {
      return total;
    }
  }
  const net = fromUnit[0];
  return net != null && validCents(net) && net >= 0 ? net : null;
}

export type LineArithmetic = {
  /**
   * consistent: cantidad × unitario (− descuento) = total de la línea.
   * taxes_included: el total de la línea trae además el IVA y el consumo.
   * mismatch: no cuadra (diffCents = total impreso − cantidad × unitario).
   * unchecked: falta el unitario o el total.
   */
  status: "consistent" | "taxes_included" | "mismatch" | "unchecked";
  diffCents: number | null;
};

/** Verifica una línea: cantidad × unitario frente al total impreso. */
export function lineArithmetic(
  line: ReconcileLine,
  taxCents: number | null | undefined,
  incCents: number | null | undefined,
): LineArithmetic {
  const { quantity, unitPriceCents: unit, lineTotalCents: total } = line;
  if (!validCents(unit) || !validCents(total) || !Number.isFinite(quantity) || quantity <= 0) {
    return { status: "unchecked", diffCents: null };
  }
  const whole = Math.round(unit * quantity);
  const discount = positive(line.lineDiscountCents);
  const bases = discount > 0 ? [whole - discount, whole] : [whole];
  const tolerance = arithmeticTolerance(unit, quantity);
  if (bases.some(base => Math.abs(base - total) <= tolerance)) return { status: "consistent", diffCents: 0 };
  const taxes = positive(taxCents) + positive(incCents);
  if (taxes > 0 && bases.some(base => Math.abs(base + taxes - total) <= tolerance + quantity + 1)) {
    return { status: "taxes_included", diffCents: 0 };
  }
  return { status: "mismatch", diffCents: total - bases[0]! };
}

function cellOf(line: ReconcileLine, key: TaxColumnKey): TaxCell | null {
  return (key === "iva" ? line.lineTaxCell : line.lineIncCell) ?? null;
}

function hasPrintedCells(doc: ReconcileDocument, key: TaxColumnKey): boolean {
  return doc.lines.some(line => cellOf(line, key) != null);
}

/** La lectura «%» solo es posible si las celdas son tarifas. */
function percentAllowed(doc: ReconcileDocument, key: TaxColumnKey, hypothesis?: TaxColumnHypothesis | null): boolean {
  const cells = doc.lines.map(line => cellOf(line, key)).filter((cell): cell is TaxCell => cell != null && !cell.invalid);
  if (!cells.length) return false;
  if (cells.every(cell => cell.pct != null)) return true;
  const declared = hypothesis?.scope === "percent" || /%/.test(hypothesis?.header ?? "");
  return declared && cells.every(cell => cell.pct != null || (cell.cents != null && cell.cents >= 0 && cell.cents <= 10_000));
}

function cellPct(cell: TaxCell): number | null {
  if (cell.pct != null) return cell.pct;
  return cell.cents != null && cell.cents >= 0 && cell.cents <= 10_000 ? cell.cents / 100 : null;
}

/** Impuesto de UNA línea con una lectura (null = no se puede calcular). */
export function taxCellLineAmount(
  cell: TaxCell | null | undefined,
  scope: TaxCellScope,
  quantity: number,
  netCents: number | null,
): number | null {
  if (cell == null) return 0;
  if (cell.invalid || !Number.isFinite(quantity) || quantity <= 0) return null;
  let amount: number | null;
  if (scope === "percent") {
    const pct = cellPct(cell);
    amount = pct == null || netCents == null ? null : Math.round((netCents * pct) / 100);
  } else if (cell.cents == null) {
    amount = null;
  } else {
    amount = scope === "unit" ? Math.round(cell.cents * quantity) : cell.cents;
  }
  return amount != null && validCents(amount) && amount >= 0 ? amount : null;
}

/** Holgura de redondeo de una línea con esa lectura. */
function lineTolerance(cell: TaxCell | null, scope: TaxCellScope, quantity: number): number {
  if (cell == null || cell.cents == null || scope === "percent") return 1;
  const step = granularity(cell.cents);
  return scope === "unit" ? Math.ceil((quantity * step) / 2) + 1 : Math.ceil(step / 2) + 1;
}

function columnTolerance(doc: ReconcileDocument, key: TaxColumnKey, scope: TaxCellScope): number {
  return doc.lines.reduce((sum, line) => sum + lineTolerance(cellOf(line, key), scope, line.quantity), GLOBAL_TOLERANCE);
}

/** IVA por tarifa de cada línea (null si falta la tarifa o la base). */
function rateAmounts(doc: ReconcileDocument): (number | null)[] {
  return doc.lines.map(line => {
    const pct = parseInvoiceTaxPct(line.taxPct);
    const net = reconcileLineNetCents(line);
    return pct == null || net == null ? null : Math.round((net * pct) / 100);
  });
}

const sum = (values: readonly (number | null)[]): number | null =>
  values.some(value => value == null) ? null : values.reduce<number>((total, value) => total + value!, 0);

function rawColumnAmounts(doc: ReconcileDocument, key: TaxColumnKey, scope: TaxCellScope): (number | null)[] {
  return doc.lines.map(line => taxCellLineAmount(cellOf(line, key), scope, line.quantity, reconcileLineNetCents(line)));
}

/**
 * Impuesto TOTAL de cada línea para una columna con la lectura dada. Es la
 * misma cuenta en la lectura (servidor) y al cambiar el control en la
 * revisión (cliente).
 *
 * IVA: si el pie lo imprime y el IVA por tarifa de cada línea queda dentro
 * del redondeo de lo impreso (p. ej. «IVA unitario» × cantidad) y además
 * cuadra mejor con el pie, se usa el de la tarifa: es como el proveedor lo
 * liquidó, y así el IVA guardado es el del pie al centavo.
 */
export function columnLineAmounts(
  doc: ReconcileDocument,
  key: TaxColumnKey,
  scope: TaxCellScope,
): (number | null)[] {
  const amounts = rawColumnAmounts(doc, key, scope);
  const printed = doc.invoiceTaxCents;
  if (key !== "iva" || scope === "percent" || !validCents(printed)) return amounts;
  const rates = rateAmounts(doc);
  const total = sum(amounts);
  const rateTotal = sum(rates);
  if (total == null || rateTotal == null || Math.abs(rateTotal - printed) >= Math.abs(total - printed)) return amounts;
  const close = doc.lines.every((line, index) =>
    Math.abs(rates[index]! - amounts[index]!) <= lineTolerance(cellOf(line, key), scope, line.quantity));
  return close ? rates : amounts;
}

const sameAmounts = (left: readonly (number | null)[], right: readonly (number | null)[]) =>
  left.length === right.length && left.every((value, index) => value === right[index]);

/** Agrupa lecturas que producen exactamente los mismos montos. */
function distinctGroups(doc: ReconcileDocument, key: TaxColumnKey, scopes: readonly TaxCellScope[]): TaxCellScope[][] {
  const groups: { amounts: (number | null)[]; scopes: TaxCellScope[] }[] = [];
  for (const scope of scopes) {
    const amounts = rawColumnAmounts(doc, key, scope);
    const group = groups.find(g => sameAmounts(g.amounts, amounts));
    if (group) group.scopes.push(scope);
    else groups.push({ amounts, scopes: [scope] });
  }
  return groups.map(group => group.scopes);
}

const PREFERENCE: TaxCellScope[] = ["line", "unit", "percent"];
function pick(ai: TaxCellScope | "unknown", among: readonly TaxCellScope[]): TaxCellScope | null {
  if (ai !== "unknown" && among.includes(ai)) return ai;
  return PREFERENCE.find(scope => among.includes(scope)) ?? null;
}

type ColumnState = {
  key: TaxColumnKey;
  hypothesis: TaxColumnHypothesis;
  options: TaxCellScope[];
  hasInvalid: boolean;
  printed: number | null;
};

function columnState(doc: ReconcileDocument, key: TaxColumnKey, hypothesis: TaxColumnHypothesis | null | undefined): ColumnState | null {
  if (!hasPrintedCells(doc, key)) return null;
  const hasInvalid = doc.lines.some(line => cellOf(line, key)?.invalid === true);
  const allowPercent = percentAllowed(doc, key, hypothesis);
  const options = TAX_CELL_SCOPES.filter(scope => (scope !== "percent" || allowPercent)
    && doc.lines.every(line => {
      const cell = cellOf(line, key);
      return cell == null || cell.invalid === true
        || taxCellLineAmount(cell, scope, line.quantity, reconcileLineNetCents(line)) != null;
    }));
  const printed = key === "iva" ? doc.invoiceTaxCents : doc.invoiceIncCents;
  return {
    key,
    hypothesis: hypothesis ?? { header: null, scope: "unknown", evidence: null },
    options,
    hasInvalid,
    printed: validCents(printed) && printed >= 0 ? printed : null,
  };
}

/** Σ de la columna con esa lectura; sin celdas, lo que diga el pie. */
function columnTotal(doc: ReconcileDocument, state: ColumnState | null, key: TaxColumnKey, scope: TaxCellScope | null): number | null {
  if (state == null) {
    if (key === "iva") return validCents(doc.invoiceTaxCents) ? doc.invoiceTaxCents : sum(rateAmounts(doc));
    return validCents(doc.invoiceIncCents) ? doc.invoiceIncCents : 0;
  }
  if (scope == null || state.hasInvalid) return null;
  return sum(columnLineAmounts(doc, key, scope));
}

/** Bases posibles del total general: el subtotal impreso puede venir antes o después del descuento. */
function totalBases(doc: ReconcileDocument): number[] {
  const subtotal = doc.invoiceSubtotalCents;
  const discount = positive(doc.invoiceDiscountCents);
  if (validCents(subtotal)) return discount > 0 ? [subtotal - discount, subtotal] : [subtotal];
  const net = sum(doc.lines.map(reconcileLineNetCents));
  return net == null ? [] : [net];
}

function retentionCents(doc: ReconcileDocument): number {
  return positive(doc.retefuenteCents) + positive(doc.reteIvaCents) + positive(doc.reteIcaCents);
}

function adjustmentCents(doc: ReconcileDocument): number {
  const adjustment = doc.invoiceAdjustmentCents;
  return validCents(adjustment) && Math.abs(adjustment) <= ROUNDING_MAX_CENTS ? adjustment : 0;
}

/** Diferencia mínima del total general con esa combinación (null si no se puede). */
function totalResidual(doc: ReconcileDocument, iva: number | null, inc: number | null): number | null {
  const total = doc.invoiceTotalCents;
  if (!validCents(total) || iva == null || inc == null) return null;
  const residuals = totalBases(doc).map(base =>
    Math.abs(base + iva + inc - retentionCents(doc) + adjustmentCents(doc) - total));
  return residuals.length ? Math.min(...residuals) : null;
}

/** IVA: cuadra con la tarifa de cada línea donde la lectura cambia algo. */
function rateCandidates(doc: ReconcileDocument, state: ColumnState): { verified: boolean; candidates: TaxCellScope[] } {
  const rates = rateAmounts(doc);
  const discriminating = doc.lines.some((line, index) => {
    const cell = cellOf(line, "iva");
    return cell != null && !cell.invalid && (cell.cents ?? 0) > 0 && line.quantity !== 1 && rates[index] != null;
  });
  const scopes = state.options.filter(scope => scope !== "percent");
  if (!discriminating || state.hasInvalid || !scopes.length) return { verified: false, candidates: [] };
  const candidates = scopes.filter(scope => {
    const amounts = rawColumnAmounts(doc, "iva", scope);
    return doc.lines.every((line, index) => {
      const cell = cellOf(line, "iva");
      if (cell == null) return true;
      const amount = amounts[index];
      const tolerance = lineTolerance(cell, scope, line.quantity);
      if (amount == null) return false;
      if (rates[index] != null && Math.abs(amount - rates[index]!) <= tolerance) return true;
      // Un total de línea con el IVA incluido (y sin consumo): su base es el
      // total menos ese IVA.
      const pct = parseInvoiceTaxPct(line.taxPct);
      const total = line.lineTotalCents;
      return pct != null && validCents(total) && cellOf(line, "consumo") == null
        && Math.abs(amount - Math.round(((total - amount) * pct) / 100)) <= tolerance;
    });
  });
  return { verified: true, candidates };
}

function resolveOne(
  doc: ReconcileDocument,
  state: ColumnState,
  other: { state: ColumnState | null; key: TaxColumnKey; scopes: (TaxCellScope | null)[] },
): TaxColumnResolution {
  const { key, hypothesis, options } = state;
  const ai = hypothesis.scope;
  const groups = distinctGroups(doc, key, options);
  let status: TaxColumnStatus;
  let candidates: TaxCellScope[] = [];
  let scope: TaxCellScope | null;
  const footerDiff = (s: TaxCellScope) => {
    const total = columnTotal(doc, state, key, s);
    return total == null || state.printed == null ? Infinity : Math.abs(total - state.printed);
  };
  const residualOf = (s: TaxCellScope) => {
    const mine = columnTotal(doc, state, key, s);
    const residuals = other.scopes.map(otherScope => {
      const theirs = columnTotal(doc, other.state, other.key, otherScope);
      return key === "iva" ? totalResidual(doc, mine, theirs) : totalResidual(doc, theirs, mine);
    }).filter((value): value is number => value != null);
    return residuals.length ? Math.min(...residuals) : Infinity;
  };
  const closest = (among: readonly TaxCellScope[], metric: (s: TaxCellScope) => number) =>
    [...among].sort((a, b) => metric(a) - metric(b))[0] ?? null;

  if (!options.length || state.hasInvalid) {
    status = "unverified";
    scope = ai !== "unknown" && options.includes(ai) ? ai : null;
  } else {
    let verified = false;
    let metric: ((s: TaxCellScope) => number) | null = null;
    if (state.printed != null) {
      verified = true;
      metric = footerDiff;
      candidates = options.filter(s => footerDiff(s) <= columnTolerance(doc, key, s));
    } else if (key === "iva" && rateCandidates(doc, state).verified) {
      verified = true;
      candidates = rateCandidates(doc, state).candidates;
    } else if (validCents(doc.invoiceTotalCents) && totalBases(doc).length) {
      const tolerance = (s: TaxCellScope) => columnTolerance(doc, key, s) + (other.state ? columnTolerance(doc, other.key, "unit") : 0);
      const measurable = options.filter(s => residualOf(s) !== Infinity);
      if (measurable.length) {
        verified = true;
        metric = residualOf;
        candidates = measurable.filter(s => residualOf(s) <= tolerance(s));
      }
    }
    if (!verified && groups.length === 1) {
      // Nada contra qué comparar, pero cualquier lectura da lo mismo.
      status = "equivalent";
      candidates = [...options];
      scope = pick(ai, options);
    } else if (!verified) {
      status = "unverified";
      // Sin evidencia, el IVA impreso conserva su sentido histórico (total de
      // la línea); el consumo sin hipótesis queda sin decidir.
      scope = ai !== "unknown" && options.includes(ai) ? ai : key === "iva" ? pick("unknown", options.filter(s => s === "line")) : null;
    } else if (!candidates.length) {
      status = "mismatch";
      scope = ai !== "unknown" && options.includes(ai) ? ai : metric ? closest(options, metric) : pick(ai, options);
    } else if (distinctGroups(doc, key, candidates).length === 1) {
      status = "matched";
      scope = pick(ai, candidates);
    } else {
      status = "ambiguous";
      scope = ai !== "unknown" && candidates.includes(ai) ? ai : metric ? closest(candidates, metric) : pick(ai, candidates);
    }
  }
  return {
    header: hypothesis.header,
    aiScope: ai,
    aiEvidence: hypothesis.evidence,
    options,
    candidates,
    status,
    scope,
    printedCents: state.printed,
    computedCents: columnTotal(doc, state, key, scope),
  };
}

export type ResolvedTaxColumns = { iva: TaxColumnResolution | null; consumo: TaxColumnResolution | null };

/**
 * Decide la lectura de cada columna de impuesto. El consumo se resuelve
 * primero con su propio pie (es el que más varía entre proveedores); si el
 * pie no lo trae, ambas columnas se prueban juntas contra el total general.
 */
export function resolveTaxColumns(
  doc: ReconcileDocument,
  hypotheses: { iva?: TaxColumnHypothesis | null; consumo?: TaxColumnHypothesis | null },
): ResolvedTaxColumns {
  const iva = columnState(doc, "iva", hypotheses.iva);
  const consumo = columnState(doc, "consumo", hypotheses.consumo);
  const scopesOf = (state: ColumnState | null): (TaxCellScope | null)[] =>
    state == null ? [null] : state.options.length ? state.options : [null];
  const first = consumo
    ? resolveOne(doc, consumo, { state: iva, key: "iva", scopes: scopesOf(iva) })
    : null;
  const ivaResolution = iva
    ? resolveOne(doc, iva, { state: consumo, key: "consumo",
      scopes: first && !taxColumnNeedsReview(first) && first.scope ? [first.scope] : scopesOf(consumo) })
    : null;
  // Con el IVA ya decidido, el consumo dudoso se vuelve a probar contra el total.
  const consumoResolution = consumo && first && taxColumnNeedsReview(first)
    && ivaResolution && !taxColumnNeedsReview(ivaResolution) && ivaResolution.scope
    ? resolveOne(doc, consumo, { state: iva, key: "iva", scopes: [ivaResolution.scope] })
    : first;
  return { iva: ivaResolution, consumo: consumoResolution };
}

/**
 * Impuesto TOTAL de cada línea según las lecturas elegidas: `lineTaxCents`
 * (IVA) y `lineIncCents` (consumo). Una celda impresa sin lectura decidida o
 * ilegible deja el consumo de esa línea en null y `lineIncAmbiguous`.
 */
export function applyTaxColumns<T extends ReconcileLine>(
  doc: ReconcileDocument & { lines: T[] },
  scopes: { iva: TaxCellScope | null; consumo: TaxCellScope | null },
): (T & { lineTaxCents: number | null; lineIncCents: number | null; lineIncAmbiguous: boolean })[] {
  const iva = scopes.iva && hasPrintedCells(doc, "iva") ? columnLineAmounts(doc, "iva", scopes.iva) : null;
  const inc = scopes.consumo && hasPrintedCells(doc, "consumo") ? columnLineAmounts(doc, "consumo", scopes.consumo) : null;
  const lines: T[] = doc.lines;
  return lines.map((line, index) => {
    const incCell = line.lineIncCell ?? null;
    const taxCell = line.lineTaxCell ?? null;
    const zeroInc = incCell != null && !incCell.invalid && (incCell.cents === 0 || incCell.pct === 0);
    const lineIncCents = incCell == null ? null : zeroInc ? 0 : inc?.[index] ?? null;
    return {
      ...line,
      lineTaxCents: taxCell == null || taxCell.invalid ? null : iva?.[index] ?? null,
      lineIncCents,
      lineIncAmbiguous: incCell != null && lineIncCents == null,
    };
  });
}

/** ¿La columna necesita que alguien la mire antes de guardar? */
export function taxColumnNeedsReview(column: TaxColumnResolution | null | undefined): boolean {
  return column != null && column.status !== "matched" && column.status !== "equivalent";
}

export type ReconcileRowKey = "subtotal" | "discount" | "iva" | "consumo" | "retentions" | "adjustment" | "total";
export type ReconcileRow = {
  key: ReconcileRowKey;
  /** Lo impreso en la factura (null = no se imprimió o no se leyó). */
  printedCents: number | null;
  /** Lo que MESAPAY va a guardar. */
  computedCents: number;
  /** printed − computed cuando hay impreso; null si no hay con qué comparar. */
  diffCents: number | null;
};

/**
 * «Factura vs MESAPAY»: cada renglón del pie frente a lo que se guardará.
 * Comparación al centavo; el subtotal impreso puede ser antes o después de
 * los descuentos (se compara con el que corresponda).
 */
export function invoiceReconcileRows(
  printed: {
    subtotalCents?: number | null;
    discountCents?: number | null;
    ivaCents?: number | null;
    incCents?: number | null;
    retentionsCents?: number | null;
    adjustmentCents?: number | null;
    totalCents?: number | null;
  },
  computed: {
    listSubtotalCents: number;
    netSubtotalCents: number;
    discountCents: number;
    ivaCents: number;
    incCents: number;
    retentionsCents: number;
    adjustmentCents: number;
    totalCents: number;
  },
): { rows: ReconcileRow[]; hasDifferences: boolean } {
  const printedSubtotal = validCents(printed.subtotalCents) ? printed.subtotalCents : null;
  const subtotal = printedSubtotal != null
    && Math.abs(printedSubtotal - computed.netSubtotalCents) < Math.abs(printedSubtotal - computed.listSubtotalCents)
    ? computed.netSubtotalCents : computed.listSubtotalCents;
  const row = (key: ReconcileRowKey, printedCents: number | null | undefined, computedCents: number): ReconcileRow => {
    const value = validCents(printedCents) ? printedCents : null;
    return { key, printedCents: value, computedCents, diffCents: value == null ? null : value - computedCents };
  };
  const rows = [
    row("subtotal", printedSubtotal, subtotal),
    row("discount", printed.discountCents, computed.discountCents),
    row("iva", printed.ivaCents, computed.ivaCents),
    row("consumo", printed.incCents, computed.incCents),
    row("retentions", printed.retentionsCents, computed.retentionsCents),
    row("adjustment", printed.adjustmentCents, computed.adjustmentCents),
    row("total", printed.totalCents, computed.totalCents),
  ].filter(r => r.key === "subtotal" || r.key === "total" || r.printedCents != null || r.computedCents !== 0);
  return { rows, hasDifferences: rows.some(r => r.diffCents != null && r.diffCents !== 0) };
}

/**
 * Ajuste al peso que haría cuadrar el total, si es un redondeo: la
 * diferencia entre el total impreso y el calculado sin ajuste, solo si cabe
 * en el tope de redondeo. Nunca se reparte entre líneas.
 */
export function suggestedRoundingCents(printedTotalCents: number | null | undefined, totalWithoutAdjustmentCents: number): number | null {
  if (!validCents(printedTotalCents)) return null;
  const diff = printedTotalCents - totalWithoutAdjustmentCents;
  return diff !== 0 && Math.abs(diff) <= ROUNDING_MAX_CENTS ? diff : null;
}
