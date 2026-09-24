import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { secureApi } from "@/lib/secureApi";
import { requireOperatorScope, isScopeError } from "@/lib/operatorScope";
import { rateLimit } from "@/lib/rateLimit";
import { billingCustomerSchema, BILLING_CUSTOMER_READ_ROLES, BILLING_CUSTOMER_WRITE_ROLES } from "@/lib/billingCustomers";
import { loadCustomersDebt } from "@/lib/customerCredit";

/**
 * Listado/búsqueda de clientes de facturación. Cada fila trae `debtCents`
 * (lo que debe por ventas a crédito) para la columna "Deuda" del listado y
 * el "Debe hoy" del cobro. `?credit=1` deja sólo los que tienen crédito
 * habilitado (el selector del cobro a crédito).
 */
async function GETHandler(req: Request) {
  const scope = await requireOperatorScope(BILLING_CUSTOMER_READ_ROLES);
  if (isScopeError(scope)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!await rateLimit(`billing-customers:read:${scope.restaurantId}:${scope.userId}`, 120, 60)) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429, headers: { "Retry-After": "60" } });
  }
  const params = new URL(req.url).searchParams;
  const q = (params.get("q") ?? "").trim().slice(0, 160);
  const creditOnly = params.get("credit") === "1";
  const documentQuery = q.replace(/[.\s]/g, "").replace(/-\d$/, "").toUpperCase();
  const rows = await db.billingCustomer.findMany({
    where: {
      restaurantId: scope.restaurantId,
      ...(creditOnly ? { creditEnabled: true } : {}),
      ...(q ? { OR: [
        { customerName: { contains: q, mode: "insensitive" as const } },
        { email: { contains: q, mode: "insensitive" as const } },
        ...(documentQuery ? [{ docNumber: { contains: documentQuery, mode: "insensitive" as const } }] : []),
      ] } : {}),
    },
    orderBy: [{ customerName: "asc" }, { id: "asc" }],
    take: 50,
  });
  const debt = rows.length > 0 ? await loadCustomersDebt(scope.restaurantId) : new Map<string, number>();
  const customers = rows.map((c) => ({ ...c, debtCents: debt.get(c.id) ?? 0 }));
  return NextResponse.json({ customers }, { headers: { "Cache-Control": "no-store" } });
}

async function POSTHandler(req: Request) {
  const scope = await requireOperatorScope(BILLING_CUSTOMER_WRITE_ROLES);
  if (isScopeError(scope)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const parsed = billingCustomerSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid", fieldErrors: parsed.error.flatten().fieldErrors }, { status: 400 });
  try {
    const customer = await db.billingCustomer.create({ data: { ...parsed.data, restaurantId: scope.restaurantId } });
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
