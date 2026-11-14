import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { secureApi } from "@/lib/secureApi";
import { requireOperatorScope, isScopeError } from "@/lib/operatorScope";
import { rateLimit } from "@/lib/rateLimit";
import { billingCustomerSchema, BILLING_CUSTOMER_READ_ROLES, BILLING_CUSTOMER_WRITE_ROLES } from "@/lib/billingCustomers";
import { parseCustomerListParams, parsePageSize } from "@/lib/billingCustomerList";
import { loadBillingCustomerPage } from "@/lib/billingCustomerListQueries";
import { recordAuditEvent } from "@/lib/auditLog";

/**
 * Listado/búsqueda de clientes de facturación, paginado en el servidor
 * sobre TODOS los clientes del comercio (antes devolvía los primeros 50 por
 * nombre y nada más). Lo usa el buscador de clientes del cobro y de la
 * factura (`CustomerPicker`), con "Ver más".
 *
 *   ?q=        nombre, documento (con o sin puntos/DV) o correo
 *   ?credit=1  sólo los que tienen crédito habilitado (cobro a crédito)
 *   ?type= ?status= ?sort=   los mismos filtros de /operator/clientes;
 *              sort=relevance pone primero el documento exacto
 *   ?page= ?pageSize=        1-based; pageSize ≤ 50
 *
 * Cada fila trae `debtCents` (lo que debe) y `overdueCents` (lo vencido).
 * La respuesta dice cuántos hay en total y si hay más páginas, para que
 * ningún buscador corte la lista sin avisar.
 */
async function GETHandler(req: Request) {
  const scope = await requireOperatorScope(BILLING_CUSTOMER_READ_ROLES);
  if (isScopeError(scope)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!await rateLimit(`billing-customers:read:${scope.restaurantId}:${scope.userId}`, 120, 60)) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429, headers: { "Retry-After": "60" } });
  }
  const search = new URL(req.url).searchParams;
  const params = parseCustomerListParams(Object.fromEntries(search));
  const list = await loadBillingCustomerPage(
    scope.restaurantId,
    { ...params, sort: search.get("sort") === "relevance" ? "relevance" : params.sort },
    { pageSize: parsePageSize(search.get("pageSize")), creditOnly: search.get("credit") === "1" },
  );
  return NextResponse.json(
    {
      customers: list.rows,
      total: list.total,
      page: list.page,
      pageCount: list.pageCount,
      pageSize: list.pageSize,
      hasMore: list.page < list.pageCount,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}

async function POSTHandler(req: Request) {
  const scope = await requireOperatorScope(BILLING_CUSTOMER_WRITE_ROLES);
  if (isScopeError(scope)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const parsed = billingCustomerSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid", fieldErrors: parsed.error.flatten().fieldErrors }, { status: 400 });
  try {
    const customer = await db.billingCustomer.create({ data: { ...parsed.data, restaurantId: scope.restaurantId } });
    await recordAuditEvent({
      kind: "billing_customer.create",
      restaurantId: scope.restaurantId,
      target: { type: "billing_customer", id: customer.id },
      diff: { after: { source: "customers" } },
    });
    return NextResponse.json({ customer }, { status: 201 });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return NextResponse.json({ error: "duplicate_document" }, { status: 409 });
    }
    throw error;
  }
}

export const GET = secureApi(GETHandler);
export const POST = secureApi(POSTHandler);
