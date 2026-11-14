import { secureApi } from "@/lib/secureApi";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getErpContext, isDenied } from "@/lib/erp/access";
import { PURCHASE_LINE_AMOUNTS_SELECT, PURCHASE_ORDER_TAX_SELECT, purchaseOrderTotals } from "@/lib/erp/purchaseTax";
import type { ModuleSlug } from "@/lib/modules";
import { SupplierCreditError } from "@/lib/erp/supplierCreditNoteService";
import { voidSupplierPayment } from "@/lib/erp/supplierPaymentService";

export const dynamic = "force-dynamic";

const GATE: ModuleSlug[] = ["purchasing"];

/** Reversar un abono (corregir un error). Descuenta de paidCents y, si el
 *  saldo vuelve a ser > 0, quita la marca de pagada. */
async function DELETEHandler(
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
      select: {
        id: true,
        restaurantId: true,
        purchaseOrderId: true,
        amountCents: true,
        supplierCreditNoteId: true,
        supplierPaymentId: true,
        supplierAdvanceId: true,
      },
    });
    if (
      !payment ||
      payment.restaurantId !== ctx.restaurantId ||
      payment.purchaseOrderId !== id
    ) {
      return { error: "not_found" as const };
    }
    // El cruce con una nota crédito no es un pago: se deshace anulando la nota.
    if (payment.supplierCreditNoteId) return { error: "credit_note_payment" as const };
    // Parte de un comprobante de egreso: se reversa anulando el comprobante
    // (abajo, si es sólo este abono; si no, desde «Pagos»).
    if (payment.supplierPaymentId || payment.supplierAdvanceId) return { voucherId: payment.supplierPaymentId, advance: !!payment.supplierAdvanceId };
    await tx.purchasePayment.delete({ where: { id: paymentId } });

    const po = await tx.purchaseOrder.findUniqueOrThrow({
      where: { id },
      select: {
        paidCents: true,
        ...PURCHASE_ORDER_TAX_SELECT,
        items: { select: PURCHASE_LINE_AMOUNTS_SELECT },
      },
    });
    const grossTotal = purchaseOrderTotals(po, "received").totalCents;
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
    return NextResponse.json({ error: result.error }, { status: result.error === "credit_note_payment" ? 409 : 404 });
  }
  if ("voucherId" in result) {
    // Un comprobante de un solo abono (el «Registrar pago» de la compra) se
    // anula entero; uno con varias facturas o cruces, desde «Pagos».
    const rows = result.voucherId
      ? (await db.purchasePayment.count({ where: { supplierPaymentId: result.voucherId } })) +
        (await db.expensePayment.count({ where: { supplierPaymentId: result.voucherId } }))
      : 0;
    if (result.advance || !result.voucherId || rows !== 1) {
      return NextResponse.json({ error: "part_of_voucher" }, { status: 409 });
    }
    try {
      await voidSupplierPayment(ctx.restaurantId, result.voucherId, null, null);
    } catch (err) {
      if (err instanceof SupplierCreditError) return NextResponse.json({ error: err.code }, { status: err.status });
      throw err;
    }
    const po = await db.purchaseOrder.findUniqueOrThrow({
      where: { id },
      select: { paidCents: true, ...PURCHASE_ORDER_TAX_SELECT, items: { select: PURCHASE_LINE_AMOUNTS_SELECT } },
    });
    const total = purchaseOrderTotals(po, "received").totalCents;
    return NextResponse.json({ ok: true, totalCents: total, paidCents: po.paidCents, outstandingCents: total - po.paidCents });
  }
  return NextResponse.json({ ok: true, ...result });
}

export const DELETE = secureApi(DELETEHandler);
