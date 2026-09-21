// Lecturas de diferidos para la UI (lista, detalle con proyección y opciones
// del formulario). La matemática y las mutaciones viven en deferred.ts.
import { db } from "@/lib/db";
import { getAccountingConfig, isMonthClosed } from "./cierre";
import {
  DEFERRAL_PREFIX,
  DEFERRED_ITEM_SOURCE,
  DEFERRED_SOURCE,
  TARGET_PREFIXES,
  deferredProgress,
  deferredSchedule,
  monthlyQuotaCents,
  startMonth,
  type DeferredItemRecord,
  type DeferredKind,
} from "./deferred";
import { loadChartOfAccounts } from "./ledger";
import { MONEY_ACCOUNT_PREFIX } from "./paymentAccounts";

export type DeferredItemDto = {
  id: string;
  name: string;
  kind: DeferredKind;
  totalCents: number;
  /** "YYYY-MM-DD". */
  startDate: string;
  /** "YYYY-MM" del primer mes amortizable. */
  startMonth: string;
  months: number;
  sourceAccountCode: string;
  sourceAccountName: string;
  deferralAccountCode: string;
  deferralAccountName: string;
  targetAccountCode: string;
  targetAccountName: string;
  costCenterId: string | null;
  costCenterName: string | null;
  notes: string | null;
  status: "active" | "closed";
  closedAt: string | null;
  createdAt: string;
  monthlyCents: number;
  /** Progreso hasta el mes en curso inclusive (respetando la baja). */
  amortizedCents: number;
  balanceCents: number;
  postedMonths: number;
};

export type DeferredScheduleRow = {
  month: string;
  amountCents: number;
  /** El asiento `deferred` de ese mes existe (o el mes ya está cerrado). */
  posted: boolean;
  /** Mes posterior a la baja: no se amortiza. */
  cancelled: boolean;
};

export type DeferredDetail = {
  item: DeferredItemDto;
  initialEntryId: string | null;
  schedule: DeferredScheduleRow[];
};

export type AccountOption = { code: string; name: string };
export type DeferredFormOptions = {
  accounts: {
    source: AccountOption[];
    deferralExpense: AccountOption[];
    deferralIncome: AccountOption[];
    targetExpense: AccountOption[];
    targetIncome: AccountOption[];
  };
  centers: Array<{ id: string; name: string }>;
};

/** Mes en curso "YYYY-MM" (UTC, misma convención que activos y el motor). */
export function currentMonth(): string {
  return new Date().toISOString().slice(0, 7);
}

type ItemWithCenter = DeferredItemRecord & { costCenter: { name: string } | null };

function toDto(
  it: ItemWithCenter,
  nameByCode: Map<string, string>,
  month: string,
): DeferredItemDto {
  const p = deferredProgress(it, month);
  return {
    id: it.id,
    name: it.name,
    kind: it.kind === "income" ? "income" : "expense",
    totalCents: it.totalCents,
    startDate: it.startDate.toISOString().slice(0, 10),
    startMonth: startMonth(it.startDate),
    months: it.months,
    sourceAccountCode: it.sourceAccountCode,
    sourceAccountName: nameByCode.get(it.sourceAccountCode) ?? "—",
    deferralAccountCode: it.deferralAccountCode,
    deferralAccountName: nameByCode.get(it.deferralAccountCode) ?? "—",
    targetAccountCode: it.targetAccountCode,
    targetAccountName: nameByCode.get(it.targetAccountCode) ?? "—",
    costCenterId: it.costCenterId,
    costCenterName: it.costCenter?.name ?? null,
    notes: it.notes,
    status: it.status === "closed" ? "closed" : "active",
    closedAt: it.closedAt ? it.closedAt.toISOString() : null,
    createdAt: it.createdAt.toISOString(),
    monthlyCents: monthlyQuotaCents(it),
    amortizedCents: p.amortizedCents,
    balanceCents: p.balanceCents,
    postedMonths: p.postedMonths,
  };
}

async function accountNames(restaurantId: string, codes: string[]): Promise<Map<string, string>> {
  if (codes.length === 0) return new Map();
  const rows = await db.ledgerAccount.findMany({
    where: { restaurantId, code: { in: [...new Set(codes)] } },
    select: { code: true, name: true },
  });
  return new Map(rows.map((a) => [a.code, a.name]));
}

