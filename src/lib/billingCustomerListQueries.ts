// Consulta de la lista de clientes de facturación: búsqueda, filtros, orden
// y paginación sobre TODOS los clientes del comercio, en la base. Las reglas
// puras (URL, ventana de página, resumen) viven en `billingCustomerList.ts`.
//
// ── Cómo se arma ──────────────────────────────────────────────────────────
// La deuda no es una columna: sale de los cargos a crédito (`Payment` con
// method = customer_credit) menos los abonos (`CustomerCreditPayment`). Para
// poder filtrar y ordenar por deuda sin traer todos los clientes a memoria,
// una sola consulta SQL agrega cargos y abonos por cliente (dos GROUP BY
// acotados al comercio) y los cruza con `BillingCustomer`:
//
//   deuda   = Σ max(0, monto − reembolsado − notas crédito) − Σ abonos
//   vencida = max(0, Σ cargos ya vencidos − Σ abonos)        (FIFO, ver
//             `overdueFromTotals`; mismo criterio que Cartera; un abono
//             dirigido a un cargo que aún no vence no cuenta)
//
// Se corren dos lecturas sobre esa base: el agregado (total y resumen de la
// lista filtrada, y si el comercio usa crédito) y la página (ids en orden,
// con desempate por id para que el orden sea estable entre páginas). Las
// filas completas se leen después por id con Prisma.
//
// Rendimiento: `BillingCustomer` se recorre por su índice
// [restaurantId, customerName]; los cargos van por Payment[billingCustomerId]
// y los abonos por CustomerCreditPayment[restaurantId, paidAt]. La búsqueda
// es un ILIKE sobre las filas del comercio (miles, no millones).
//
// Todo valor del usuario entra como parámetro (`Prisma.sql` + `${}`); las
// únicas piezas fijas de SQL son constantes de este archivo.
import "server-only";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { todayIso } from "@/lib/erp/reports/period";
import type { BillingCustomerRecord } from "@/components/billingCustomers/types";
import {
  CUSTOMER_PAGE_SIZE,
  docTypesForFilter,
  escapeLike,
  normalizeCustomerSearch,
  pageWindow,
  summaryFromAggregate,
  toCents,
  type CustomerListParams,
  type CustomerListSummary,
  type CustomerSort,
} from "@/lib/billingCustomerList";

export type BillingCustomerListRow = BillingCustomerRecord & {
  debtCents: number;
  /** Parte de la deuda cuyo plazo ya venció. */
  overdueCents: number;
  /** ISO. */
  createdAt: string;
};

export type BillingCustomerListPage = {
  rows: BillingCustomerListRow[];
  /** Clientes que cumplen los filtros (todas las páginas). */
  total: number;
  page: number;
  pageCount: number;
  pageSize: number;
  /** Rango visible, 1-based ("Mostrando from–to de total"). */
  from: number;
  to: number;
  summary: CustomerListSummary;
  /** El comercio vende a crédito (algún cliente con crédito o con cargos). */
  usesCredit: boolean;
  /** Clientes del comercio, sin filtros. */
  allCount: number;
};

export type BillingCustomerListOptions = {
  pageSize?: number;
  /** Sólo clientes con crédito habilitado (selector del cobro a crédito). */
  creditOnly?: boolean;
  /** Día del comercio (YYYY-MM-DD) para la deuda vencida. Hoy por defecto. */
  today?: string;
};

const CHARGE_DEBT = Prisma.sql`GREATEST(p."amountCents" - p."refundedCents" - p."creditNoteCents", 0)`;

