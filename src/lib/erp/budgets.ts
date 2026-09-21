// Presupuestos por cuenta (prefijo PUC) y mes, con centro de costos opcional.
// Port de zenith /contabilidad/presupuestos (budget_vs_actual, upsert_budget,
// delete_budget) adaptado al libro de MESAPAY.
//
// Reglas:
//   · Una fila es (año, mes | null, cuenta, centro | null, valor). Mes null =
//     aplica a TODOS los meses del año (así quedaron las filas anteriores a la
//     migración, que eran "mismo valor cada mes"). Si para un mes hay fila
//     mensual y anual de la misma cuenta/centro, la MENSUAL gana.
//   · Lo real del mes = Σ movimiento de las líneas del libro cuyo código
//     arranca con el código del presupuesto (un presupuesto en "51" cubre todo
//     51xx, como siempre en MESAPAY), llevado a la NATURALEZA de la cuenta:
//     activo/gasto/costo → débito − crédito; pasivo/patrimonio/ingreso →
//     crédito − débito. Se filtra por centro de costos SÓLO si el presupuesto
//     es por centro; el general suma todas las líneas del prefijo.
//   · variación = presupuesto − real (positiva = ahorro); % ejecución =
//     real / presupuesto × 100 con un decimal (null si presupuesto = 0);
//     semáforo ok ≤ 90 · warn ≤ 100 · over > 100.
//   · Unicidad por alcance (año, mes, cuenta, centro): la garantiza el índice
//     SQL `Budget_scope_key` (COALESCE sobre los nulos, ver la migración
//     20260918070000). Prisma no lo conoce, así que `upsertBudget` busca la
//     fila por alcance antes de insertar y trata el P2002 como carrera.
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { monthRange } from "./accounting";
import { natureForType, typeForCode } from "./chart";

export const BUDGET_YEAR_MIN = 2020;
export const BUDGET_YEAR_MAX = 2100;
export const BUDGET_AMOUNT_MAX = 100_000_000_000;

/** Alcance de un presupuesto: cuenta + centro (null = general) + mes (null = todo el año). */
export type BudgetScope = {
  accountCode: string;
  costCenterId: string | null;
  /** 1..12, o null = aplica a todos los meses del año. */
  month: number | null;
};

export type BudgetRow = BudgetScope & {
  id: string;
  year: number;
  monthlyCents: number;
};

/** Clave (cuenta, centro) — el mes se resuelve aparte en `budgetsForMonth`. */
export function scopeKey(b: Pick<BudgetScope, "accountCode" | "costCenterId">): string {
  return `${b.accountCode}|${b.costCenterId ?? ""}`;
}

/**
 * Presupuestos que aplican a un mes: las filas con `month === m` y las
 * anuales (`month === null`). Si una misma cuenta/centro tiene las dos, la
 * mensual gana. Puro.
 */
export function budgetsForMonth<T extends BudgetScope>(rows: readonly T[], month: number): T[] {
  const chosen = new Map<string, T>();
  for (const r of rows) {
    if (r.month !== null && r.month !== month) continue;
    const key = scopeKey(r);
    const cur = chosen.get(key);
    if (!cur || (cur.month === null && r.month !== null)) chosen.set(key, r);
  }
  return [...chosen.values()];
}

export type BudgetLedgerLine = {
  accountCode: string;
  debitCents: number;
  creditCents: number;
  costCenterId: string | null;
};

/** Lo que hace falta saber de una cuenta del plan para ejecutar el presupuesto. */
export type BudgetAccountInfo = { name: string; nature?: "debito" | "credito" };

export type BudgetStatus = "ok" | "warn" | "over";

export type BudgetExecutionRow = {
  id: string;
  accountCode: string;
  accountName: string;
  costCenterId: string | null;
  costCenterName: string | null;
  /** Mes de la fila; null = presupuesto anual aplicado a este mes. */
  month: number | null;
  budgetCents: number;
  actualCents: number;
  /** presupuesto − real: positiva = ahorro, negativa = sobreejecución. */
  varianceCents: number;
  /** real / presupuesto × 100, un decimal; null si presupuesto = 0. */
  pct: number | null;
  status: BudgetStatus | null;
};

/**
 * Signo para llevar un movimiento a la naturaleza de la cuenta: +1 si es de
 * naturaleza débito (D − C), −1 si es crédito (C − D). Usa la naturaleza del
 * plan si viene; si no, la de la clase PUC del código (1/5/6/7 débito).
 */
export function naturalSign(code: string, nature?: "debito" | "credito"): 1 | -1 {
  const n = nature ?? natureForType(typeForCode(code) ?? "activo");
  return n === "credito" ? -1 : 1;
}

/** % de ejecución con un decimal; null si no hay presupuesto. */
export function pctExecution(actualCents: number, budgetCents: number): number | null {
  if (budgetCents <= 0) return null;
  return Math.round((actualCents / budgetCents) * 1000) / 10;
}

/** Semáforo: ≤ 90 ok · ≤ 100 warn · > 100 over. */
export function budgetStatus(pct: number | null): BudgetStatus | null {
  if (pct === null) return null;
  if (pct <= 90) return "ok";
  if (pct <= 100) return "warn";
  return "over";
}

