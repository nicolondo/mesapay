// Lista de gastos con búsqueda, filtros, totales y páginas — TODO en el
// servidor (GET /api/operator/expenses y el CSV de la lista filtrada).
//
// Los mismos parámetros viajan en la URL de la página
// (`/operator/contabilidad?tab=expenses&…`) y en la del API, así que un
// enlace con filtros se puede recargar y compartir:
//
//   período  `desde`+`hasta` (YYYY-MM-DD, inclusive) · `fechas=todas` ·
//            `month` (YYYY-MM, el de siempre)
//   `q`        texto: consecutivo (G-0012), Nº del documento del proveedor,
//              proveedor, NIT, concepto, descripción, código o nombre de la
//              cuenta. Varias palabras: cada una tiene que aparecer.
//   `supplier` id del proveedor · `none` = sin proveedor
//   `category` concepto (categoría) exacto
//   `account`  cuenta contable (prefijo: «5135» incluye 513530); cuenta la
//              que el motor usaría, también si el gasto la deduce de la
//              categoría
//   `status`   pending (con saldo) · overdue (con saldo y vencido) · paid
//   `page`     1…
//
// Totales: los del conjunto FILTRADO completo (no de la página). El estado
// y los totales salen de una sola pasada en memoria sobre las filas que
// cumplen los demás filtros (montos, sin includes); así el conteo de cada
// pestaña, el «Mostrando X–Y de N» y los totales nunca se contradicen. La
// página se pide aparte, por id, con todo lo que muestra la pantalla.
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { resolvePostableCode } from "./chart";
import { expensePayableCents } from "./expenseTax";
import { digitsAsNumber, parseExpenseNumber } from "./expenseNumberFormat";
import { EXPENSE_INCLUDE } from "./expenseShared";
import { loadAccountIndex } from "./ledger";
import { expenseAccountFor } from "./posting";
import {
  periodRange,
  type ExpenseListFilters,
  type ExpenseStatusFilter,
  EXPENSE_PAGE_SIZE,
  EXPENSE_STATUSES,
} from "./expenseListParams";

export * from "./expenseListParams";

// ── Estado de pago (una sola definición: pestañas, filtro y totales) ──────

export type ExpenseMoneyRow = {
  amountCents: number;
  payableCents: number | null;
  paidCents: number | null;
  dueAt: Date | null;
};

/** Saldo por pagar: total a pagar − abonado (nunca negativo). */
export function outstandingOf(e: ExpenseMoneyRow): number {
  return Math.max(0, expensePayableCents(e) - (e.paidCents ?? 0));
}

/** Vencido: con saldo y con un vencimiento pactado que ya pasó (antes de `today`, YYYY-MM-DD). */
export function isOverdue(e: ExpenseMoneyRow, today: string): boolean {
  return outstandingOf(e) > 0 && e.dueAt != null && e.dueAt.toISOString().slice(0, 10) < today;
}

export function matchesStatus(e: ExpenseMoneyRow, status: ExpenseStatusFilter, today: string): boolean {
  switch (status) {
    case "all":
      return true;
    case "pending":
      return outstandingOf(e) > 0;
    case "overdue":
      return isOverdue(e, today);
    case "paid":
      return outstandingOf(e) === 0;
  }
}

export type ExpenseListSummary = {
  count: number;
  /** Σ costo del gasto (lo del PYG). */
  costCents: number;
  /** Σ total a pagar al proveedor (base + IVA + INC − retenciones). */
  payableCents: number;
  paidCents: number;
  /** Σ saldo por pagar. */
  outstandingCents: number;
  overdueCount: number;
  overdueCents: number;
};

export type ExpenseStatusCounts = Record<ExpenseStatusFilter, number>;

/** Totales y conteos por estado (pura). `rows` ya cumple los demás filtros. */
export function summarizeExpenses(
  rows: readonly ExpenseMoneyRow[],
  status: ExpenseStatusFilter,
  today: string,
): { summary: ExpenseListSummary; counts: ExpenseStatusCounts } {
  const counts: ExpenseStatusCounts = { all: 0, pending: 0, overdue: 0, paid: 0 };
  const summary: ExpenseListSummary = {
    count: 0,
    costCents: 0,
    payableCents: 0,
    paidCents: 0,
    outstandingCents: 0,
    overdueCount: 0,
    overdueCents: 0,
  };
  for (const e of rows) {
    for (const s of EXPENSE_STATUSES) if (matchesStatus(e, s, today)) counts[s]++;
    if (!matchesStatus(e, status, today)) continue;
    const outstanding = outstandingOf(e);
    summary.count++;
    summary.costCents += e.amountCents;
    summary.payableCents += expensePayableCents(e);
    summary.paidCents += e.paidCents ?? 0;
    summary.outstandingCents += outstanding;
    if (isOverdue(e, today)) {
      summary.overdueCount++;
      summary.overdueCents += outstanding;
    }
  }
  return { summary, counts };
}

// ── Búsqueda ─────────────────────────────────────────────────────────────

/**
 * Una palabra del buscador → las formas en que puede calzar un gasto. Las
 * cuentas cuyo NOMBRE contiene la palabra llegan resueltas (`accountCodes`).
 */
