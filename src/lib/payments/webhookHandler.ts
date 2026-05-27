import { db } from "@/lib/db";
import { publishOrderEvent } from "@/lib/events";
import { recomputeOrderTotalsInTx } from "@/lib/orderTotals";
import { activateOpenRounds } from "@/lib/prepaidRounds";

/**
 * Shared business logic for processing Kushki webhook events. Used by both
 * the real HTTP webhook route and the in-process mock bus so terminal flows
 * close end-to-end in dev without a real Kushki callback.
 *
 * Idempotency: each event has a unique eventId. We upsert a
 * KushkiWebhookEvent row and bail if processedAt is already set.
 */

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

export async function processKushkiWebhook(
  payload: KushkiWebhookPayload,
): Promise<WebhookProcessResult> {
  // Idempotency gate. Even if we error processing, the row's `error` column
  // captures it so we can retry by clearing processedAt manually.
  const existing = await db.kushkiWebhookEvent.findUnique({
    where: { eventId: payload.eventId },
  });
  if (existing?.processedAt) {
    return { status: "duplicate" };
  }
  const eventRow =
    existing ??
    (await db.kushkiWebhookEvent.create({
      data: {
        eventId: payload.eventId,
        type: payload.type,
        restaurantId: payload.restaurantId ?? null,
        payload: payload as object,
      },
    }));

  try {
    await dispatch(payload);
    await db.kushkiWebhookEvent.update({
      where: { id: eventRow.id },
      data: { processedAt: new Date(), error: null },
    });
    return { status: "ok" };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown";
    await db.kushkiWebhookEvent.update({
      where: { id: eventRow.id },
      data: { error: msg.slice(0, 500) },
    });
    return { status: "error", message: msg };
  }
}

async function dispatch(payload: KushkiWebhookPayload): Promise<void> {
  switch (payload.type) {
    case "charge.approved":
    case "terminal.approved":
    case "pse.approved":
      await handleApproved(payload);
      return;
    case "charge.declined":
    case "terminal.declined":
    case "pse.declined":
      await handleDeclined(payload);
      return;
    case "dispersion.completed":
    case "dispersion.failed":
      // Wallet sync handles these via the wallet movement log. We log the
      // event but don't mutate payments — see Phase 6 wallet route.
      return;
    case "merchant.activated":
    case "merchant.rejected":
      await handleMerchantStatus(payload);
      return;
  }
}

async function handleApproved(payload: KushkiWebhookPayload): Promise<void> {
  if (!payload.paymentId) {
    throw new Error("approved webhook missing paymentId");
  }
  const payment = await db.payment.findUnique({
    where: { id: payload.paymentId },
    include: { order: true },
  });
  if (!payment) {
    throw new Error(`payment ${payload.paymentId} not found`);
  }
  if (payment.status === "approved") {
    // Already settled by another path. Idempotency catches duplicates but
    // a manual re-emit could land here.
    return;
  }

  const result = await db.$transaction(async (tx) => {
    await tx.payment.update({
      where: { id: payment.id },
      data: {
        status: "approved",
        providerRef: payload.providerRef ?? payment.providerRef,
        settledAt: new Date(),
      },
    });
    const totals = await recomputeOrderTotalsInTx(tx, payment.orderId);
    if (totals.fullyPaid) {
      await activateOpenRounds(tx, payment.orderId);
    }
    if (payload.providerRef) {
      // Upsert KushkiTransaction so we have a mirror even if the charge
      // route didn't pre-record one (e.g., terminal flow).
      await tx.kushkiTransaction.upsert({
        where: { kushkiTxId: payload.providerRef },
        create: {
          restaurantId: payment.order.restaurantId,
          paymentId: payment.id,
          kushkiTxId: payload.providerRef,
          kind: "charge",
          status: "approved",
          amountCents: payment.amountCents,
          raw: (payload.raw ?? {}) as object,
        },
        update: {
          status: "approved",
          message: payload.message,
        },
      });
    }
    return { fullyPaid: totals.fullyPaid };
  });

  publishOrderEvent(payment.order.restaurantId, {
    type: "payment.approved",
    orderId: payment.orderId,
    paymentId: payment.id,
  });
  publishOrderEvent(payment.order.restaurantId, {
    type: result.fullyPaid ? "order.paid" : "order.updated",
    orderId: payment.orderId,
  });
}

async function handleDeclined(payload: KushkiWebhookPayload): Promise<void> {
  if (!payload.paymentId) return;
  const payment = await db.payment.findUnique({
    where: { id: payload.paymentId },
    include: { order: true },
  });
  if (!payment) return;
  if (payment.status !== "pending") return;

  await db.payment.update({
    where: { id: payment.id },
    data: {
      status: "declined",
      providerRef: payload.providerRef ?? payment.providerRef,
    },
  });
  if (payload.providerRef) {
    await db.kushkiTransaction.upsert({
      where: { kushkiTxId: payload.providerRef },
      create: {
        restaurantId: payment.order.restaurantId,
        paymentId: payment.id,
        kushkiTxId: payload.providerRef,
        kind: "charge",
        status: "declined",
        amountCents: payment.amountCents,
        raw: (payload.raw ?? {}) as object,
        message: payload.message,
      },
      update: { status: "declined", message: payload.message },
    });
  }
  publishOrderEvent(payment.order.restaurantId, {
    type: "payment.declined",
    orderId: payment.orderId,
    paymentId: payment.id,
    reason: payload.message,
  });
}

async function handleMerchantStatus(
  payload: KushkiWebhookPayload,
): Promise<void> {
  if (!payload.restaurantId) return;
  const isActivated = payload.type === "merchant.activated";
  await db.restaurant.update({
    where: { id: payload.restaurantId },
    data: {
      kushkiOnboardingStatus: isActivated ? "active" : "rejected",
      kushkiActivatedAt: isActivated ? new Date() : null,
      kushkiOnboardingNotes: payload.message ?? null,
    },
  });
}
