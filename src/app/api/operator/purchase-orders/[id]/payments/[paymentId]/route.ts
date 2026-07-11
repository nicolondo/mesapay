import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getErpContext, isDenied } from "@/lib/erp/access";
import { poTotals } from "@/lib/erp/purchaseTax";
import type { ModuleSlug } from "@/lib/modules";

export const dynamic = "force-dynamic";

const GATE: ModuleSlug[] = ["purchasing"];

/** Reversar un abono (corregir un error). Descuenta de paidCents y, si el
 *  saldo vuelve a ser > 0, quita la marca de pagada. */
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string; paymentId: string }> },
) {
  const ctx = await getErpContext(GATE);
  if (isDenied(ctx)) {
    return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  }
  const { id, paymentId } = await params;

  const result = await db.$transaction(async (tx) => {
    const payment = await tx.purchasePayment.findUnique({
      where: { id: paymentId },
      select: { id: true, restaurantId: true, purchaseOrderId: true, amountCents: true },
    });
    if (
      !payment ||
      payment.restaurantId !== ctx.restaurantId ||
      payment.purchaseOrderId !== id
    ) {
      return { error: "not_found" as const };
    }
    await tx.purchasePayment.delete({ where: { id: paymentId } });

    const po = await tx.purchaseOrder.findUniqueOrThrow({
      where: { id },
      select: {
        paidCents: true,
        items: { select: { receivedCostCents: true, taxPct: true } },
      },
    });
    const grossTotal = poTotals(
      po.items.map((i) => ({ costCents: i.receivedCostCents, taxPct: i.taxPct })),
    ).totalCents;
    const newPaid = Math.max(0, po.paidCents - payment.amountCents);
    const order = await tx.purchaseOrder.update({
      where: { id },
      data: {
        paidCents: newPaid,
        ...(newPaid < grossTotal ? { paidAt: null } : {}),
      },
    });
    return { order, totalCents: grossTotal, paidCents: newPaid, outstandingCents: grossTotal - newPaid };
  });

  if ("error" in result) {
    return NextResponse.json({ error: result.error }, { status: 404 });
  }
  return NextResponse.json({ ok: true, ...result });
}
