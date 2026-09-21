/**
 * Estado de resultado (por período o ejercicio) — lógica pura. Portado de
 * zenith `lib/resultados-report.ts` (`summarizeResultados` +
 * `buildResultadosReport`) y `resultados/resultado-groups.ts` (bandas).
 *
 * ── Entrada ─────────────────────────────────────────────────────────────
 * Movimientos Σ débito − crédito por cuenta y mes (`yyyy-mm`) de las
 * cuentas ingreso / costo / gasto (+ patrimonio `38*` para el ORI en CO)
 * del rango, EXCLUYENDO los asientos de cierre y sus reversas: el cierre
 * no es un hecho económico, es la reclasificación de los saldos al
 * patrimonio, y un estado de resultado que lo incluyera daría cero. La
 * exclusión la hace SQL en `queries.loadResultMovements`.
 *
 * ── Reglas (`summarizeResultados`) ──────────────────────────────────────
 *   income = −Σ ingreso; cost = Σ costo; allExpenses = Σ gasto
 *   incomeTax = CO ? Σ gasto 54* : 0; expenses = allExpenses − incomeTax
 *   result = income − cost − allExpenses
 *   ori = CO ? −Σ patrimonio 38* : 0; integral = result + ori
 *
 * ── Cascada colombiana ──────────────────────────────────────────────────
 * Ingresos de actividades ordinarias (41) · Ingresos financieros (4210) ·
 * Otros ingresos (resto de la clase 4) → Costos reconocidos (6/7) → Gastos
 * POR NATURALEZA (subgrupos 51xx/52xx agregados por los dígitos 3-4, con el
 * nombre de la cuenta `51xx` del plan: 5105 + 5205 → «Gastos de personal»)
 * → Costos financieros (5305) → Otros gastos (resto de 5 sin 54) →
 * «Resultado antes de impuestos» → Impuesto a las ganancias (54) →
 * «Resultado del período» → Otro resultado integral (38) → «Resultado
 * integral total». Fuera de Colombia, secciones genéricas por tipo.
 *
 * Convención de la cascada: lo que RESTA llega NEGATIVO, así cada subtotal
 * es la suma visible de sus líneas.
 *
 * ── Bandas ──────────────────────────────────────────────────────────────
 * Presentación pura (`groupRuns` de zenith): «Ingresos», «Gastos de
 * administración y ventas (por naturaleza)» y «Otros ingresos y gastos no
 * operacionales» recogen TIRADAS CONSECUTIVAS de renglones; su cifra es la
 * suma exacta de sus hijas y ningún subtotal calculado cae dentro de una
 * banda. Con menos de dos hijas, la banda no aparece y las hijas salen
 * sueltas en su sitio.
 */
import type { StatementLabel } from "./statementLabel";

export type ResultMovement = {
  accountCode: string;
  /** `yyyy-mm` del asiento (UTC). */
  month: string;
  /** Σ débito − crédito del mes. */
  movementCents: number;
};

export type ResultAccountInput = {
  code: string;
  name: string;
  type: string;
};

export type IncomeSummary = {
  incomeCents: number;
  costCents: number;
  /** Gastos SIN el impuesto a las ganancias. */
  expensesCents: number;
  incomeTaxCents: number;
  resultCents: number;
  oriCents: number;
  integralCents: number;
};

export type IncomeMonth = IncomeSummary & {
  /** `yyyy-mm`. */
  key: string;
  from: string;
  to: string;
  /** El rango corta el mes (no es un mes completo). */
  partial: boolean;
};

export type CascadeRow =
  | { type: "head"; key: string; label: StatementLabel }
  | { type: "note"; key: string; label: StatementLabel }
  | { type: "line"; key: string; label: StatementLabel; valueCents: number; code?: string }
  | { type: "subtotal"; key: string; label: StatementLabel; valueCents: number }
  | { type: "total"; key: string; label: StatementLabel; valueCents: number };

export type StatementRowVariant = "line" | "group" | "subtotal" | "total" | "head" | "note";

/** Renglón del árbol ya aplanado (con bandas), listo para `StatementTree`. */
export type StatementRow = {
  key: string;
  variant: StatementRowVariant;
  code: string;
  label: StatementLabel;
  /** Null en encabezados y notas. */
  valueCents: number | null;
  depth: number;
  ancestors: string[];
  hasChildren: boolean;
};

