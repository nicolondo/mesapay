// Capa de DATOS del análisis de ventas: ejecuta el SQL de `sql.ts` y tipa
// las filas. Recibe el cliente para poder correr contra una base aislada en
// pruebas. No suma nada en JS: lo que llega ya viene agregado.
import { Prisma, type PrismaClient } from "@prisma/client";
import {
  categoriesSql,
  channelsSql,
  durationSql,
  filterOrderIdsSql,
  heatSql,
  methodsSql,
  modifiersSql,
  ordersSql,
  productsSql,
  tablesSql,
  totalsSql,
  trendSql,
  waitersSql,
  type SalesScope,
} from "./sql";
import { hasItemFilter, type Channel, type ReportingMethod } from "./filters";
import type { Granularity } from "./period";
import type { CreditNoteRow, DurationSummary, RefundRow, SalesTotals } from "./metrics";
import type { HeatRow } from "./heatmap";
import type { TrendRow } from "./trend";
import type {
  CategoryRow,
  ChannelRow,
  FilterOptions,
  MethodRow,
  ModifierRow,
  OrderListRow,
  ProductRow,
  TableRow,
  WaiterRow,
} from "./types";

/** Lo mínimo del cliente Prisma que usa este módulo (vale `db` o uno aislado). */
export type SalesDb = Pick<
  PrismaClient,
  "$queryRaw" | "creditNote" | "kushkiTransaction" | "user" | "category" | "menuItem" | "table"
>;

type DbInt = bigint | number | null;

/** Entero de la base → number, sin perder precisión en silencio. */
export function toInt(value: DbInt | Prisma.Decimal | undefined): number {
  if (value === null || value === undefined) return 0;
  const n = typeof value === "object" ? Number(value.toString()) : Number(value);
  if (!Number.isSafeInteger(n)) throw new Error("sales_analysis_integer_out_of_range");
  return n;
}

function toIntOrNull(value: DbInt | undefined): number | null {
  return value === null || value === undefined ? null : toInt(value);
}

export async function loadTotals(client: SalesDb, scope: SalesScope): Promise<SalesTotals> {
  const [row] = await client.$queryRaw<Record<keyof SalesTotals, DbInt>[]>(totalsSql(scope));
  const item = hasItemFilter(scope);
  return {
    orders: toInt(row?.orders),
    diners: toInt(row?.diners),
    units: toInt(row?.units),
    grossCents: toInt(row?.grossCents),
    discountCents: toInt(row?.discountCents),
    taxCents: toInt(row?.taxCents),
    netCents: toInt(row?.netCents),
    tipCents: item ? null : toInt(row?.tipCents),
    compsCents: toInt(row?.compsCents),
  };
}

export async function loadTrend(client: SalesDb, scope: SalesScope, granularity: Granularity): Promise<TrendRow[]> {
  const rows = await client.$queryRaw<{ bucket: string; netCents: DbInt; orders: DbInt; diners: DbInt }[]>(
    trendSql(scope, granularity),
  );
  return rows.map((r) => ({ bucket: r.bucket, netCents: toInt(r.netCents), orders: toInt(r.orders), diners: toInt(r.diners) }));
}

export async function loadHeat(client: SalesDb, scope: SalesScope): Promise<HeatRow[]> {
  const rows = await client.$queryRaw<{ dow: DbInt; hour: DbInt; netCents: DbInt; orders: DbInt }[]>(heatSql(scope));
  return rows.map((r) => ({ dow: toInt(r.dow), hour: toInt(r.hour), netCents: toInt(r.netCents), orders: toInt(r.orders) }));
}

export async function loadProducts(client: SalesDb, scope: SalesScope): Promise<ProductRow[]> {
  const rows = await client.$queryRaw<{
    key: string; menuItemId: string | null; name: string; categoryId: string | null;
    units: DbInt; netCents: DbInt; grossCents: DbInt; orders: DbInt;
  }[]>(productsSql(scope));
  return rows.map((r) => ({
    key: r.key,
    menuItemId: r.menuItemId,
    name: r.name,
    categoryId: r.categoryId,
    units: toInt(r.units),
    netCents: toInt(r.netCents),
    grossCents: toInt(r.grossCents),
    orders: toInt(r.orders),
  }));
}

export async function loadCategories(client: SalesDb, scope: SalesScope): Promise<CategoryRow[]> {
  const rows = await client.$queryRaw<{
    categoryId: string | null; label: string | null; parentLabel: string | null;
    units: DbInt; netCents: DbInt; orders: DbInt;
  }[]>(categoriesSql(scope));
  return rows.map((r) => ({
    categoryId: r.categoryId,
    label: r.label,
    parentLabel: r.parentLabel,
    units: toInt(r.units),
    netCents: toInt(r.netCents),
    orders: toInt(r.orders),
  }));
}