const ITEM_INCLUDE = { costCenter: { select: { name: true } } } as const;

/** Diferidos del comercio (activos primero, más recientes arriba) con progreso al mes en curso. */
export async function listDeferredItems(restaurantId: string): Promise<DeferredItemDto[]> {
  const items = await db.deferredItem.findMany({
    where: { restaurantId },
    include: ITEM_INCLUDE,
    orderBy: [{ status: "asc" }, { createdAt: "desc" }],
  });
  const names = await accountNames(
    restaurantId,
    items.flatMap((i) => [i.sourceAccountCode, i.deferralAccountCode, i.targetAccountCode]),
  );
  const month = currentMonth();
  return items.map((it) => toDto(it, names, month));
}

/**
 * Detalle: ítem, id del asiento inicial y el cronograma completo con la
 * marca `posted` por mes — true si existe el asiento-resumen `deferred` de
 * ese mes (sourceRef = "YYYY-MM") o si el mes ya está cerrado (inmutable) —
 * y `cancelled` para los meses posteriores a la baja.
 */
export async function loadDeferredDetail(
  restaurantId: string,
  id: string,
): Promise<DeferredDetail | null> {
  const it = await db.deferredItem.findFirst({
    where: { id, restaurantId },
    include: ITEM_INCLUDE,
  });
  if (!it) return null;
  const schedule = deferredSchedule(it);
  const months = schedule.map((r) => r.month);
  const [names, cfg, initial, posted] = await Promise.all([
    accountNames(restaurantId, [it.sourceAccountCode, it.deferralAccountCode, it.targetAccountCode]),
    getAccountingConfig(restaurantId),
    db.journalEntry.findFirst({
      where: { restaurantId, source: DEFERRED_ITEM_SOURCE, sourceRef: it.id },
      select: { id: true },
    }),
    months.length > 0
      ? db.journalEntry.findMany({
          where: { restaurantId, source: DEFERRED_SOURCE, sourceRef: { in: months } },
          select: { sourceRef: true },
        })
      : Promise.resolve([]),
  ]);
  const postedMonths = new Set(posted.map((e) => e.sourceRef));
  const closedMonth =
    it.status === "closed" && it.closedAt ? it.closedAt.toISOString().slice(0, 7) : null;
  return {
    item: toDto(it, names, currentMonth()),
    initialEntryId: initial?.id ?? null,
    schedule: schedule.map((r) => {
      const cancelled = closedMonth != null && r.month > closedMonth;
      return {
        month: r.month,
        amountCents: r.amountCents,
        posted:
          !cancelled && (postedMonths.has(r.month) || isMonthClosed(cfg.closedThrough, r.month)),
        cancelled,
      };
    }),
  };
}

/**
 * Cuentas imputables activas para el formulario, por rol y tipo (origen
 * 11xx, puente 17xx/27xx, destino 5xx/6xx o 4xx), y centros de costos activos.
 */
export async function loadDeferredFormOptions(restaurantId: string): Promise<DeferredFormOptions> {
  const [chart, centers] = await Promise.all([
    loadChartOfAccounts(restaurantId),
    db.costCenter.findMany({
      where: { restaurantId, active: true },
      orderBy: { name: "asc" },
      select: { id: true, name: true },
    }),
  ]);
  const postable = chart.filter((a) => a.postable);
  const withPrefix = (prefixes: readonly string[]): AccountOption[] =>
    postable
      .filter((a) => prefixes.some((p) => a.code.startsWith(p)))
      .map((a) => ({ code: a.code, name: a.name }));
  return {
    accounts: {
      source: withPrefix([MONEY_ACCOUNT_PREFIX]),
      deferralExpense: withPrefix([DEFERRAL_PREFIX.expense]),
      deferralIncome: withPrefix([DEFERRAL_PREFIX.income]),
      targetExpense: withPrefix(TARGET_PREFIXES.expense),
      targetIncome: withPrefix(TARGET_PREFIXES.income),
    },
    centers,
  };
}
