import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { secureApi } from "@/lib/secureApi";
import { requireOperatorScope, isScopeError } from "@/lib/operatorScope";
import { billingCustomerSchema, BILLING_CUSTOMER_WRITE_ROLES } from "@/lib/billingCustomers";

async function PATCHHandler(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const scope = await requireOperatorScope(BILLING_CUSTOMER_WRITE_ROLES);
  if (isScopeError(scope)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;
  const parsed = billingCustomerSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid", fieldErrors: parsed.error.flatten().fieldErrors }, { status: 400 });
  try {
    // Scope is part of the atomic write, so a foreign id cannot be updated.
    const customer = await db.billingCustomer.update({ where: { id, restaurantId: scope.restaurantId }, data: parsed.data });
    return NextResponse.json({ customer });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      if (error.code === "P2002") return NextResponse.json({ error: "duplicate_document" }, { status: 409 });
      if (error.code === "P2025") return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    throw error;
  }
}

export const PATCH = secureApi(PATCHHandler);
