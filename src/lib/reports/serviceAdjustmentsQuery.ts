import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import type {
  ServiceReportFilters, ServiceReportResult, ServiceReportRow, ServiceReportTotals,
} from "./serviceAdjustments";

type DbInteger = bigint | number;
type RawRow = Omit<ServiceReportRow, "quantity" | "lineCount" | "amountCents" | "detailAmountCents"> & {
  quantity: DbInteger;
  lineCount: DbInteger;
  amountCents: DbInteger | null;
  detailAmountCents: DbInteger;
};
type RawTotals = { [Key in keyof ServiceReportTotals]: DbInteger };
type Cursor = { eventAt: Date; id: string };

const ROW_COLUMNS = Prisma.sql`
  "id", "eventAt", "orderId", "shortCode", "tableNumber", "tableLabel", "name",
  "kind", "reason", "actorEmail", "quantity", "lineCount", "amountCents",
  "detailAmountCents", "missingDetail"`;
const EXPORT_BATCH_SIZE = 500;

function integer(value: DbInteger): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new Error("service_report_integer_out_of_range");
  return number;
}

function rowFromDb(row: RawRow): ServiceReportRow {
  return {
    ...row,
    quantity: integer(row.quantity), lineCount: integer(row.lineCount),
    amountCents: row.amountCents === null ? null : integer(row.amountCents),
    detailAmountCents: integer(row.detailAmountCents),
  };
}

function totalsFromDb(totals: RawTotals): ServiceReportTotals {
  return Object.fromEntries(Object.entries(totals).map(([key, value]) => [key, integer(value)])) as ServiceReportTotals;
}

/** User search is a literal substring: %, _ and backslash never become wildcards. */
function searchPattern(query: string | null): string | null {
  return query ? `%${query.replace(/[\\%_]/g, character => `\\${character}`)}%` : null;
}

function datePredicate(column: Prisma.Sql, filters: ServiceReportFilters, upper?: Date): Prisma.Sql {
  const conditions = [Prisma.sql`${column} IS NOT NULL`];
  if (filters.start) conditions.push(Prisma.sql`${column} >= ${filters.start}`);
  if (filters.end) conditions.push(Prisma.sql`${column} < ${filters.end}`);
  if (upper) conditions.push(Prisma.sql`${column} <= ${upper}`);
  return Prisma.join(conditions, " AND ");
}

function orderPredicate(restaurantId: string, filters: ServiceReportFilters): Prisma.Sql {
  return filters.orderId
    ? Prisma.sql`o."restaurantId" = ${restaurantId} AND o."id" = ${filters.orderId}`
    : Prisma.sql`o."restaurantId" = ${restaurantId}`;
}

/** A later account cancellation can stamp an item already removed by its round. */
const ITEM_IS_FIRST = Prisma.sql`(
  r."status" IS DISTINCT FROM 'cancelled' OR r."cancelledAt" IS NULL
  OR i."cancelledAt" <= r."cancelledAt"
)`;

function itemSource(restaurantId: string, filters: ServiceReportFilters, upper?: Date): Prisma.Sql {
  return Prisma.sql`
    scoped_orders AS MATERIALIZED (
      SELECT o."id", o."shortCode", o."compedAt", t."number" AS "tableNumber", t."label" AS "tableLabel"
      FROM "Order" o JOIN "Table" t ON t."id" = o."tableId"
      WHERE ${orderPredicate(restaurantId, filters)}
    ), report_rows AS (
      SELECT i."id", i."cancelledAt" AS "eventAt", o."id" AS "orderId", o."shortCode",
        o."tableNumber", o."tableLabel", i."nameSnapshot" AS "name",
        CASE WHEN i."cancellationKind" = 'comp' AND i."cancelledAt" = o."compedAt" THEN 'order_comp'
          WHEN i."cancellationKind" = 'comp' THEN 'item_comp' ELSE 'item_cancel' END AS "kind",
        NULLIF(BTRIM(i."cancellationReason"), '') AS "reason",
        NULLIF(BTRIM(i."cancelledByEmail"), '') AS "actorEmail",
        i."qty"::bigint AS "quantity", 1::bigint AS "lineCount",
        i."priceCentsSnapshot"::bigint * i."qty" AS "amountCents",
        i."priceCentsSnapshot"::bigint * i."qty" AS "detailAmountCents",
        false AS "missingDetail", false AS "productMatches"
      FROM scoped_orders o JOIN "OrderItem" i ON i."orderId" = o."id"
      LEFT JOIN "Round" r ON r."id" = i."roundId" AND r."orderId" = o."id"
      WHERE ${datePredicate(Prisma.sql`i."cancelledAt"`, filters, upper)} AND ${ITEM_IS_FIRST}
      UNION ALL
      SELECT i."id", r."cancelledAt" AS "eventAt", o."id" AS "orderId", o."shortCode",
        o."tableNumber", o."tableLabel", i."nameSnapshot" AS "name", 'round_cancel' AS "kind",
        NULLIF(BTRIM(r."cancellationReason"), '') AS "reason",
        NULLIF(BTRIM(r."cancelledByEmail"), '') AS "actorEmail",
        i."qty"::bigint AS "quantity", 1::bigint AS "lineCount",
        i."priceCentsSnapshot"::bigint * i."qty" AS "amountCents",
        i."priceCentsSnapshot"::bigint * i."qty" AS "detailAmountCents",
        false AS "missingDetail", false AS "productMatches"
      FROM scoped_orders o JOIN "Round" r ON r."orderId" = o."id"
      JOIN "OrderItem" i ON i."roundId" = r."id" AND i."orderId" = o."id"
      WHERE r."status" = 'cancelled' AND ${datePredicate(Prisma.sql`r."cancelledAt"`, filters, upper)}
        AND (i."cancelledAt" IS NULL OR r."cancelledAt" < i."cancelledAt")
    )`;
}