export type IncomeClassification = "co" | "generic";

export type IncomeStatement = {
  period: { desde: string; hasta: string };
  country: string | null;
  classification: IncomeClassification;
  summary: IncomeSummary;
  /** La cascada plana, en orden de lectura. */
  cascade: CascadeRow[];
  /** La cascada con bandas, aplanada para pintar y exportar. */
  rows: StatementRow[];
  months: IncomeMonth[];
  /** Avisos sobre la clasificación (claves del catálogo). */
  issues: StatementLabel[];
  /** Hubo al menos una cuenta con líneas en el rango. */
  hasMovements: boolean;
};

type Kind = "ingreso" | "costo" | "gasto" | "patrimonio" | "otro";

const KIND_BY_CLASS: Record<string, Kind> = {
  "3": "patrimonio",
  "4": "ingreso",
  "5": "gasto",
  "6": "costo",
  "7": "costo",
};

function kindOf(code: string, types: ReadonlyMap<string, string>): Kind {
  const t = types.get(code);
  if (t === "ingreso" || t === "costo" || t === "gasto" || t === "patrimonio") return t;
  return KIND_BY_CLASS[code.charAt(0)] ?? "otro";
}

type Classified = ResultMovement & { kind: Kind };

function sum(rows: readonly Classified[], pred: (r: Classified) => boolean): number {
  let s = 0;
  for (const r of rows) if (pred(r)) s += r.movementCents;
  return s;
}

/** Negación sin `-0` (rompe `Object.is` y sale como «-0» en algunos clientes JSON). */
function neg(v: number): number {
  return v === 0 ? 0 : -v;
}

/** Los siete totales del estado a partir de movimientos ya clasificados. */
function summarize(rows: readonly Classified[], co: boolean): IncomeSummary {
  const incomeCents = neg(sum(rows, (r) => r.kind === "ingreso"));
  const costCents = sum(rows, (r) => r.kind === "costo");
  const allExpenses = sum(rows, (r) => r.kind === "gasto");
  const incomeTaxCents = co
    ? sum(rows, (r) => r.kind === "gasto" && r.accountCode.startsWith("54"))
    : 0;
  const resultCents = incomeCents - costCents - allExpenses;
  const oriCents = co
    ? neg(sum(rows, (r) => r.kind === "patrimonio" && r.accountCode.startsWith("38")))
    : 0;
  return {
    incomeCents,
    costCents,
    expensesCents: allExpenses - incomeTaxCents,
    incomeTaxCents,
    resultCents,
    oriCents,
    integralCents: resultCents + oriCents,
  };
}

/**
 * Resumen del estado para un juego de movimientos y un país. Expuesto
 * para los tests y para quien solo necesite las cifras.
 */
export function summarizeIncome(
  movements: readonly ResultMovement[],
  accounts: readonly ResultAccountInput[],
  country: string | null,
): IncomeSummary {
  const types = new Map(accounts.map((a) => [a.code, a.type]));
  const rows = movements.map((m) => ({ ...m, kind: kindOf(m.accountCode, types) }));
  return summarize(rows, country === "CO");
}

/** Bandas del estado (presentación): qué renglones recoge cada una. */
export type BandSpec = { key: string; label: StatementLabel; members: readonly string[] };

export function incomeBands(natureKeys: readonly string[]): BandSpec[] {
  return [
    { key: "g-ingresos", label: { key: "isBandIncome" }, members: ["ing", "ing-fin", "otros-ing"] },
    { key: "g-gastos-oper", label: { key: "isBandOpex" }, members: [...natureKeys] },
    { key: "g-no-oper", label: { key: "isBandNonOp" }, members: ["costos-fin", "otros-gastos"] },
  ];
}

/**
 * Cascada → renglones aplanados con bandas por TIRADAS CONSECUTIVAS. Una
 * banda ocupa exactamente el sitio de los renglones que se lleva dentro;
 * lo que no pertenece a ninguna definición sale intacto en su posición.
 */
