import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { secureApi } from "@/lib/secureApi";
import { requireOperatorScope, isScopeError } from "@/lib/operatorScope";
import { rateLimit } from "@/lib/rateLimit";
import { billingCustomerSchema, BILLING_CUSTOMER_READ_ROLES, BILLING_CUSTOMER_WRITE_ROLES } from "@/lib/billingCustomers";

async function GETHandler(req: Request) {
  const scope = await requireOperatorScope(BILLING_CUSTOMER_READ_ROLES);
  if (isScopeError(scope)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!await rateLimit(`billing-customers:read:${scope.restaurantId}:${scope.userId}`, 120, 60)) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429, headers: { "Retry-After": "60" } });
  }
  const q = (new URL(req.url).searchParams.get("q") ?? "").trim().slice(0, 160);
  const documentQuery = q.replace(/[.\s]/g, "").replace(/-\d$/, "").toUpperCase();
  const customers = await db.billingCustomer.findMany({
    where: {
      restaurantId: scope.restaurantId,
      ...(q ? { OR: [
        { customerName: { contains: q, mode: "insensitive" as const } },
        { email: { contains: q, mode: "insensitive" as const } },
        ...(documentQuery ? [{ docNumber: { contains: documentQuery, mode: "insensitive" as const } }] : []),
      ] } : {}),
    },
    orderBy: [{ customerName: "asc" }, { id: "asc" }],
    take: 50,
  });
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