function accountSource(restaurantId: string, filters: ServiceReportFilters, upper?: Date): Prisma.Sql {
  const pattern = searchPattern(filters.q);
  return Prisma.sql`
    report_rows AS (
      SELECT o."id", o."compedAt" AS "eventAt", o."id" AS "orderId", o."shortCode",
        t."number" AS "tableNumber", t."label" AS "tableLabel", NULLIF(BTRIM(o."compLabel"), '') AS "name", 'order_comp' AS "kind",
        NULLIF(CONCAT_WS(': ', NULLIF(BTRIM(o."compLabel"), ''), NULLIF(BTRIM(o."compNote"), '')), '') AS "reason",
        COALESCE(d."actorEmail", a."actorEmail") AS "actorEmail", d."quantity", d."lineCount",
        COALESCE(o."compAmountCents"::bigint, CASE WHEN d."lineCount" > 0 THEN d."detailAmountCents" END) AS "amountCents",
        d."detailAmountCents",
        ((o."compAmountCents" IS NULL AND d."lineCount" = 0)
          OR (o."compAmountCents" IS NOT NULL AND o."compAmountCents" <> d."detailAmountCents")) AS "missingDetail",
        d."productMatches"
      FROM "Order" o JOIN "Table" t ON t."id" = o."tableId"
      LEFT JOIN LATERAL (
        SELECT COUNT(*)::bigint AS "lineCount", COALESCE(SUM(i."qty"), 0)::bigint AS "quantity",
          COALESCE(SUM(i."priceCentsSnapshot"::bigint * i."qty"), 0)::bigint AS "detailAmountCents",
          MIN(NULLIF(BTRIM(i."cancelledByEmail"), '')) AS "actorEmail",
          ${pattern ? Prisma.sql`BOOL_OR(i."nameSnapshot" ILIKE ${pattern})` : Prisma.sql`false`} AS "productMatches"
        FROM "OrderItem" i LEFT JOIN "Round" r ON r."id" = i."roundId" AND r."orderId" = o."id"
        WHERE i."orderId" = o."id" AND i."cancellationKind" = 'comp' AND i."cancelledAt" = o."compedAt"
          AND ${ITEM_IS_FIRST}
      ) d ON true
      LEFT JOIN LATERAL (
        SELECT NULLIF(BTRIM(ae."actorEmail"), '') AS "actorEmail"
        FROM "AuditEvent" ae
        WHERE d."actorEmail" IS NULL AND ae."restaurantId" = ${restaurantId}
          AND ae."kind" = 'order.comp' AND ae."targetType" = 'order' AND ae."targetId" = o."id"
          AND NULLIF(BTRIM(ae."actorEmail"), '') IS NOT NULL
        ORDER BY ae."occurredAt" ASC, ae."id" ASC LIMIT 1
      ) a ON true
      WHERE ${orderPredicate(restaurantId, filters)} AND ${datePredicate(Prisma.sql`o."compedAt"`, filters, upper)}
    )`;
}