export function cascadeToRows(
  cascade: readonly CascadeRow[],
  bands: readonly BandSpec[],
): StatementRow[] {
  const specOf = new Map<string, BandSpec>();
  for (const b of bands) for (const m of b.members) specOf.set(m, b);

  const out: StatementRow[] = [];
  const seen = new Map<BandSpec, number>();
  let run: CascadeRow[] = [];
  let runSpec: BandSpec | null = null;

  const leaf = (r: CascadeRow, depth: number, ancestors: string[]): StatementRow => ({
    key: r.key,
    variant: r.type,
    code: r.type === "line" ? (r.code ?? "") : "",
    label: r.label,
    valueCents: r.type === "head" || r.type === "note" ? null : r.valueCents,
    depth,
    ancestors,
    hasChildren: false,
  });

  const flush = () => {
    if (!runSpec || run.length === 0) {
      run = [];
      runSpec = null;
      return;
    }
    if (run.length < 2) {
      for (const r of run) out.push(leaf(r, 0, []));
    } else {
      const n = seen.get(runSpec) ?? 0;
      seen.set(runSpec, n + 1);
      const key = n === 0 ? runSpec.key : `${runSpec.key}-${n}`;
      let total = 0;
      for (const r of run) if (r.type === "line") total += r.valueCents;
      out.push({
        key,
        variant: "group",
        code: "",
        label: runSpec.label,
        valueCents: total,
        depth: 0,
        ancestors: [],
        hasChildren: true,
      });
      for (const r of run) out.push(leaf(r, 1, [key]));
    }
    run = [];
    runSpec = null;
  };

  for (const r of cascade) {
    const spec = specOf.get(r.key);
    if (spec && spec === runSpec) {
      run.push(r);
      continue;
    }
    flush();
    if (spec) {
      runSpec = spec;
      run = [r];
    } else {
      out.push(leaf(r, 0, []));
    }
  }
  flush();
  return out;
}

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

