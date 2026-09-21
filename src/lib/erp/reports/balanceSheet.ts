/**
 * Estado de situación financiera (ESFA) a una FECHA DE CORTE — lógica pura.
 * Portado de zenith `balance/balance-model.ts` + `summarizeStatements`
 * (`packages/domain/src/payments.ts`).
 *
 * ── Universo ────────────────────────────────────────────────────────────
 * El balance es ACUMULATIVO desde el comienzo: la fecha es un «hasta», no
 * un rango. Los saldos llegan ya acotados al corte por
 * `queries.loadBalancesThrough` (Σ débito − crédito por cuenta), y llegan
 * CON los asientos de cierre (`source = "closing"`): el cierre es la
 * reclasificación que salda las clases 4/5/6 contra 3605/3610, así que a
 * una fecha posterior al cierre las cuentas de resultado ya están en cero
 * y la utilidad de los años cerrados vive CONTABILIZADA en el patrimonio.
 * Sumar la «utilidad al vuelo» (ingresos − gastos − costos del universo
 * acotado) como línea del patrimonio no duplica nada: es exactamente el
 * resultado del período ABIERTO. Un saldo acumulado se toma con cierre; un
 * movimiento de período (estado de resultado) sin él.
 *
 * ── Reglas (`summarizeStatements`) ──────────────────────────────────────
 *   activo = Σ tipo activo; pasivo = −Σ pasivo; patrimonio = −Σ patrimonio
 *   ingresos = −Σ ingreso; gastos = Σ gasto; costos = Σ costo
 *   utilidad = ingresos − gastos − costos
 *   totalPatrimonio = patrimonio + utilidad
 *   totalPasivoPatrimonio = pasivo + totalPatrimonio
 *   diff = activo − totalPasivoPatrimonio; balanced = |diff| ≤ 1 centavo
 *
 * ── Presentación ────────────────────────────────────────────────────────
 * Tres árboles (activo | pasivo | patrimonio) con jerarquía PUC vía
 * `pucTree.ts`. `buildPucTree` AGREGA en el último nivel toda hoja más
 * larga, así que el árbol baja hasta la SUBCUENTA (2 → 4 → 6): las cuentas
 * con saldo se ven como hojas y cada nodo es la suma exacta de ellas. La
 * línea «Utilidad del ejercicio» no es una cuenta: va al final del
 * patrimonio, en la raíz y con énfasis, como en zenith.
 */
import { buildPucTree, flattenTree, type FlatRow } from "./pucTree";

/** Comienzo del universo del balance (para el drill-down al mayor). */
export const BALANCE_SHEET_FROM = "1900-01-01";

/** Niveles del árbol: grupo (2), cuenta (4), subcuenta (6). */
export const BALANCE_SHEET_LEVELS: readonly number[] = [2, 4, 6];

export type BalanceInput = {
  accountCode: string;
  /** Σ débito − crédito acumulado hasta el corte (acreedores negativos). */
  balanceCents: number;
};

export type BalanceAccountInput = {
  code: string;
  name: string;
  /** activo | pasivo | patrimonio | ingreso | gasto | costo */
  type: string;
};

export type BalanceSheetRow = {
  key: string;
  /** Vacío en la línea sintética de utilidad. */
  code: string;
  name: string;
  depth: number;
  ancestors: string[];
  hasChildren: boolean;
  /** Normalizado a POSITIVO según la naturaleza de la sección. */
  valueCents: number;
  /** Línea sin cuenta detrás (la utilidad del ejercicio). */
  synthetic: boolean;
  emphasis: boolean;
};

export type BalanceSheetSection = {
  rows: BalanceSheetRow[];
  totalCents: number;
};

export type BalanceSheetTotals = {
  activoCents: number;
  pasivoCents: number;
  /** Clase 3 sin la utilidad del período abierto. */
  patrimonioCents: number;
  ingresosCents: number;
  gastosCents: number;
  costosCents: number;
  /** Resultado del período abierto = ingresos − gastos − costos. */
  utilidadCents: number;
  totalPatrimonioCents: number;
  totalPasivoPatrimonioCents: number;
  /** Activo − (pasivo + patrimonio). Cero a CUALQUIER corte si el libro cuadra. */
  differenceCents: number;
};