/**
 * Ejecución del mes, PURA: para cada presupuesto que aplica al mes suma las
 * líneas del libro cuyo código arranca con el suyo (llevadas a naturaleza),
 * filtrando por centro sólo si el presupuesto es por centro. Ordena por
 * código de cuenta y, dentro, el general primero y luego por nombre del centro.
 */
export function budgetVsActual(args: {
  budgets: readonly BudgetRow[];
  lines: readonly BudgetLedgerLine[];
  accounts: ReadonlyMap<string, BudgetAccountInfo>;
  centers: ReadonlyMap<string, string>;
  month: number;
}): BudgetExecutionRow[] {
  const rows = budgetsForMonth(args.budgets, args.month).map((b) => {
    const account = args.accounts.get(b.accountCode);
    const sign = naturalSign(b.accountCode, account?.nature);
    let actual = 0;
    for (const l of args.lines) {
      if (!l.accountCode.startsWith(b.accountCode)) continue;
      if (b.costCenterId !== null && l.costCenterId !== b.costCenterId) continue;
      actual += sign * (l.debitCents - l.creditCents);
    }
    const pct = pctExecution(actual, b.monthlyCents);
    return {
      id: b.id,
      accountCode: b.accountCode,
      accountName: account?.name ?? "—",
      costCenterId: b.costCenterId,
      costCenterName: b.costCenterId ? (args.centers.get(b.costCenterId) ?? "—") : null,
      month: b.month,
      budgetCents: b.monthlyCents,
      actualCents: actual,
      varianceCents: b.monthlyCents - actual,
      pct,
      status: budgetStatus(pct),
    };
  });
  rows.sort((a, b) => {
    if (a.accountCode !== b.accountCode) return a.accountCode.localeCompare(b.accountCode);
    if (a.costCenterId === null || b.costCenterId === null) {
      return a.costCenterId === null ? (b.costCenterId === null ? 0 : -1) : 1;
    }
    return (a.costCenterName ?? "").localeCompare(b.costCenterName ?? "");
  });
  return rows;
}

// ── Validación del alta (pura) ──────────────────────────────────────────────

export type BudgetInput = {
  accountCode: string;
  costCenterId?: string | null;
  year: number;
  /** null = todos los meses del año. */
  month: number | null;
  amountCents: number;
};

export type BudgetValidationError =
  | "invalid_year"
  | "invalid_month"
  | "invalid_amount"
  | "account_not_found"
  | "cost_center_not_found";

export type BudgetContext = {
  accounts: ReadonlyMap<string, { active: boolean }>;
  costCenters: ReadonlyMap<string, { active: boolean }>;
};

export type NormalizedBudget = {
  accountCode: string;
  costCenterId: string | null;
  year: number;
  month: number | null;
  amountCents: number;
};

export type BudgetValidation =
  | { ok: true; normalized: NormalizedBudget }
  | { ok: false; error: BudgetValidationError };

/**
 * Valida el alta/edición contra el plan y los centros ya cargados. La cuenta
 * puede ser un grupo (2 dígitos) o cualquier cuenta del plan, activa: el
 * presupuesto es por PREFIJO, no exige imputable.
 */
export function validateBudgetInput(input: BudgetInput, ctx: BudgetContext): BudgetValidation {
  const year = input.year;
  if (!Number.isInteger(year) || year < BUDGET_YEAR_MIN || year > BUDGET_YEAR_MAX) {
    return { ok: false, error: "invalid_year" };
  }
  const month = input.month;
  if (month !== null && (!Number.isInteger(month) || month < 1 || month > 12)) {
    return { ok: false, error: "invalid_month" };
  }
  const amountCents = input.amountCents;
  if (!Number.isInteger(amountCents) || amountCents < 0 || amountCents > BUDGET_AMOUNT_MAX) {
    return { ok: false, error: "invalid_amount" };
  }
  const accountCode = (input.accountCode ?? "").trim();
  const account = /^\d{1,10}$/.test(accountCode) ? ctx.accounts.get(accountCode) : undefined;
  if (!account || !account.active) return { ok: false, error: "account_not_found" };
  const costCenterId = (input.costCenterId ?? "").trim() || null;
  if (costCenterId) {
    const cc = ctx.costCenters.get(costCenterId);
    if (!cc || !cc.active) return { ok: false, error: "cost_center_not_found" };
  }
  return { ok: true, normalized: { accountCode, costCenterId, year, month, amountCents } };
}

// ── Lecturas y mutaciones (DB) ─────────────────────────────────────────────

export type BudgetDto = {
  id: string;
  year: number;
  month: number | null;
  accountCode: string;
  accountName: string;
  costCenterId: string | null;
  costCenterName: string | null;
  monthlyCents: number;
};

const BUDGET_INCLUDE = { costCenter: { select: { name: true } } } as const;

type BudgetRecord = Prisma.BudgetGetPayload<{ include: typeof BUDGET_INCLUDE }>;