/** Clientes del comercio con su deuda y su deuda vencida. */
function baseCte(restaurantId: string, today: string): Prisma.Sql {
  return Prisma.sql`
    WITH charged AS (
      SELECT p."billingCustomerId" AS "customerId",
             SUM(${CHARGE_DEBT})::bigint AS "chargedCents",
             SUM(CASE WHEN COALESCE(p."settledAt", p."createdAt")::date + bc."creditTermsDays" < ${today}::date
                      THEN ${CHARGE_DEBT} ELSE 0 END)::bigint AS "overdueChargedCents"
        FROM "Payment" p
        JOIN "Order" o ON o."id" = p."orderId"
        JOIN "BillingCustomer" bc ON bc."id" = p."billingCustomerId"
       WHERE o."restaurantId" = ${restaurantId}
         AND bc."restaurantId" = ${restaurantId}
         AND p."method" = 'customer_credit'
         AND p."status" IN ('approved', 'refunded')
       GROUP BY p."billingCustomerId"
    ),
    paid AS (
      -- Un abono DIRIGIDO a un cargo que todavía no vence (el link de pago
      -- de una factura manual) no baja la deuda vencida: se aplica a su
      -- cargo, no FIFO (ver customerCredit.allocateFifo).
      SELECT ccp."billingCustomerId" AS "customerId",
             SUM(ccp."amountCents")::bigint AS "paidCents",
             SUM(CASE WHEN ch."id" IS NOT NULL
                       AND COALESCE(ch."settledAt", ch."createdAt")::date + cbc."creditTermsDays" >= ${today}::date
                      THEN ccp."amountCents" ELSE 0 END)::bigint AS "paidNotOverdueCents"
        FROM "CustomerCreditPayment" ccp
        LEFT JOIN "Payment" ch ON ch."id" = ccp."creditChargeId"
        LEFT JOIN "BillingCustomer" cbc ON cbc."id" = ccp."billingCustomerId"
       WHERE ccp."restaurantId" = ${restaurantId}
       GROUP BY ccp."billingCustomerId"
    ),
    base AS (
      SELECT bc."id", bc."customerName", bc."docType", bc."docNumber", bc."email", bc."createdAt",
             bc."creditEnabled", bc."discountEnabled", bc."discountBps",
             COALESCE(ch."chargedCents", 0) - COALESCE(pd."paidCents", 0) AS "debtCents",
             GREATEST(COALESCE(ch."overdueChargedCents", 0) - (COALESCE(pd."paidCents", 0) - COALESCE(pd."paidNotOverdueCents", 0)), 0) AS "overdueCents"
        FROM "BillingCustomer" bc
        LEFT JOIN charged ch ON ch."customerId" = bc."id"
        LEFT JOIN paid pd ON pd."customerId" = bc."id"
       WHERE bc."restaurantId" = ${restaurantId}
    )`;
}

/**
 * Condición de los filtros sobre las columnas de `base`. Siempre devuelve
 * una expresión booleana (TRUE sin filtros) para poder usarla en un
 * `FILTER (WHERE …)`.
 */
export function customerFilterSql(
  params: Pick<CustomerListParams, "q" | "type" | "status">,
  options: Pick<BillingCustomerListOptions, "creditOnly"> = {},
): Prisma.Sql {
  const parts: Prisma.Sql[] = [];
  const types = docTypesForFilter(params.type);
  if (types) parts.push(Prisma.sql`"docType"::text IN (${Prisma.join([...types])})`);
  if (options.creditOnly || params.status === "credit") parts.push(Prisma.sql`"creditEnabled"`);
  if (params.status === "debt") parts.push(Prisma.sql`"debtCents" > 0`);
  if (params.status === "overdue") parts.push(Prisma.sql`"overdueCents" > 0`);
  if (params.status === "discount") parts.push(Prisma.sql`("discountEnabled" AND "discountBps" > 0)`);
  const { text, document } = normalizeCustomerSearch(params.q);
  if (text) {
    const like = `%${escapeLike(text)}%`;
    const match = [
      Prisma.sql`"customerName" ILIKE ${like}`,
      Prisma.sql`"email" ILIKE ${like}`,
      ...(document ? [Prisma.sql`"docNumber" ILIKE ${`%${escapeLike(document)}%`}`] : []),
    ];
    parts.push(Prisma.sql`(${Prisma.join(match, " OR ")})`);
  }
  return parts.length ? Prisma.join(parts, " AND ") : Prisma.sql`TRUE`;
}

