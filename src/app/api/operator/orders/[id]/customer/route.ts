import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { secureApi } from "@/lib/secureApi";
import { publishOrderEvent } from "@/lib/events";
import { requireOperatorScope, isScopeError } from "@/lib/operatorScope";
import { applyCustomerDiscount } from "@/lib/customerDiscount";
import { loadCustomerCreditSummary } from "@/lib/customerCredit";

const schema = z.object({ billingCustomerId: z.string().min(1).max(64) });

/**
 * POST /api/operator/orders/[id]/customer — el staff asocia la cuenta a un
 * cliente de facturación en el cobro (paso opcional "Cliente", cualquier
 * medio de pago). Si el cliente tiene descuento comercial, se aplica acá
 * con el mecanismo del descuento por comensal (`applyCustomerDiscount`);
 * si la cuenta ya tenía uno mayor, se conserva y se avisa. Devuelve el
 * cliente con su deuda de crédito para que la pantalla de cobro muestre
 * "Debe hoy" y preseleccione el cobro a crédito.
 */
async function POSTHandler(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const scope = await requireOperatorScope();
  if (isScopeError(scope)) {
    return NextResponse.json({ error: scope.error }, { status: scope.error === "forbidden" ? 403 : 400 });
  }
  const { id: orderId } = await params;
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid" }, { status: 400 });

  const order = await db.order.findFirst({
    where: { id: orderId, restaurantId: scope.restaurantId },
    select: { id: true },
  });
  if (!order) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const customer = await db.billingCustomer.findFirst({
    where: { id: parsed.data.billingCustomerId, restaurantId: scope.restaurantId },
    select: {
      id: true,
      customerName: true,
      docType: true,
      docNumber: true,
      verificationDigit: true,
      creditEnabled: true,
      creditLimitCents: true,
      creditTermsDays: true,
      discountEnabled: true,
      discountBps: true,
    },
  });
  if (!customer) return NextResponse.json({ error: "customer_not_found" }, { status: 404 });

  const discount = await db.$transaction((tx) =>
    applyCustomerDiscount(tx, order.id, scope.restaurantId, customer),
  );
  if (discount.applied && discount.changed) {
    publishOrderEvent(scope.restaurantId, { type: "order.updated", orderId: order.id });
  }
  const credit = await loadCustomerCreditSummary(scope.restaurantId, customer.id);
  return NextResponse.json({
    ok: true,
    customer: { ...customer, debtCents: credit?.debtCents ?? 0 },
    discount,
  });
}

export const POST = secureApi(POSTHandler);
