import { db } from "@/lib/db";
import { lockOrder } from "@/lib/orderLock";
import { settleKushkiEventInTx } from "./webhookHandler";
import { publishOrderEvent } from "@/lib/events";
import { issueRequestedInvoiceOnPaid } from "@/lib/invoiceOnPaid";

export type ReconciliationOutcome = "approved" | "declined" | "refunded" | "not_refunded" | "reviewed";
/** Record an operator's verified provider result; never sends a charge or refund. */
export async function reconcilePayment(args: {
  paymentId: string; restaurantId: string; outcome: ReconciliationOutcome;
  evidence: string; providerRef: string;
  actor: { id: string; email: string; role: string };
}) {
  const result = await db.$transaction(async tx => {
    const hint = await tx.payment.findUnique({ where: { id: args.paymentId }, select: { orderId: true } });
    if (!hint) throw new Error("operation_conflict");
    await lockOrder(tx, hint.orderId);
    const payment = await tx.payment.findUniqueOrThrow({ where: { id: args.paymentId }, include: { order: true } });
    if (payment.order.restaurantId !== args.restaurantId) throw new Error("operation_conflict");
    if (!payment.reconciliationRequired) return { orderId: payment.orderId, alreadyResolved: true };
    const refund = await tx.financialOperation.findFirst({ where: { paymentId: payment.id, kind: "refund", status: "uncertain" } });
    if (refund) {
      if (!["refunded", "not_refunded"].includes(args.outcome) || refund.amountCents !== payment.refundReservedCents) throw new Error("operation_conflict");
      const completed = args.outcome === "refunded";
      const refundedCents = payment.refundedCents + (completed ? refund.amountCents : 0);
      await tx.financialOperation.update({ where: { key: refund.key }, data: { status: completed ? "completed" : "failed", providerRef: args.providerRef } });
      await tx.payment.update({ where: { id: payment.id }, data: {
        refundReservedCents: 0, refundedCents, reconciliationRequired: false,
        ...(completed ? { refundedAt: new Date(), status: refundedCents === payment.amountCents ? "refunded" : "approved" } : {}),
      } });
      if (completed) await tx.kushkiTransaction.create({ data: {
        restaurantId: args.restaurantId, paymentId: payment.id, kushkiTxId: refund.key,
        kind: "refund", status: "approved", amountCents: refund.amountCents,
        raw: { providerRef: args.providerRef, reconciliation: true },
      } });
    } else {
      if (payment.refundReservedCents) throw new Error("operation_conflict");
      if (payment.status === "pending") {
        if (args.outcome !== "approved" && args.outcome !== "declined") throw new Error("operation_conflict");
        await settleKushkiEventInTx(tx, { eventId: `reconcile:${payment.id}`, type: args.outcome === "approved" ? "charge.approved" : "charge.declined", paymentId: payment.id, restaurantId: args.restaurantId, providerRef: args.providerRef, amountCents: payment.amountCents });
      } else if (args.outcome !== "reviewed") throw new Error("operation_conflict");
      await tx.payment.update({ where: { id: payment.id }, data: { reconciliationRequired: false } });
    }
    await tx.auditEvent.create({ data: {
      restaurantId: args.restaurantId, actorUserId: args.actor.id, actorEmail: args.actor.email, actorRole: args.actor.role,
      kind: "payment.reconciled", targetType: "payment", targetId: payment.id,
      summary: args.evidence,
      diff: { before: { status: payment.status, refundedCents: payment.refundedCents }, outcome: args.outcome, providerRef: args.providerRef },
    } });
    return { orderId: payment.orderId, alreadyResolved: false };
  });
  publishOrderEvent(args.restaurantId, { type: "order.updated", orderId: result.orderId });
  await issueRequestedInvoiceOnPaid({ tenantId: args.restaurantId, orderId: result.orderId });
  return result;
}
