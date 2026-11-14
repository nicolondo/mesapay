// Parámetros de la lista de gastos (URL de la página y del API) — puro,
// sin base de datos: lo usan la pantalla (cliente) y el servidor. La
// consulta vive en expenseList.ts (ver ahí qué significa cada parámetro).
import { monthRange } from "./accounting";

export const EXPENSE_PAGE_SIZE = 50;
export const EXPENSE_STATUSES = ["all", "pending", "overdue", "paid"] as const;
export type ExpenseStatusFilter = (typeof EXPENSE_STATUSES)[number];

export type ExpensePeriod =
  | { kind: "month"; month: string }
  | { kind: "range"; desde: string; hasta: string }
  | { kind: "all" };

export type ExpenseListFilters = {
  period: ExpensePeriod;
  q: string;
  supplierId: string | null;
  category: string | null;
  account: string | null;
  status: ExpenseStatusFilter;
  page: number;
};

const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** «2026-10-31» válido (y dentro de 2020–2100, como las fechas del gasto). */
export function isIsoDay(s: string | null | undefined): s is string {
  const m = s ? ISO_DAY.exec(s) : null;
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (y < 2020 || y > 2100) return false;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

/**
 * Parámetros (de la URL de la página o del API) → filtros. null si el
 * período no es válido o falta: el API responde 400, la página cae al mes.
 */
export function parseExpenseListParams(sp: URLSearchParams): ExpenseListFilters | null {
  const desde = sp.get("desde");
  const hasta = sp.get("hasta");
  let period: ExpensePeriod | null = null;
  if (isIsoDay(desde) && isIsoDay(hasta)) {
    period = desde <= hasta ? { kind: "range", desde, hasta } : { kind: "range", desde: hasta, hasta: desde };
  } else if (sp.get("fechas") === "todas") {
    period = { kind: "all" };
  } else {
    const month = sp.get("month") ?? "";
    if (monthRange(month)) period = { kind: "month", month };
  }
  if (!period) return null;
  const status = sp.get("status");
  const page = Number(sp.get("page"));
  const clean = (v: string | null, max: number) => {
    const s = (v ?? "").trim().slice(0, max);
    return s === "" ? null : s;
  };
  return {
    period,
    q: (sp.get("q") ?? "").trim().replace(/\s+/g, " ").slice(0, 100),
    supplierId: clean(sp.get("supplier"), 64),
    category: clean(sp.get("category"), 60),
    account: clean(sp.get("account"), 10)?.replace(/\D/g, "") || null,
    status: (EXPENSE_STATUSES as readonly string[]).includes(status ?? "") ? (status as ExpenseStatusFilter) : "all",
    page: Number.isInteger(page) && page >= 1 && page <= 100_000 ? page : 1,
  };
}

/** Filtros → parámetros (sin los vacíos ni los por defecto). Inverso de `parseExpenseListParams`. */
export function expenseListParams(f: ExpenseListFilters): URLSearchParams {
  const p = new URLSearchParams();
  if (f.period.kind === "month") p.set("month", f.period.month);
  else if (f.period.kind === "range") {
    p.set("desde", f.period.desde);
    p.set("hasta", f.period.hasta);
  } else p.set("fechas", "todas");
  if (f.q) p.set("q", f.q);
  if (f.supplierId) p.set("supplier", f.supplierId);
  if (f.category) p.set("category", f.category);
  if (f.account) p.set("account", f.account);
  if (f.status !== "all") p.set("status", f.status);
  if (f.page > 1) p.set("page", String(f.page));
  return p;
}

/** [desde, hasta) en UTC del período (la fecha del gasto es calendario, como `monthRange`). */
export function periodRange(period: ExpensePeriod): { from: Date; to: Date } | null {
  if (period.kind === "all") return null;
  if (period.kind === "month") return monthRange(period.month);
  const [y1, m1, d1] = period.desde.split("-").map(Number) as [number, number, number];
  const [y2, m2, d2] = period.hasta.split("-").map(Number) as [number, number, number];
  return { from: new Date(Date.UTC(y1, m1 - 1, d1)), to: new Date(Date.UTC(y2, m2 - 1, d2 + 1)) };
}

/** ¿Algún filtro además del período? (para el estado vacío y «Quitar filtros»). */
export function hasExpenseFilters(f: Pick<ExpenseListFilters, "q" | "supplierId" | "category" | "account" | "status">): boolean {
  return Boolean(f.q || f.supplierId || f.category || f.account || f.status !== "all");
}