export async function loadModifiers(client: SalesDb, scope: SalesScope, limit = 15): Promise<ModifierRow[]> {
  const rows = await client.$queryRaw<{ group: string | null; option: string; units: DbInt; products: DbInt }[]>(
    modifiersSql(scope, limit),
  );
  return rows.map((r) => ({ group: r.group, option: r.option, units: toInt(r.units), products: toInt(r.products) }));
}

export async function loadWaiters(client: SalesDb, scope: SalesScope): Promise<WaiterRow[]> {
  const rows = await client.$queryRaw<{
    waiterId: string | null; name: string | null; netCents: DbInt; orders: DbInt; diners: DbInt;
    tipCents: DbInt; commissionCents: DbInt;
  }[]>(waitersSql(scope));
  const item = hasItemFilter(scope);
  return rows.map((r) => ({
    waiterId: r.waiterId,
    name: r.name,
    netCents: toInt(r.netCents),
    orders: toInt(r.orders),
    diners: toInt(r.diners),
    tipCents: item ? null : toInt(r.tipCents),
    commissionCents: item ? null : toIntOrNull(r.commissionCents),
  }));
}

export async function loadMethods(client: SalesDb, scope: SalesScope): Promise<MethodRow[]> {
  const rows = await client.$queryRaw<{ method: string; amountCents: DbInt; tipCents: DbInt; payments: DbInt; orders: DbInt }[]>(
    methodsSql(scope),
  );
  return rows.map((r) => ({
    method: r.method as ReportingMethod,
    amountCents: toInt(r.amountCents),
    tipCents: toInt(r.tipCents),
    payments: toInt(r.payments),
    orders: toInt(r.orders),
  }));
}

export async function loadChannels(client: SalesDb, scope: SalesScope): Promise<ChannelRow[]> {
  const rows = await client.$queryRaw<{ channel: Channel; netCents: DbInt; orders: DbInt; diners: DbInt }[]>(channelsSql(scope));
  return rows.map((r) => ({ channel: r.channel, netCents: toInt(r.netCents), orders: toInt(r.orders), diners: toInt(r.diners) }));
}

export async function loadTables(client: SalesDb, scope: SalesScope, limit = 30): Promise<TableRow[]> {
  const rows = await client.$queryRaw<{
    tableId: string; number: DbInt; label: string | null; netCents: DbInt; orders: DbInt; diners: DbInt;
  }[]>(tablesSql(scope, limit));
  return rows.map((r) => ({
    tableId: r.tableId,
    number: toInt(r.number),
    label: r.label,
    netCents: toInt(r.netCents),
    orders: toInt(r.orders),
    diners: toInt(r.diners),
  }));
}

export async function loadDuration(client: SalesDb, scope: SalesScope): Promise<DurationSummary> {
  const [row] = await client.$queryRaw<{ median: number | null; measured: DbInt; eligible: DbInt }[]>(durationSql(scope));
  return {
    medianMinutes: row?.median === null || row?.median === undefined ? null : Math.round(Number(row.median)),
    measured: toInt(row?.measured),
    eligible: toInt(row?.eligible),
  };
}

export async function loadOrders(client: SalesDb, scope: SalesScope, limit: number): Promise<OrderListRow[]> {
  const rows = await client.$queryRaw<{
    id: string; shortCode: string; paidAt: Date; channel: Channel; tableNumber: DbInt; tableLabel: string | null;
    waiterName: string | null; diners: DbInt; units: DbInt; netCents: DbInt; tipCents: DbInt; totalCents: DbInt;
    methods: string[];
  }[]>(ordersSql(scope, limit));
  const item = hasItemFilter(scope);
  return rows.map((r) => ({
    id: r.id,
    shortCode: r.shortCode,
    paidAt: r.paidAt,
    channel: r.channel,
    tableNumber: toInt(r.tableNumber),
    tableLabel: r.tableLabel,
    waiterName: r.waiterName,
    diners: toInt(r.diners),
    units: toInt(r.units),
    netCents: toInt(r.netCents),
    tipCents: item ? null : toInt(r.tipCents),
    totalCents: toInt(r.totalCents),
    methods: (r.methods ?? []).sort() as ReportingMethod[],
  }));
}

/**
 * Notas crédito ACEPTADAS por la DIAN (no descartadas) emitidas en el rango
 * y reembolsos a tarjeta del rango, más toda la historia de las cuentas
 * involucradas (el cruce nota ↔ reembolso es cronológico). Pocas filas: son
 * documentos excepcionales. Si hay filtros de cuenta, sólo las cuentas que
 * los pasan.
 */