export type BalanceSheet = {
  cutoff: string;
  /** Primer día del período abierto (el que rotula la utilidad). */
  openYearStart: string;
  sections: {
    activo: BalanceSheetSection;
    pasivo: BalanceSheetSection;
    patrimonio: BalanceSheetSection;
  };
  totals: BalanceSheetTotals;
  balanced: boolean;
};

export type StatementKind = "activo" | "pasivo" | "patrimonio" | "ingreso" | "gasto" | "costo";

/** Tipo por primer dígito del PUC, para cuentas que el plan no clasifica. */
const KIND_BY_CLASS: Record<string, StatementKind> = {
  "1": "activo",
  "2": "pasivo",
  "3": "patrimonio",
  "4": "ingreso",
  "5": "gasto",
  "6": "costo",
  "7": "costo",
};

/**
 * Clasificación de una cuenta: el `type` del plan manda; si el código no
 * está en el plan (saldo histórico de una cuenta borrada), la clase del
 * PUC decide. Null para lo que no es un tipo de estado (cuentas de orden).
 */
export function statementKindOf(
  code: string,
  types: ReadonlyMap<string, string>,
): StatementKind | null {
  const t = types.get(code);
  if (isStatementKind(t)) return t;
  return KIND_BY_CLASS[code.charAt(0)] ?? null;
}

/** Negación sin `-0` (que rompe `Object.is` y sale como «-0» en JSON de algunos clientes). */
function neg(v: number): number {
  return v === 0 ? 0 : -v;
}

function isStatementKind(v: unknown): v is StatementKind {
  return (
    v === "activo" ||
    v === "pasivo" ||
    v === "patrimonio" ||
    v === "ingreso" ||
    v === "gasto" ||
    v === "costo"
  );
}

/**
 * Primer día del período ABIERTO al corte: 1 de enero del año siguiente al
 * último asiento de cierre con fecha ≤ corte; si no hay ninguno, 1 de
 * enero del año del corte. Se acota AL CORTE (no al último cierre del
 * libro): un balance a 30/06/2025 no puede decir «desde 01/01/2026» por un
 * cierre de diciembre que a esa fecha todavía no existía.
 */
export function openPeriodStart(closingDates: readonly string[], cutoff: string): string {
  const last = closingDates.filter((d) => d <= cutoff).sort().at(-1);
  const year = last ? Number(last.slice(0, 4)) + 1 : Number(cutoff.slice(0, 4));
  return `${String(year).padStart(4, "0")}-01-01`;
}

/** Σ saldos por tipo (firmados tal como llegan). */
export function summarizeBalances(
  balances: readonly BalanceInput[],
  accounts: readonly BalanceAccountInput[],
): Omit<BalanceSheetTotals, "totalPatrimonioCents" | "totalPasivoPatrimonioCents" | "differenceCents"> {
  const types = new Map(accounts.map((a) => [a.code, a.type]));
  const sums: Record<StatementKind, number> = {
    activo: 0,
    pasivo: 0,
    patrimonio: 0,
    ingreso: 0,
    gasto: 0,
    costo: 0,
  };
  for (const b of balances) {
    const kind = statementKindOf(b.accountCode, types);
    if (kind) sums[kind] += b.balanceCents;
  }
  const activoCents = sums.activo;
  const pasivoCents = neg(sums.pasivo);
  const patrimonioCents = neg(sums.patrimonio);
  const ingresosCents = neg(sums.ingreso);
  const gastosCents = sums.gasto;
  const costosCents = sums.costo;
  return {
    activoCents,
    pasivoCents,
    patrimonioCents,
    ingresosCents,
    gastosCents,
    costosCents,
    utilidadCents: ingresosCents - gastosCents - costosCents,
  };
}

/** Cuentas de un tipo con saldo ≠ 0, normalizadas a positivo, en árbol PUC. */
function sectionRows(
  balances: readonly BalanceInput[],
  kind: StatementKind,
  sign: 1 | -1,
  names: Record<string, string>,
  types: ReadonlyMap<string, string>,
): BalanceSheetRow[] {
  const leaves = balances
    .filter((b) => b.balanceCents !== 0 && statementKindOf(b.accountCode, types) === kind)
    .map((b) => ({
      code: b.accountCode,
      name: names[b.accountCode] ?? "",
      values: [sign * b.balanceCents],
    }));
  const tree = buildPucTree(leaves, { levels: BALANCE_SHEET_LEVELS, names });
  return flattenTree(tree).map(toRow);
}