/** ORDER BY de cada orden, siempre con desempate por id (orden estable). */
export function customerOrderSql(sort: CustomerSort, q: string): Prisma.Sql {
  switch (sort) {
    case "debt":
      return Prisma.sql`"debtCents" DESC, "customerName" ASC, "id" ASC`;
    case "recent":
      return Prisma.sql`"createdAt" DESC, "id" DESC`;
    case "relevance": {
      const { text, document } = normalizeCustomerSearch(q);
      if (!text) return Prisma.sql`"customerName" ASC, "id" ASC`;
      return Prisma.sql`(upper("docNumber") = ${document}) DESC, ("customerName" ILIKE ${`${escapeLike(text)}%`}) DESC, "customerName" ASC, "id" ASC`;
    }
    default:
      return Prisma.sql`"customerName" ASC, "id" ASC`;
  }
}

type AggregateRow = Record<string, unknown> & { allCount: unknown; usesCredit: boolean | null };
type IdRow = { id: string; debtCents: unknown; overdueCents: unknown };

/**
 * Una página de clientes del comercio con los filtros de `params`, más el
 * total y el resumen de TODA la lista filtrada. El `restaurantId` sale
 * siempre de la sesión de quien llama, nunca de la URL.
 */
export async function loadBillingCustomerPage(
  restaurantId: string,
  params: CustomerListParams,
  options: BillingCustomerListOptions = {},
): Promise<BillingCustomerListPage> {
  const pageSize = options.pageSize ?? CUSTOMER_PAGE_SIZE;
  const base = baseCte(restaurantId, options.today ?? todayIso());
  const filter = customerFilterSql(params, options);

  const [aggregate] = await db.$queryRaw<AggregateRow[]>(Prisma.sql`
    ${base}
    SELECT COUNT(*) FILTER (WHERE "match")::int AS "count",
           COUNT(*) FILTER (WHERE "match" AND "creditEnabled")::int AS "creditCount",
           COUNT(*) FILTER (WHERE "match" AND "debtCents" > 0)::int AS "debtorCount",
           COUNT(*) FILTER (WHERE "match" AND "overdueCents" > 0)::int AS "overdueCount",
           COALESCE(SUM(GREATEST("debtCents", 0)) FILTER (WHERE "match"), 0)::bigint AS "debtCents",
           COALESCE(SUM("overdueCents") FILTER (WHERE "match"), 0)::bigint AS "overdueCents",
           COUNT(*)::int AS "allCount",
           (COALESCE(BOOL_OR("creditEnabled"), false) OR EXISTS (SELECT 1 FROM charged)) AS "usesCredit"
      FROM (SELECT base.*, (${filter}) AS "match" FROM base) filtered`);
  const summary = summaryFromAggregate(aggregate);
  const window = pageWindow(params.page, summary.count, pageSize);

  const ids =
    summary.count === 0
      ? []
      : await db.$queryRaw<IdRow[]>(Prisma.sql`
          ${base}
          SELECT "id", "debtCents", "overdueCents"
            FROM base
           WHERE ${filter}
           ORDER BY ${customerOrderSql(params.sort, params.q)}
           LIMIT ${pageSize} OFFSET ${window.offset}`);

  const records = ids.length
    ? await db.billingCustomer.findMany({
        where: { restaurantId, id: { in: ids.map((r) => r.id) } },
      })
    : [];
  const byId = new Map(records.map((r) => [r.id, r]));
  const rows: BillingCustomerListRow[] = [];
  for (const r of ids) {
    const record = byId.get(r.id);
    if (!record) continue;
    rows.push({
      id: record.id,
      customerName: record.customerName,
      docType: record.docType,
      docNumber: record.docNumber,
      verificationDigit: record.verificationDigit,
      email: record.email,
      ccEmails: record.ccEmails ?? [],
      phone: record.phone,
      address: record.address,
      municipalityCode: record.municipalityCode,
      city: record.city,
      department: record.department,
      country: record.country,
      creditEnabled: record.creditEnabled,
      creditLimitCents: record.creditLimitCents,
      creditTermsDays: record.creditTermsDays,
      discountEnabled: record.discountEnabled,
      discountBps: record.discountBps,
      debtCents: toCents(r.debtCents),
      overdueCents: toCents(r.overdueCents),
      createdAt: record.createdAt.toISOString(),
    });
  }

  return {
    rows,
    total: summary.count,
    page: window.page,
    pageCount: window.pageCount,
    pageSize,
    from: window.from,
    to: window.to,
    summary,
    usesCredit: Boolean(aggregate?.usesCredit),
    allCount: toCents(aggregate?.allCount),
  };
}
