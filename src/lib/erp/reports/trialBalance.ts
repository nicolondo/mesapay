/**
 * Balance de prueba (lógica pura). Portado de zenith
 * `balance-prueba/trial-balance-model.ts` (vista general; la dimensión
 * tercero/centro queda preparada como `dimension: "none"`).
 *
 * Entrada: una fila por cuenta con saldo, FIRMADA débito − crédito
 * (crédito negativo), tal como la agrega `queries.loadTrialBalanceRows`:
 *   initialCents = Σ (D − C) con fecha < desde
 *   debitCents / creditCents = Σ del rango
 *   finalCents   = Σ (D − C) con fecha ≤ hasta
 *
 * Salida: jerarquía clase → grupo → cuenta → subcuenta (según `level`),
 * donde cada nodo es la suma exacta de sus hojas, más totales y cuadre.
 */
import { buildPucTree, flattenTree, PUC_LEVELS, type FlatRow } from "./pucTree";

export type TrialBalanceDbRow = {
  accountCode: string;
  initialCents: number;
  debitCents: number;
  creditCents: number;
  finalCents: number;
};

export type TrialBalanceLevel = 1 | 2 | 4 | 6;

export type TrialBalanceTotals = {
  initialCents: number;
  debitCents: number;
  creditCents: number;
  finalCents: number;
};

export type TrialBalanceRow = TrialBalanceTotals & {
  key: string;
  code: string;
  name: string;
  /** 0 = clase, 1 = grupo, 2 = cuenta, 3 = subcuenta. */
  depth: number;
  ancestors: string[];
  hasChildren: boolean;
};

export type TrialBalance = {
  level: TrialBalanceLevel;
  rows: TrialBalanceRow[];
  /** Σ hojas del filtro aplicado (o de todo, sin filtro). */
  totals: TrialBalanceTotals;
  /** Σ de TODO el libro, con o sin filtro (lo que mide el cuadre). */
  bookTotals: TrialBalanceTotals;
  /** |Σ débitos − Σ créditos| ≤ 1 centavo, medido sobre TODO el libro. */
  balanced: boolean;
  /** Diferencia Σ débitos − Σ créditos de todo el libro (0 si cuadra). */
  differenceCents: number;
  /** Hay filtro de cuentas: los totales son «del filtro aplicado». */
  filtered: boolean;
  /**
   * Desglose por tercero/centro de costo. TODO: cuando el asiento manual
   * traiga `thirdPartyTaxId` y la línea `costCenterId`, aquí entran
   * `"tercero" | "centro"` con la segunda dimensión colgada de la fila
   * más profunda (ver zenith `buildRows.dims`).
   */
  dimension: "none";
};

export const TRIAL_BALANCE_LEVELS: readonly TrialBalanceLevel[] = [1, 2, 4, 6];

export function parseTrialBalanceLevel(raw: string | undefined | null): TrialBalanceLevel {
  const n = Number(raw);
  return (TRIAL_BALANCE_LEVELS as readonly number[]).includes(n) ? (n as TrialBalanceLevel) : 6;
}

const ZERO: TrialBalanceTotals = { initialCents: 0, debitCents: 0, creditCents: 0, finalCents: 0 };

function sumRows(rows: readonly TrialBalanceDbRow[]): TrialBalanceTotals {
  return rows.reduce(
    (s, r) => ({
      initialCents: s.initialCents + r.initialCents,
      debitCents: s.debitCents + r.debitCents,
      creditCents: s.creditCents + r.creditCents,
      finalCents: s.finalCents + r.finalCents,
    }),
    ZERO,
  );
}

/**
 * Filtro de cuentas por PREFIJO: `from` incluye todo código ≥ `from`;
 * `to` incluye lo que empiece por `to` o sea ≤ `to`. Así «desde 1105
 * hasta 1110» trae 110505 y 111005 pero no 111505.
 */
export function inAccountRange(code: string, from?: string | null, to?: string | null): boolean {
  if (from && code < from && !code.startsWith(from)) return false;
  if (to && code > to && !code.startsWith(to)) return false;
  return true;
}

export function buildTrialBalance(
  rowsFromDb: readonly TrialBalanceDbRow[],
  {
    level,
    accountFrom,
    accountTo,
    accounts,
  }: {
    level: TrialBalanceLevel;
    accountFrom?: string | null;
    accountTo?: string | null;
    /** Plan de cuentas (nombres por código, prefijos incluidos). */
    accounts: readonly { code: string; name: string }[];
  },
): TrialBalance {
  const withMovement = rowsFromDb.filter(
    (r) => r.initialCents !== 0 || r.debitCents !== 0 || r.creditCents !== 0 || r.finalCents !== 0,
  );
  const all = sumRows(withMovement);
  const differenceCents = all.debitCents - all.creditCents;

  const filtered = Boolean(accountFrom || accountTo);
  const leaves = filtered
    ? withMovement.filter((r) => inAccountRange(r.accountCode, accountFrom, accountTo))
    : withMovement;

  const names: Record<string, string> = {};
  for (const a of accounts) names[a.code] = a.name;

  const tree = buildPucTree(
    leaves.map((r) => ({
      code: r.accountCode,
      name: names[r.accountCode] ?? "",
      values: [r.initialCents, r.debitCents, r.creditCents, r.finalCents],
    })),
    { levels: PUC_LEVELS.filter((l) => l <= level), names },
  );

  const rows = flattenTree(tree).map(toRow);
  return {
    level,
    rows,
    totals: filtered ? sumRows(leaves) : all,
    bookTotals: all,
    balanced: Math.abs(differenceCents) <= 1,
    differenceCents,
    filtered,
    dimension: "none",
  };
}

function toRow(r: FlatRow): TrialBalanceRow {
  return {
    key: r.key,
    code: r.code,
    name: r.name,
    depth: r.depth,
    ancestors: r.ancestors,
    hasChildren: r.hasChildren,
    initialCents: r.values[0] ?? 0,
    debitCents: r.values[1] ?? 0,
    creditCents: r.values[2] ?? 0,
    finalCents: r.values[3] ?? 0,
  };
}

/**
 * Filas del CSV con la jerarquía COMPLETA (no solo lo desplegado en
 * pantalla) y la fila TOTAL al final. Los montos van como número
 * (= centavos) para que `buildReportCsv` los escriba con coma decimal.
 */
export function trialBalanceCsvRows(
  tb: TrialBalance,
  totalLabel: string,
): (string | number)[][] {
  const rows: (string | number)[][] = tb.rows.map((r) => [
    r.code,
    r.name,
    r.initialCents,
    r.debitCents,
    r.creditCents,
    r.finalCents,
  ]);
  rows.push([
    "",
    totalLabel,
    tb.totals.initialCents,
    tb.totals.debitCents,
    tb.totals.creditCents,
    tb.totals.finalCents,
  ]);
  return rows;
}
