import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { publishOrderEvent } from "@/lib/events";
import { lockOrder } from "@/lib/orderLock";
import { recomputeOrderTotalsInTx } from "@/lib/orderTotals";
import { activateOpenRounds } from "@/lib/prepaidRounds";

export type KushkiWebhookKind =
  | "charge.approved"
  | "charge.declined"
  | "terminal.approved"
  | "terminal.declined"
  | "pse.approved"
  | "pse.declined"
  | "dispersion.completed"
  | "dispersion.failed"
  | "merchant.activated"
  | "merchant.rejected";

export type KushkiWebhookPayload = {
  eventId: string;
  type: KushkiWebhookKind;
  restaurantId?: string;
  paymentId?: string;
  orderId?: string;
  providerRef?: string;
  amountCents?: number;
  message?: string;
  raw?: unknown;
};

export type WebhookProcessResult = {
  status: "ok" | "duplicate" | "error";
  message?: string;
};

/** The event claim and every ledger change commit together. */
export async function processKushkiWebhook(payload: KushkiWebhookPayload): Promise<WebhookProcessResult> {
  try {
    const result = await db.$transaction(async tx => {
      await tx.kushkiWebhookEvent.createMany({ data: [{ eventId: payload.eventId, type: payload.type, restaurantId: payload.restaurantId, payload: payload as object }], skipDuplicates: true });
      await tx.$queryRaw`SELECT id FROM "KushkiWebhookEvent" WHERE "eventId" = ${payload.eventId} FOR UPDATE`;
      const event = await tx.kushkiWebhookEvent.findUniqueOrThrow({ where: { eventId: payload.eventId } });
      if (event.processedAt) return { duplicate: true, order: null };
      const order = await dispatch(tx, payload);
      await tx.kushkiWebhookEvent.update({ where: { id: event.id }, data: { processedAt: new Date(), error: null } });
      return { duplicate: false, order };
    });
    if (result.order) publishOrderEvent(result.order.restaurantId, { type: result.order.paid ? "order.paid" : "order.updated", orderId: result.order.id });
    return { status: result.duplicate ? "duplicate" : "ok" };
  } catch {
    // A failed transaction leaves no processed claim; provider retries remain safe.
    console.error("webhook_processing_failed", { eventId: payload.eventId, paymentId: payload.paymentId });
    return { status: "error", message: "webhook_processing_failed" };
  }
}

async function dispatch(tx: Prisma.TransactionClient, payload: KushkiWebhookPayload) {
  if (payload.type.startsWith("merchant.")) {
    if (!payload.restaurantId) throw new Error("missing_restaurant");
    const active = payload.type === "merchant.activated";
    await tx.restaurant.update({ where: { id: payload.restaurantId }, data: { kushkiOnboardingStatus: active ? "active" : "rejected", kushkiActivatedAt: active ? new Date() : null, kushkiOnboardingNotes: payload.message ?? null } });
    return null;
  }
  if (payload.type.startsWith("dispersion.")) return null;
  if (!payload.paymentId) throw new Error("missing_payment");
  const hint = await tx.payment.findUniqueOrThrow({ where: { id: payload.paymentId }, select: { orderId: true } });
  await lockOrder(tx, hint.orderId);
  const payment = await tx.payment.findUniqueOrThrow({ where: { id: payload.paymentId }, include: { order: true } });
  if (payload.restaurantId && payload.restaurantId !== payment.order.restaurantId) throw new Error("wrong_restaurant");
  if (payload.orderId && payload.orderId !== payment.orderId) throw new Error("wrong_order");
  if (payload.amountCents !== undefined && payload.amountCents !== payment.amountCents) throw new Error("wrong_amount");
  if (payload.providerRef && payment.providerRef && payload.providerRef !== payment.providerRef) throw new Error("wrong_reference");
  // A delayed delivery must never resurrect a refunded charge or undo approval.
  if (payment.status === "refunded" || payment.status === "approved") return null;
  const approved = payload.type.endsWith(".approved");
  const status = approved ? "approved" : "declined";
  const lateApproval = approved && (payment.status === "declined" || payment.order.status === "cancelled");
  if (!approved && payment.status !== "pending") return null;
  if (payload.providerRef) {
    const ledger = await tx.kushkiTransaction.findUnique({ where: { kushkiTxId: payload.providerRef } });
    if (ledger?.paymentId && ledger.paymentId !== payment.id) throw new Error("reference_in_use");
    await tx.kushkiTransaction.upsert({ where: { kushkiTxId: payload.providerRef }, create: {
      restaurantId: payment.order.restaurantId, paymentId: payment.id, kushkiTxId: payload.providerRef,
      kind: "charge", status, amountCents: payment.amountCents, raw: (payload.raw ?? {}) as object,
    }, update: { status, message: payload.message } });
  }
  await tx.payment.update({ where: { id: payment.id }, data: {
    status, providerRef: payload.providerRef ?? payment.providerRef, reconciliationRequired: lateApproval,
    ...(approved ? { settledAt: new Date() } : {}),
  } });
  let paid = false;
  if (approved && payment.order.status !== "cancelled") {
    const totals = await recomputeOrderTotalsInTx(tx, payment.orderId);
    paid = totals.fullyPaid;
    if (paid) await activateOpenRounds(tx, payment.orderId);
  }
  return { id: payment.orderId, restaurantId: payment.order.restaurantId, paid };
}