function toRow(r: FlatRow): BalanceSheetRow {
  return {
    key: r.key,
    code: r.code,
    name: r.name,
    depth: r.depth,
    ancestors: r.ancestors,
    hasChildren: r.hasChildren,
    valueCents: r.values[0] ?? 0,
    synthetic: false,
    emphasis: false,
  };
}

/** Llave estable de la línea sintética de utilidad (para el plegado y el CSV). */
export const UTILIDAD_ROW_KEY = "utilidad-ejercicio";

export function buildBalanceSheet({
  balances,
  accounts,
  cutoff,
  openYearStart,
  utilidadLabel,
}: {
  balances: readonly BalanceInput[];
  /** Plan de cuentas (nombres y tipos; prefijos incluidos). */
  accounts: readonly BalanceAccountInput[];
  cutoff: string;
  openYearStart: string;
  /** Rótulo YA TRADUCIDO de la utilidad del ejercicio («… (desde dd/mm/aaaa)»). */
  utilidadLabel: string;
}): BalanceSheet {
  const names: Record<string, string> = {};
  const types = new Map<string, string>();
  for (const a of accounts) {
    names[a.code] = a.name;
    types.set(a.code, a.type);
  }
  const s = summarizeBalances(balances, accounts);

  const activo = sectionRows(balances, "activo", 1, names, types);
  const pasivo = sectionRows(balances, "pasivo", -1, names, types);
  const patrimonio = [
    ...sectionRows(balances, "patrimonio", -1, names, types),
    {
      key: UTILIDAD_ROW_KEY,
      code: "",
      name: utilidadLabel,
      depth: 0,
      ancestors: [],
      hasChildren: false,
      valueCents: s.utilidadCents,
      synthetic: true,
      emphasis: true,
    },
  ];

  const totalPatrimonioCents = s.patrimonioCents + s.utilidadCents;
  const totalPasivoPatrimonioCents = s.pasivoCents + totalPatrimonioCents;
  const differenceCents = s.activoCents - totalPasivoPatrimonioCents;

  return {
    cutoff,
    openYearStart,
    sections: {
      activo: { rows: activo, totalCents: s.activoCents },
      pasivo: { rows: pasivo, totalCents: s.pasivoCents },
      patrimonio: { rows: patrimonio, totalCents: totalPatrimonioCents },
    },
    totals: {
      ...s,
      totalPatrimonioCents,
      totalPasivoPatrimonioCents,
      differenceCents,
    },
    balanced: Math.abs(differenceCents) <= 1,
  };
}

export type BalanceSheetCsvLabels = {
  activo: string;
  pasivo: string;
  patrimonio: string;
  totalActivo: string;
  totalPasivo: string;
  totalPatrimonio: string;
  totalPasivoPatrimonio: string;
};

/**
 * Filas del CSV (Sección, Código, Cuenta, Valor): el árbol COMPLETO de cada
 * sección —esté plegado o no en pantalla— con sus subtotales de grupo y
 * cuenta, el total de la sección y, al final, «Total pasivo + patrimonio».
 * Los montos van como número (= centavos) para `buildReportCsv`.
 */
export function balanceSheetCsvRows(
  bs: BalanceSheet,
  labels: BalanceSheetCsvLabels,
): (string | number)[][] {
  const out: (string | number)[][] = [];
  const section = (name: string, rows: readonly BalanceSheetRow[], totalLabel: string, total: number) => {
    for (const r of rows) out.push([name, r.code, r.name, r.valueCents]);
    out.push([name, "", totalLabel, total]);
  };
  section(labels.activo, bs.sections.activo.rows, labels.totalActivo, bs.sections.activo.totalCents);
  section(labels.pasivo, bs.sections.pasivo.rows, labels.totalPasivo, bs.sections.pasivo.totalCents);
  section(
    labels.patrimonio,
    bs.sections.patrimonio.rows,
    labels.totalPatrimonio,
    bs.sections.patrimonio.totalCents,
  );
  out.push(["", "", labels.totalPasivoPatrimonio, bs.totals.totalPasivoPatrimonioCents]);
  return out;
}