function toDto(b: BudgetRecord, nameByCode: ReadonlyMap<string, BudgetAccountInfo>): BudgetDto {
  return {
    id: b.id,
    year: b.year,
    month: b.month,
    accountCode: b.accountCode,
    accountName: nameByCode.get(b.accountCode)?.name ?? "—",
    costCenterId: b.costCenterId,
    costCenterName: b.costCenter?.name ?? null,
    monthlyCents: b.monthlyCents,
  };
}

async function accountInfo(
  restaurantId: string,
  codes: readonly string[],
): Promise<Map<string, BudgetAccountInfo>> {
  if (codes.length === 0) return new Map();
  const rows = await db.ledgerAccount.findMany({
    where: { restaurantId, code: { in: [...new Set(codes)] } },
    select: { code: true, name: true, nature: true },
  });
  return new Map(rows.map((a) => [a.code, { name: a.name, nature: a.nature }]));
}

export type BudgetExecution = {
  year: number;
  month: number;
  /** Ejecución del mes (sólo cuentas con presupuesto que aplique). */
  rows: BudgetExecutionRow[];
  /** Todos los presupuestos del año (mensuales y anuales), para gestionarlos. */
  budgets: BudgetDto[];
};

/**
 * Ejecución del mes + lista de presupuestos del año. Lo real sale de las
 * líneas del libro fechadas en el mes; se excluye el asiento de cierre del
 * ejercicio (source `closing`), que cancela 4/5/6 en diciembre y no es
 * actividad del mes.
 */
export async function loadBudgetExecution(
  restaurantId: string,
  year: number,
  month: number,
): Promise<BudgetExecution> {
  const range = monthRange(`${year}-${String(month).padStart(2, "0")}`);
  const [budgets, lines] = await Promise.all([
    db.budget.findMany({
      where: { restaurantId, year },
      include: BUDGET_INCLUDE,
      orderBy: [{ accountCode: "asc" }, { month: "asc" }],
    }),
    range
      ? db.journalLine.findMany({
          where: {
            entry: {
              restaurantId,
              date: { gte: range.from, lt: range.to },
              source: { not: "closing" },
            },
          },
          select: { accountCode: true, debitCents: true, creditCents: true, costCenterId: true },
        })
      : Promise.resolve([]),
  ]);
  const accounts = await accountInfo(
    restaurantId,
    budgets.map((b) => b.accountCode),
  );
  const centers = new Map<string, string>();
  for (const b of budgets) {
    if (b.costCenterId && b.costCenter) centers.set(b.costCenterId, b.costCenter.name);
  }
  return {
    year,
    month,
    rows: budgetVsActual({ budgets, lines, accounts, centers, month }),
    budgets: budgets.map((b) => toDto(b, accounts)),
  };
}

export type UpsertBudgetResult =
  | { ok: true; budget: BudgetDto; created: boolean }
  | { ok: false; error: BudgetValidationError | "duplicate" };

/**
 * Crea o actualiza el presupuesto de un alcance (año, mes | null, cuenta,
 * centro | null). Busca la fila por alcance antes de insertar (Prisma no
 * conoce el índice único con COALESCE); si dos altas compiten, el índice
 * `Budget_scope_key` rechaza la segunda y se devuelve `duplicate`.
 */
export async function upsertBudget(
  restaurantId: string,
  input: BudgetInput,
): Promise<UpsertBudgetResult> {
  const [accounts, centers] = await Promise.all([
    db.ledgerAccount.findMany({
      where: { restaurantId },
      select: { code: true, active: true },
    }),
    db.costCenter.findMany({
      where: { restaurantId },
      select: { id: true, active: true },
    }),
  ]);
  const v = validateBudgetInput(input, {
    accounts: new Map(accounts.map((a) => [a.code, { active: a.active }])),
    costCenters: new Map(centers.map((c) => [c.id, { active: c.active }])),
  });
  if (!v.ok) return v;
  const n = v.normalized;
  const scope = {
    restaurantId,
    year: n.year,
    month: n.month,
    accountCode: n.accountCode,
    costCenterId: n.costCenterId,
  };
  try {
    const existing = await db.budget.findFirst({ where: scope, select: { id: true } });
    const row = existing
      ? await db.budget.update({
          where: { id: existing.id },
          data: { monthlyCents: n.amountCents },
          include: BUDGET_INCLUDE,
        })
      : await db.budget.create({
          data: { ...scope, monthlyCents: n.amountCents },
          include: BUDGET_INCLUDE,
        });
    const names = await accountInfo(restaurantId, [row.accountCode]);
    return { ok: true, budget: toDto(row, names), created: !existing };
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      return { ok: false, error: "duplicate" };
    }
    throw e;
  }
}

export type DeleteBudgetResult = { ok: true } | { ok: false; error: "not_found" };

/** Borra un presupuesto del comercio (404 si no es suyo). */
export async function deleteBudget(restaurantId: string, id: string): Promise<DeleteBudgetResult> {
  const deleted = await db.budget.deleteMany({ where: { id, restaurantId } });
  return deleted.count > 0 ? { ok: true } : { ok: false, error: "not_found" };
}
