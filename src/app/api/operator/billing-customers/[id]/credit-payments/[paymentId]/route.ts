import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { secureApi } from "@/lib/secureApi";
import { requireOperatorScope, isScopeError } from "@/lib/operatorScope";
import { BILLING_CUSTOMER_WRITE_ROLES } from "@/lib/billingCustomers";

export const dynamic = "force-dynamic";

/**
 * Reversar un abono mal registrado. Borrar la fila alcanza: la deuda y el
 * asiento del mes se recalculan a partir de lo que queda. El scope va en el
 * where, así un id ajeno "no existe".
 */
async function DELETEHandler(
  _req: Request,
  { params }: { params: Promise<{ id: string; paymentId: string }> },
) {
  const scope = await requireOperatorScope(BILLING_CUSTOMER_WRITE_ROLES);
  if (isScopeError(scope)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id, paymentId } = await params;
  const deleted = await db.customerCreditPayment.deleteMany({
    where: { id: paymentId, billingCustomerId: id, restaurantId: scope.restaurantId },
  });
  if (deleted.count === 0) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}

export const DELETE = secureApi(DELETEHandler);