function lastDayOf(month: string): string {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${month}-${String(d).padStart(2, "0")}`;
}

function nextMonth(month: string): string {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(Date.UTC(y, m, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** Los meses del rango, con el resumen de cada uno y si el rango lo corta. */
function buildMonths(rows: readonly Classified[], from: string, to: string, co: boolean): IncomeMonth[] {
  const out: IncomeMonth[] = [];
  const last = to.slice(0, 7);
  for (let key = from.slice(0, 7); key <= last; key = nextMonth(key)) {
    const end = lastDayOf(key);
    const monthFrom = key === from.slice(0, 7) ? from : `${key}-01`;
    const monthTo = end > to ? to : end;
    out.push({
      ...summarize(
        rows.filter((r) => r.month === key),
        co,
      ),
      key,
      from: monthFrom,
      to: monthTo,
      partial: monthFrom !== `${key}-01` || monthTo !== end,
    });
  }
  return out;
}

export function buildIncomeStatement({
  movements,
  accounts,
  country,
  from,
  to,
}: {
  movements: readonly ResultMovement[];
  /** Plan de cuentas (tipos y nombres; los `51xx` rotulan las naturalezas). */
  accounts: readonly ResultAccountInput[];
  country: string | null;
  /** `yyyy-mm-dd`, ambos incluidos. */
  from: string;
  to: string;
}): IncomeStatement {
  if (from > to) throw new Error("period");
  for (const m of movements) {
    if (!MONTH_RE.test(m.month) || m.month < from.slice(0, 7) || m.month > to.slice(0, 7)) {
      throw new Error(`movement_out_of_period:${m.accountCode}:${m.month}`);
    }
  }
  const co = country === "CO";
  const types = new Map<string, string>();
  const names = new Map<string, string>();
  for (const a of accounts) {
    types.set(a.code, a.type);
    names.set(a.code, a.name);
  }
  const rows: Classified[] = movements.map((m) => ({ ...m, kind: kindOf(m.accountCode, types) }));
  const summary = summarize(rows, co);

  const issues: StatementLabel[] = [];
  if (!co) issues.push({ key: "isIssueGeneric" });
  if (
    co &&
    rows.some(
      (r) =>
        (r.kind === "ingreso" && !r.accountCode.startsWith("4")) ||
        (r.kind === "gasto" && !r.accountCode.startsWith("5")) ||
        (r.kind === "costo" && !/^[67]/.test(r.accountCode)),
    )
  ) {
    issues.push({ key: "isIssueOutOfPrefix" });
  }

  const cascade: CascadeRow[] = [];
  const natureKeys: string[] = [];
  const line = (key: string, label: StatementLabel, valueCents: number, code?: string) =>
    cascade.push({ type: "line", key, label, valueCents, ...(code ? { code } : {}) });

  if (co) {
    const ordinary = neg(sum(rows, (r) => r.kind === "ingreso" && r.accountCode.startsWith("41")));
    const financial = neg(sum(rows, (r) => r.kind === "ingreso" && r.accountCode.startsWith("4210")));
    const other = summary.incomeCents - ordinary - financial;
    line("ing", { key: "isIncomeOrdinary" }, ordinary, "41");
    if (financial !== 0) line("ing-fin", { key: "isIncomeFinancial" }, financial, "4210");
    if (other !== 0) line("otros-ing", { key: "isIncomeOther" }, other);
  } else {
    line("ing", { key: "isIncomeGeneric" }, summary.incomeCents);
  }

  line("costo-inv", { key: "isCosts" }, neg(summary.costCents));

  if (co) {
    // Gastos por naturaleza: 51xx y 52xx se funden por los dígitos 3-4 y
    // se rotulan con la cuenta 51xx del plan (5105 + 5205 → «Gastos de
    // personal»). El residuo de la clase 5 (sin 54) va a «Otros gastos».
    const nature = new Map<string, number>();
    for (const r of rows) {
      if (r.kind !== "gasto" || !/^(51|52)\d{2}/.test(r.accountCode)) continue;
      const sub = r.accountCode.slice(2, 4);
      nature.set(sub, (nature.get(sub) ?? 0) + r.movementCents);
    }
    let natureTotal = 0;
    for (const [sub, value] of [...nature].sort(([a], [b]) => a.localeCompare(b))) {
      natureTotal += value;
      if (value === 0) continue;
      const key = `nat-${sub}`;
      natureKeys.push(key);
      const name = names.get(`51${sub}`);
      line(key, name ? { text: name } : { key: "isNatureFallback", params: { sub } }, neg(value), `x${sub}`);
    }
    const financial = sum(rows, (r) => r.kind === "gasto" && r.accountCode.startsWith("5305"));
    if (financial !== 0) line("costos-fin", { key: "isFinancialCosts" }, neg(financial), "5305");
    const otherExpenses = summary.expensesCents - natureTotal - financial;
    if (otherExpenses !== 0) line("otros-gastos", { key: "isExpensesOther" }, neg(otherExpenses));
    cascade.push({
      type: "subtotal",
      key: "antes-imp",
      label: { key: "isBeforeTax" },
      valueCents: summary.resultCents + summary.incomeTaxCents,
    });
    line("imp", { key: "isIncomeTax" }, neg(summary.incomeTaxCents), "54");
  } else {
    line("otros-gastos", { key: "isExpensesGeneric" }, neg(summary.expensesCents));
  }

  cascade.push({
    type: "subtotal",
    key: "neto",
    label: { key: summary.resultCents < 0 ? "isResultLoss" : "isResult" },
    valueCents: summary.resultCents,
  });

  if (co) {
    cascade.push({ type: "head", key: "ori-head", label: { key: "isOriHead" } });
    if (summary.oriCents !== 0) line("ori", { key: "isOri" }, summary.oriCents, "38");
    else cascade.push({ type: "note", key: "ori-nota", label: { key: "isOriNone" } });
    cascade.push({
      type: "total",
      key: "integral",
      label: { key: "isIntegral" },
      valueCents: summary.integralCents,
    });
  }

  return {
    period: { desde: from, hasta: to },
    country,
    classification: co ? "co" : "generic",
    summary,
    cascade,
    rows: cascadeToRows(cascade, co ? incomeBands(natureKeys) : []),
    months: buildMonths(rows, from, to, co),
    issues,
    hasMovements: movements.length > 0,
  };
}

/**
 * Filas del CSV (Sección, Código, Concepto, Valor): TODOS los renglones con
 * cifra —bandas, líneas, subtotales y total—, esté plegado o no en
 * pantalla. La sección es el último encabezado leído («Otro resultado
 * integral»); las notas sin cifra se omiten.
 */
export function incomeStatementCsvRows(
  stmt: IncomeStatement,
  labelOf: (label: StatementLabel) => string,
): (string | number)[][] {
  const out: (string | number)[][] = [];
  let section = "";
  for (const r of stmt.rows) {
    if (r.variant === "head") {
      section = labelOf(r.label);
      continue;
    }
    if (r.variant === "note" || r.valueCents == null) continue;
    out.push([section, r.code, labelOf(r.label), r.valueCents]);
  }
  return out;
}
