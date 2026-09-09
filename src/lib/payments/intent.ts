import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { lockOrder } from "@/lib/orderLock";

export async function reservePayment(data: Prisma.PaymentUncheckedCreateInput, key?: string) {
  const requestKey = key ? createHash("sha256").update(`${data.orderId}:${data.method}:${key}`).digest("hex") : undefined;
  return db.$transaction(async tx => {
    await lockOrder(tx, data.orderId);
    if (requestKey) {
      const existing = await tx.payment.findUnique({ where: { requestKey } });
      if (existing) {
        if (existing.amountCents !== data.amountCents || existing.tipCents !== (data.tipCents ?? 0)) throw new Error("operation_conflict");
        return { payment: existing, created: false };
      }
    }
    const order = await tx.order.findUniqueOrThrow({ where: { id: data.orderId } });
    if (order.status === "paid" || order.status === "cancelled") throw new Error("order_closed");
    // SQL trigger reserves the balance here for every insertion path.
    const payment = await tx.payment.create({ data: { ...data, requestKey } });
    return { payment, created: true };
  });
}

/** Never release a balance on transport failure: the provider may have charged. */
export async function markPaymentUncertain(paymentId: string) {
  await db.payment.updateMany({ where: { id: paymentId, status: "pending" }, data: { reconciliationRequired: true } });
}