export function termWhere(term: string, accountCodes: readonly string[]): Prisma.ExpenseWhereInput {
  const contains = { contains: term, mode: "insensitive" as const };
  const or: Prisma.ExpenseWhereInput[] = [
    { documentNumber: contains },
    { category: contains },
    { description: contains },
    { supplier: { is: { name: contains } } },
  ];
  const consecutive = parseExpenseNumber(term) ?? digitsAsNumber(term);
  if (consecutive != null) or.push({ number: consecutive });
  const digits = term.replace(/\D/g, "");
  // NIT/cédula: con o sin puntos y guión.
  if (digits.length >= 3 && /^[\d.\s-]+$/.test(term)) {
    or.push({ supplier: { is: { taxId: { contains: digits } } } });
  }
  if (/^\d{2,10}$/.test(term)) or.push({ accountCode: { startsWith: term } });
  if (accountCodes.length > 0) or.push({ accountCode: { in: [...accountCodes] } });
  return { OR: or };
}

/** Palabras del buscador (como mucho 5, sin repetir). */
export function searchTerms(q: string): string[] {
  return [...new Set(q.split(" ").map((t) => t.trim()).filter(Boolean))].slice(0, 5);
}

/** Filtros → `where` de Prisma, SIN el estado de pago (ver `summarizeExpenses`). */
export async function expenseListWhere(
  restaurantId: string,
  f: ExpenseListFilters,
): Promise<Prisma.ExpenseWhereInput> {
  const and: Prisma.ExpenseWhereInput[] = [{ restaurantId, recurring: false }];
  const range = periodRange(f.period);
  if (range) and.push({ date: { gte: range.from, lt: range.to } });
  if (f.supplierId) and.push({ supplierId: f.supplierId === "none" ? null : f.supplierId });
  if (f.category) and.push({ category: f.category });
  if (f.account) {
    // La cuenta que usa el motor: la fijada en el gasto o, si no tiene, la
    // que deduce de la categoría (resuelta al auxiliar imputable del plan).
    const [index, cats] = await Promise.all([
      loadAccountIndex(restaurantId),
      db.expense.groupBy({ by: ["category"], where: { restaurantId, recurring: false, accountCode: null } }),
    ]);
    const derived = cats
      .map((c) => c.category)
      .filter((cat) => {
        const engine = expenseAccountFor(cat);
        return (resolvePostableCode(index, engine) ?? engine).startsWith(f.account!);
      });
    and.push({
      OR: [
        { accountCode: { startsWith: f.account } },
        ...(derived.length > 0 ? [{ accountCode: null, category: { in: derived } }] : []),
      ],
    });
  }
  const terms = searchTerms(f.q);
  if (terms.length > 0) {
    const named = await db.ledgerAccount.findMany({
      where: { restaurantId, OR: terms.map((t) => ({ name: { contains: t, mode: "insensitive" as const } })) },
      select: { code: true, name: true },
      take: 200,
    });
    for (const term of terms) {
      const codes = named.filter((a) => a.name.toLowerCase().includes(term.toLowerCase())).map((a) => a.code);
      and.push(termWhere(term, codes));
    }
  }
  return { AND: and };
}

export type ExpenseListResult = {
  filters: ExpenseListFilters;
  expenses: Array<Prisma.ExpenseGetPayload<{ include: typeof EXPENSE_INCLUDE }> & { overdue: boolean }>;
  summary: ExpenseListSummary;
  counts: ExpenseStatusCounts;
  page: number;
  pageCount: number;
  pageSize: number;
};

const ORDER: Prisma.ExpenseOrderByWithRelationInput[] = [{ date: "desc" }, { number: "desc" }, { id: "desc" }];

/**
 * La página pedida (más reciente primero), los totales del conjunto
 * filtrado y el conteo de cada estado. `today` = hoy en Colombia
 * (YYYY-MM-DD), para «vencido».
 */
export async function loadExpenseList(
  restaurantId: string,
  filters: ExpenseListFilters,
  today: string,
  pageSize = EXPENSE_PAGE_SIZE,
): Promise<ExpenseListResult> {
  const where = await expenseListWhere(restaurantId, filters);
  const rows = await db.expense.findMany({
    where,
    orderBy: ORDER,
    select: { id: true, amountCents: true, payableCents: true, paidCents: true, dueAt: true },
  });
  const { summary, counts } = summarizeExpenses(rows, filters.status, today);
  const matching = rows.filter((r) => matchesStatus(r, filters.status, today));
  const pageCount = Math.max(1, Math.ceil(matching.length / pageSize));
  const page = Math.min(filters.page, pageCount);
  const ids = matching.slice((page - 1) * pageSize, page * pageSize).map((r) => r.id);
  const full = ids.length
    ? await db.expense.findMany({ where: { id: { in: ids } }, include: EXPENSE_INCLUDE })
    : [];
  const byId = new Map(full.map((e) => [e.id, e]));
  const expenses = ids
    .map((id) => byId.get(id))
    .filter((e): e is NonNullable<typeof e> => Boolean(e))
    .map((e) => ({ ...e, overdue: isOverdue(e, today) }));
  return { filters: { ...filters, page }, expenses, summary, counts, page, pageCount, pageSize };
}