export async function loadReturnRows(
  client: SalesDb,
  scope: SalesScope,
): Promise<{ notes: CreditNoteRow[]; refunds: RefundRow[] }> {
  const accepted = {
    restaurantId: scope.restaurantId,
    abandonedAt: null,
    dianDocument: { is: { state: "accepted" } },
  } satisfies Prisma.CreditNoteWhereInput;
  const noteSelect = {
    id: true,
    subtotalCents: true,
    taxCents: true,
    totalCents: true,
    receivableCents: true,
    createdAt: true,
    dianDocument: { select: { issuedAt: true } },
    originalInvoice: { select: { orderId: true } },
  } as const;
  // `issuedAt` (o la creación si no se firmó) dentro del rango: se filtra
  // grueso en la base por cualquiera de los dos y fino abajo.
  const [notesInRange, refundsInRange] = await Promise.all([
    client.creditNote.findMany({
      where: {
        ...accepted,
        OR: [
          { dianDocument: { is: { state: "accepted", issuedAt: { gte: scope.start, lt: scope.end } } } },
          { createdAt: { gte: scope.start, lt: scope.end } },
        ],
      },
      select: noteSelect,
    }),
    client.kushkiTransaction.findMany({
      where: { restaurantId: scope.restaurantId, kind: "refund", createdAt: { gte: scope.start, lt: scope.end } },
      select: { id: true, amountCents: true, createdAt: true, payment: { select: { orderId: true } } },
    }),
  ]);
  const instant = (n: (typeof notesInRange)[number]) => n.dianDocument?.issuedAt ?? n.createdAt;
  const inRange = (at: Date) => at >= scope.start && at < scope.end;
  const candidates = new Set<string>([
    ...notesInRange.filter((n) => inRange(instant(n))).map((n) => n.originalInvoice.orderId),
    ...refundsInRange.map((r) => r.payment?.orderId).filter((x): x is string => !!x),
  ]);
  if (candidates.size === 0) return { notes: [], refunds: [] };
  const hasOrderFilter = Object.keys(scope.dims).length > 0;
  const orderIds = hasOrderFilter
    ? (await client.$queryRaw<{ id: string }[]>(filterOrderIdsSql(scope, [...candidates]))).map((r) => r.id)
    : [...candidates];
  if (orderIds.length === 0) return { notes: [], refunds: [] };
  const [allNotes, allRefunds] = await Promise.all([
    client.creditNote.findMany({
      where: { ...accepted, originalInvoice: { orderId: { in: orderIds } } },
      select: noteSelect,
    }),
    client.kushkiTransaction.findMany({
      where: { restaurantId: scope.restaurantId, kind: "refund", payment: { orderId: { in: orderIds } } },
      select: { id: true, amountCents: true, createdAt: true, payment: { select: { orderId: true } } },
    }),
  ]);
  return {
    notes: allNotes.map((n) => ({
      id: n.id,
      orderId: n.originalInvoice.orderId,
      at: instant(n),
      subtotalCents: n.subtotalCents,
      taxCents: n.taxCents,
      totalCents: n.totalCents,
      receivableCents: n.receivableCents,
      inRange: inRange(instant(n)),
    })),
    refunds: allRefunds.map((r) => ({
      id: r.id,
      orderId: r.payment?.orderId ?? null,
      at: r.createdAt,
      amountCents: r.amountCents,
      inRange: inRange(r.createdAt),
    })),
  };
}

/** Opciones de los filtros (nombres para los selectores y las migas). */
export async function loadFilterOptions(client: SalesDb, restaurantId: string): Promise<FilterOptions> {
  const [waiters, categories, products, tables] = await Promise.all([
    client.user.findMany({
      where: { restaurantId, role: "mesero" },
      select: { id: true, name: true, email: true, disabledAt: true },
      orderBy: [{ name: "asc" }, { email: "asc" }],
    }),
    client.category.findMany({
      where: { restaurantId },
      select: { id: true, label: true, sortOrder: true, parent: { select: { label: true } } },
      orderBy: [{ sortOrder: "asc" }, { label: "asc" }],
    }),
    client.menuItem.findMany({
      where: { restaurantId },
      select: { id: true, name: true, categoryId: true },
      orderBy: { name: "asc" },
    }),
    client.table.findMany({
      where: { restaurantId, kind: "standard" },
      select: { id: true, number: true, label: true },
      orderBy: { number: "asc" },
    }),
  ]);
  return {
    waiters: waiters.map((w) => ({
      id: w.id,
      name: w.name?.trim() || w.email || w.id,
      disabled: w.disabledAt !== null,
    })),
    categories: categories.map((c) => ({ id: c.id, label: c.label, parentLabel: c.parent?.label ?? null })),
    products,
    tables,
  };
}

/** Platos disponibles de la carta (para «sin ventas en el período»). */
export async function loadAvailableItems(
  client: SalesDb,
  restaurantId: string,
  categoryId?: string,
): Promise<{ id: string; name: string }[]> {
  return client.menuItem.findMany({
    where: { restaurantId, available: true, ...(categoryId ? { categoryId } : {}) },
    select: { id: true, name: true },
    orderBy: { name: "asc" },
  });
}