/** Shared by aggregates, pages and export so all three obey exactly the same filters. */
function reportSource(restaurantId: string, filters: ServiceReportFilters, upper?: Date): Prisma.Sql {
  const accounts = filters.report === "representation" && filters.view === "orders";
  const source = accounts ? accountSource(restaurantId, filters, upper) : itemSource(restaurantId, filters, upper);
  const kind = filters.report === "representation" ? "representation" : filters.kind;
  const conditions: Prisma.Sql[] = [];
  if (kind === "representation") conditions.push(Prisma.sql`r."kind" = 'order_comp'`);
  if (kind === "comp") conditions.push(Prisma.sql`r."kind" = 'item_comp'`);
  if (kind === "cancel") conditions.push(Prisma.sql`r."kind" IN ('item_cancel', 'round_cancel')`);
  if (filters.email) conditions.push(Prisma.sql`LOWER(r."actorEmail") = LOWER(${filters.email})`);
  const pattern = searchPattern(filters.q);
  if (pattern) conditions.push(Prisma.sql`(
    r."name" ILIKE ${pattern} OR r."reason" ILIKE ${pattern} OR r."shortCode" ILIKE ${pattern}
    OR r."tableLabel" ILIKE ${pattern} OR r."tableNumber"::text ILIKE ${pattern}
    OR r."actorEmail" ILIKE ${pattern} OR r."productMatches"
  )`);
  return Prisma.sql`WITH ${source}, filtered_rows AS (
    SELECT * FROM report_rows r ${conditions.length ? Prisma.sql`WHERE ${Prisma.join(conditions, " AND ")}` : Prisma.empty}
  )`;
}

function totalsQuery(source: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`${source}
    SELECT COUNT(*)::bigint AS "rowCount", COUNT(DISTINCT "orderId")::bigint AS "orderCount",
      COALESCE(SUM("lineCount"), 0)::bigint AS "lineCount", COALESCE(SUM("quantity"), 0)::bigint AS "quantity",
      COALESCE(SUM("amountCents"), 0)::bigint AS "amountCents",
      COUNT(*) FILTER (WHERE "amountCents" IS NULL)::bigint AS "unknownAmountCount",
      COALESCE(SUM("amountCents") FILTER (WHERE "kind" IN ('item_cancel', 'round_cancel')), 0)::bigint AS "cancelAmountCents",
      COALESCE(SUM("amountCents") FILTER (WHERE "kind" = 'item_comp'), 0)::bigint AS "compAmountCents",
      COALESCE(SUM("amountCents") FILTER (WHERE "kind" = 'order_comp'), 0)::bigint AS "representationAmountCents"
    FROM filtered_rows`;
}

export async function getServiceReport(restaurantId: string, filters: ServiceReportFilters): Promise<ServiceReportResult> {
  const pageSize = Number.isInteger(filters.pageSize) ? Math.max(1, Math.min(100, filters.pageSize)) : 50;
  const requestedPage = Number.isInteger(filters.page) ? Math.max(1, filters.page) : 1;
  const source = reportSource(restaurantId, filters);
  return db.$transaction(async tx => {
    const [rawTotals] = await tx.$queryRaw<RawTotals[]>(totalsQuery(source));
    const totals = totalsFromDb(rawTotals);
    const pageCount = Math.max(1, Math.ceil(totals.rowCount / pageSize));
    const page = Math.min(requestedPage, pageCount);
    const rows = await tx.$queryRaw<RawRow[]>(Prisma.sql`${source}
      SELECT ${ROW_COLUMNS} FROM filtered_rows ORDER BY "eventAt" DESC, "id" DESC
      LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`);
    return { rows: rows.map(rowFromDb), totals, page, pageSize, pageCount };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 30000 });
}

/**
 * Export all matching rows in bounded batches, independent of the displayed page.
 * Later timestamps are excluded after starting; this is not a snapshot of backdated
 * corrections made during a long download. Each key occurs at most once.
 */
export async function* iterateServiceReportRows(
  restaurantId: string, filters: ServiceReportFilters,
): AsyncGenerator<ServiceReportRow> {
  const source = reportSource(restaurantId, filters, new Date());
  let cursor: Cursor | null = null;
  while (true) {
    const after = cursor
      ? Prisma.sql`WHERE ("eventAt", "id") < (${cursor.eventAt}::timestamp, ${cursor.id})`
      : Prisma.empty;
    const rows: RawRow[] = await db.$queryRaw<RawRow[]>(Prisma.sql`${source}
      SELECT ${ROW_COLUMNS} FROM filtered_rows ${after}
      ORDER BY "eventAt" DESC, "id" DESC LIMIT ${EXPORT_BATCH_SIZE}`);
    for (const row of rows) yield rowFromDb(row);
    if (rows.length < EXPORT_BATCH_SIZE) return;
    const last = rows[rows.length - 1];
    cursor = { eventAt: last.eventAt, id: last.id };
  }
}
