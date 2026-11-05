// Consulta de la pestaña "Comensales registrados": búsqueda, orden por
// consumo y paginación sobre TODOS los comensales del comercio, en la base.
//
// El consumo sale de las órdenes pagadas de ESTE restaurante (un GROUP BY
// por Order[restaurantId, status]); los comensales, de Diner[restaurantId].
// El `restaurantId` es siempre el de la sesión, nunca de la URL: un
// comensal de otro comercio no existe para este.
import "server-only";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { escapeLike, pageWindow, toCents } from "@/lib/billingCustomerList";
import { normalizeCedula } from "@/lib/customerIdentity";
import { DINER_PAGE_SIZE, type DinerListParams, type DinerListSummary, type DinerSort } from "@/lib/dinerList";

export type DinerListRow = {
  id: string;
  name: string | null;
  email: string;
  cedula: string | null;
  /** ISO. */
  createdAt: string;
  disabled: boolean;
  orders: number;
  totalCents: number;
  /** Descuento activo del comensal, en %; null sin descuento. */
  discountPct: number | null;
};

export type DinerListPage = {
  rows: DinerListRow[];
  total: number;
  page: number;
  pageCount: number;
  pageSize: number;
  from: number;
  to: number;
  summary: DinerListSummary;
  allCount: number;
};

function baseCte(restaurantId: string): Prisma.Sql {
  return Prisma.sql`
    WITH spend AS (
      SELECT "dinerId", COUNT(*)::int AS "orders", SUM("totalCents")::bigint AS "totalCents"
        FROM "Order"
       WHERE "restaurantId" = ${restaurantId} AND "status" = 'paid' AND "dinerId" IS NOT NULL
       GROUP BY "dinerId"
    ),
    base AS (
      SELECT d."id", d."name", d."email", d."cedula", d."createdAt", d."disabledAt",
             COALESCE(s."orders", 0) AS "orders", COALESCE(s."totalCents", 0) AS "totalCents"
        FROM "Diner" d
        LEFT JOIN spend s ON s."dinerId" = d."id"
       WHERE d."restaurantId" = ${restaurantId}
    )`;
}

export function dinerFilterSql(q: string): Prisma.Sql {
  const text = q.trim();
  if (!text) return Prisma.sql`TRUE`;
  const like = `%${escapeLike(text)}%`;
  const cedula = normalizeCedula(text);
  const match = [
    Prisma.sql`"name" ILIKE ${like}`,
    Prisma.sql`"email" ILIKE ${like}`,
    ...(cedula ? [Prisma.sql`"cedula" ILIKE ${`%${escapeLike(cedula)}%`}`] : []),
  ];
  return Prisma.sql`(${Prisma.join(match, " OR ")})`;
}

export function dinerOrderSql(sort: DinerSort): Prisma.Sql {
  switch (sort) {
    case "recent":
      return Prisma.sql`"createdAt" DESC, "id" DESC`;
    case "name":
      return Prisma.sql`COALESCE("name", "email") ASC, "id" ASC`;
    default:
      // Los que más consumieron arriba; los que no, por registro reciente.
      return Prisma.sql`"totalCents" DESC, "createdAt" DESC, "id" DESC`;
  }
}

type PageRow = {
  id: string;
  name: string | null;
  email: string;
  cedula: string | null;
  createdAt: Date;
  disabledAt: Date | null;
  orders: number;
  totalCents: unknown;
  discountPct: number | null;
};

export async function loadDinerPage(
  restaurantId: string,
  params: DinerListParams,
  options: { pageSize?: number } = {},
): Promise<DinerListPage> {
  const pageSize = options.pageSize ?? DINER_PAGE_SIZE;
  const base = baseCte(restaurantId);
  const filter = dinerFilterSql(params.q);
  const [aggregate] = await db.$queryRaw<Record<string, unknown>[]>(Prisma.sql`
    ${base}
    SELECT COUNT(*) FILTER (WHERE "match")::int AS "count",
           COUNT(*) FILTER (WHERE "match" AND "orders" > 0)::int AS "withOrders",
           COALESCE(SUM("totalCents") FILTER (WHERE "match"), 0)::bigint AS "totalCents",
           COUNT(*)::int AS "allCount"
      FROM (SELECT base.*, (${filter}) AS "match" FROM base) filtered`);
  const summary: DinerListSummary = {
    count: toCents(aggregate?.count),
    withOrders: toCents(aggregate?.withOrders),
    totalCents: toCents(aggregate?.totalCents),
  };
  const window = pageWindow(params.page, summary.count, pageSize);
  const rows =
    summary.count === 0
      ? []
      : await db.$queryRaw<PageRow[]>(Prisma.sql`
          ${base}
          SELECT base.*,
                 (SELECT dd."percent" FROM "DinerDiscount" dd
                   WHERE dd."dinerId" = base."id" AND dd."active") AS "discountPct"
            FROM base
           WHERE ${filter}
           ORDER BY ${dinerOrderSql(params.sort)}
           LIMIT ${pageSize} OFFSET ${window.offset}`);
  return {
    rows: rows.map((r) => ({
      id: r.id,
      name: r.name,
      email: r.email,
      cedula: r.cedula,
      createdAt: new Date(r.createdAt).toISOString(),
      disabled: r.disabledAt != null,
      orders: Number(r.orders),
      totalCents: toCents(r.totalCents),
      discountPct: r.discountPct ?? null,
    })),
    total: summary.count,
    page: window.page,
    pageCount: window.pageCount,
    pageSize,
    from: window.from,
    to: window.to,
    summary,
    allCount: toCents(aggregate?.allCount),
  };
}
