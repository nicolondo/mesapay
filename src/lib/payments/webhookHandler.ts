import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { publishOrderEvent } from "@/lib/events";
import { lockOrder } from "@/lib/orderLock";
import { recomputeOrderTotalsInTx } from "@/lib/orderTotals";
import { activateOpenRounds } from "@/lib/prepaidRounds";
import { issueInvoiceOnPaid } from "@/lib/invoiceOnPaid";
import type { AutoFiredRound } from "@/lib/kds/autoFire";
import { notifyAutoFiredTickets } from "@/lib/kds/autoFireTickets";
import { settlePaymentLinkInTx } from "@/lib/paymentLinks";
import { releaseOrderFromPaying } from "./orderStatusAfterDecline";
import { canResolveTerminalCharge } from "./terminalResolve";
import { adjustedTerminalPayment } from "./terminalAmount";

export type KushkiWebhookKind =
  | "charge.approved"
  | "charge.declined"
  | "terminal.approved"
  | "terminal.declined"
  | "pse.approved"
  | "pse.declined"
  // Bre-B (QR de pago inmediato). Sólo los emite `breB/service.ts`, que ya
  // verificó referencia, monto y moneda contra el `BreBCharge`.
  | "bre_b.approved"
  | "bre_b.declined"
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
  /**
   * Sólo `terminal.approved` del datáfono Kushki: Kushki autorizó OTRO monto
   * (centavos) y ya se decidió que se liquida solo (propina de más o parcial
   * de menos, ver terminalAmount.ts / terminalApproval.ts). El pago se aprueba
   * por ESTE monto y queda marcado para revisión, sin bloquear la cuenta.
   */
  authorizedCents?: number;
  /** Lo que se mandó al datáfono: si el pago ya no lo tiene, no se ajusta. */
  expectedCents?: number;
  /** Código de autorización del datáfono, para la auditoría del ajuste. */
  approvalCode?: string | null;
  /** De dónde salió el monto autorizado (cobro síncrono, búsqueda, mock). */
  amountSource?: string;
};

export type WebhookProcessResult = {
  status: "ok" | "duplicate" | "error";
  message?: string;
  /** A contradictory provider result was recorded, but did not replace manual approval. */
  requiresReview?: true;
};

const MANUAL_OUTCOME_CONFLICT = "manual_terminal_outcome_conflict";

/** Only the exact administrator decision for this sent terminal charge is authoritative. */
async function isAuditedManualTerminalResolution(
  tx: Prisma.TransactionClient,
  payment: Prisma.PaymentGetPayload<{ include: { order: true } }>,
) {
  if (payment.method !== "kushki_card_terminal" || !payment.providerRef) return false;
  let actorUserId: string | undefined;
  if (payment.providerRef.startsWith("manual:")) {
    const [, actor, paymentId, extra] = payment.providerRef.split(":");
    if (!actor || paymentId !== payment.id || extra !== undefined) return false;
    actorUserId = actor;
  }
  if (payment.status !== "approved" && payment.status !== "declined") return false;
  const claim = await tx.financialOperation.findUnique({ where: { key: `terminal:${payment.id}` } });
  // Older sent payments may have a real provider reference without a claim; synthetic ones may not.
  if (!claim && actorUserId) return false;
  if (claim && (claim.kind !== "terminal" || claim.paymentId !== payment.id || claim.amountCents !== payment.amountCents)) return false;
  const audit = await tx.auditEvent.findFirst({
    where: {
      restaurantId: payment.order.restaurantId, ...(actorUserId ? { actorUserId } : {}), kind: "payment.reconciled",
      targetType: "payment", targetId: payment.id,
      diff: { path: ["manualTerminalResolution"], equals: true },
    },
    orderBy: { occurredAt: "desc" },
    select: { diff: true, actorUserId: true, actorRole: true },
  });
  const diff = audit?.diff;
  return !!audit?.actorUserId && canResolveTerminalCharge(audit.actorRole)
    && !!diff && typeof diff === "object" && !Array.isArray(diff)
    && diff.providerRef === payment.providerRef && diff.outcome === payment.status;
}

/** The event claim and every ledger change commit together. */
export async function processKushkiWebhook(payload: KushkiWebhookPayload): Promise<WebhookProcessResult> {
  try {
    const result = await db.$transaction(async tx => {
      await tx.kushkiWebhookEvent.createMany({ data: [{ eventId: payload.eventId, type: payload.type, restaurantId: payload.restaurantId, payload: payload as object }], skipDuplicates: true });
      await tx.$queryRaw`SELECT id FROM "KushkiWebhookEvent" WHERE "eventId" = ${payload.eventId} FOR UPDATE`;
      const event = await tx.kushkiWebhookEvent.findUniqueOrThrow({ where: { eventId: payload.eventId } });
      if (event.processedAt) return { duplicate: true, order: null, requiresReview: event.error === MANUAL_OUTCOME_CONFLICT };
      const order = await settleKushkiEventInTx(tx, payload);
      const requiresReview = !!order && "reviewOnly" in order && order.reviewOnly === true;
      await tx.kushkiWebhookEvent.update({ where: { id: event.id }, data: { processedAt: new Date(), error: requiresReview ? MANUAL_OUTCOME_CONFLICT : null } });
      return { duplicate: false, order, requiresReview };
    });
    if (result.order) {
      publishOrderEvent(result.order.restaurantId, { type: result.order.paid ? "order.paid" : "order.updated", orderId: result.order.id });
      if (!result.requiresReview) {
        publishOrderEvent(result.order.restaurantId, { type: result.order.approved ? "payment.approved" : "payment.declined", orderId: result.order.id, paymentId: result.order.paymentId });
        if (result.order.paid) await issueInvoiceOnPaid({ tenantId: result.order.restaurantId, orderId: result.order.id });
        // Rondas prepagas activadas por este cobro y marchadas solas: la comanda sale ahora, fuera de la tx.
        await notifyAutoFiredTickets({ restaurantId: result.order.restaurantId, orderId: result.order.id, rounds: result.order.fired });
      }
    }
    return { status: result.duplicate ? "duplicate" : "ok", ...(result.requiresReview ? { requiresReview: true as const } : {}) };
  } catch {
    // A failed transaction leaves no processed claim; provider retries remain safe.
    console.error("webhook_processing_failed", { eventId: payload.eventId, paymentId: payload.paymentId });
    return { status: "error", message: "webhook_processing_failed" };
  }
}

export async function settleKushkiEventInTx(tx: Prisma.TransactionClient, payload: KushkiWebhookPayload) {
  if (payload.type.startsWith("merchant.")) {
    if (!payload.restaurantId) throw new Error("missing_restaurant");
    const active = payload.type === "merchant.activated";
    await tx.restaurant.update({ where: { id: payload.restaurantId }, data: { kushkiOnboardingStatus: active ? "active" : "rejected", kushkiActivatedAt: active ? new Date() : null, kushkiOnboardingNotes: payload.message ?? null } });
    return null;
  }
  if (payload.type.startsWith("dispersion.")) return null;
  if (!payload.paymentId) {
    // Sin Payment de orden: puede ser un LINK DE PAGO (bonos) cuyo aviso
    // llega por la misma URL. Se casa por la referencia del proveedor;
    // si no hay link, es el mismo error de siempre.
    if (!payload.providerRef) throw new Error("missing_payment");
    const link = await tx.paymentLink.findFirst({
      where: { providerRef: payload.providerRef },
      orderBy: { createdAt: "desc" },
      select: { id: true, restaurantId: true },
    });
    if (!link) throw new Error("missing_payment");
    if (payload.restaurantId && payload.restaurantId !== link.restaurantId) throw new Error("wrong_restaurant");
    await settlePaymentLinkInTx(tx, { id: link.id }, { approved: payload.type.endsWith(".approved"), providerRef: payload.providerRef });
    return null;
  }
  const hint = await tx.payment.findUniqueOrThrow({ where: { id: payload.paymentId }, select: { orderId: true } });
  await lockOrder(tx, hint.orderId);
  const payment = await tx.payment.findUniqueOrThrow({ where: { id: payload.paymentId }, include: { order: true } });
  if (payload.restaurantId && payload.restaurantId !== payment.order.restaurantId) throw new Error("wrong_restaurant");
  if (payload.orderId && payload.orderId !== payment.orderId) throw new Error("wrong_order");
  if (payload.amountCents !== undefined && payload.amountCents !== payment.amountCents) throw new Error("wrong_amount");
  const approved = payload.type.endsWith(".approved");
  const status = approved ? "approved" : "declined";
  const referenceMismatch = !!payload.providerRef && !!payment.providerRef && payload.providerRef !== payment.providerRef;
  const auditedManualDecision = ((referenceMismatch && payment.providerRef!.startsWith("manual:"))
    || (payment.status === "approved" && !approved)) && await isAuditedManualTerminalResolution(tx, payment);
  let manualReference = false;
  if (referenceMismatch) {
    manualReference = payment.providerRef!.startsWith("manual:") && !payload.providerRef!.startsWith("manual:") && auditedManualDecision;
    if (!manualReference) throw new Error("wrong_reference");
  }
  const conflict = payment.status === "approved" && !approved && auditedManualDecision;
  if (manualReference || conflict) {
    const manualProviderRef = payment.providerRef;
    if (!manualProviderRef) throw new Error("wrong_reference");
    const realLedger = payload.providerRef ? await tx.kushkiTransaction.findUnique({ where: { kushkiTxId: payload.providerRef } }) : null;
    if (realLedger && (realLedger.paymentId !== payment.id || realLedger.restaurantId !== payment.order.restaurantId
      || realLedger.kind !== "charge" || realLedger.amountCents !== payment.amountCents)) throw new Error("reference_in_use");
    if (!conflict || !payment.reconciliationRequired) {
      await tx.auditEvent.create({ data: {
        restaurantId: payment.order.restaurantId, actorEmail: "kushki", actorRole: "system",
        kind: conflict ? "payment.terminal_outcome_conflict" : "payment.terminal_reference_linked",
        targetType: "payment", targetId: payment.id,
        summary: conflict ? "El rechazo del datáfono contradice la aprobación manual; requiere revisión."
          : "Se recibió la referencia del datáfono después de la resolución manual.",
        diff: { manualProviderRef, providerRef: payload.providerRef ?? null, manualOutcome: payment.status, providerOutcome: status, eventId: payload.eventId },
      } });
    }
    if (conflict) {
      // Never release the balance or erase voucher evidence on a contradictory delivery.
      await tx.payment.update({ where: { id: payment.id }, data: { reconciliationRequired: true } });
      return { id: payment.orderId, restaurantId: payment.order.restaurantId, paid: false, approved: true,
        paymentId: payment.id, fired: [] as AutoFiredRound[], reviewOnly: true as const };
    }
    if (manualReference && payment.status === status) {
      // Replace the synthetic ledger key, not the charge: a second approved row would double reports.
      if (realLedger) throw new Error("reference_in_use");
      const linked = await tx.kushkiTransaction.updateMany({
        where: { kushkiTxId: manualProviderRef, paymentId: payment.id, restaurantId: payment.order.restaurantId,
          kind: "charge", status, amountCents: payment.amountCents },
        data: { kushkiTxId: payload.providerRef, raw: (payload.raw ?? {}) as object, message: payload.message },
      });
      if (linked.count !== 1) throw new Error("manual_ledger_missing");
      await tx.payment.update({ where: { id: payment.id }, data: { providerRef: payload.providerRef } });
      await tx.financialOperation.updateMany({ where: { key: `terminal:${payment.id}`, paymentId: payment.id }, data: { providerRef: payload.providerRef } });
      return null;
    }
  }
  // A delayed delivery must never resurrect a refunded charge or undo approval.
  if (payment.status === "refunded" || payment.status === "approved") return null;
  const lateApproval = approved && (payment.status === "declined" || payment.order.status === "cancelled");
  if (!approved && payment.status !== "pending") return null;
  // El datáfono aprobó otro monto (ya clasificado como propina o parcial): el
  // pago se aprueba por lo autorizado. Sólo si sigue siendo el cobro que se
  // mandó; si no, que lo resuelva una persona.
  const adjust = approved && payload.authorizedCents !== undefined && payload.authorizedCents !== payment.amountCents
    ? adjustedTerminalPayment(payment, payload.authorizedCents)
    : null;
  if (adjust && (payment.method !== "kushki_card_terminal"
    || (payload.expectedCents !== undefined && payload.expectedCents !== payment.amountCents))) throw new Error("wrong_amount");
  const chargedCents = adjust?.amountCents ?? payment.amountCents;
  if (payload.providerRef) {
    const ledger = await tx.kushkiTransaction.findUnique({ where: { kushkiTxId: payload.providerRef } });
    if (ledger?.paymentId && ledger.paymentId !== payment.id) throw new Error("reference_in_use");
    await tx.kushkiTransaction.upsert({ where: { kushkiTxId: payload.providerRef }, create: {
      restaurantId: payment.order.restaurantId, paymentId: payment.id, kushkiTxId: payload.providerRef,
      kind: "charge", status, amountCents: chargedCents, raw: (payload.raw ?? {}) as object,
    }, update: { status, message: payload.message, ...(adjust ? { amountCents: chargedCents } : {}) } });
  }
  await tx.payment.update({ where: { id: payment.id }, data: {
    status, providerRef: payload.providerRef ?? payment.providerRef,
    // Otro monto: se liquida, pero alguien lo revisa (Cobros → «Requiere revisión»).
    reconciliationRequired: lateApproval || !!adjust,
    ...(adjust ? { amountCents: adjust.amountCents, tipCents: adjust.tipCents } : {}),
    ...(approved ? { settledAt: new Date() } : {}),
  } });
  if (adjust) {
    const diffCents = adjust.amountCents - payment.amountCents;
    await tx.financialOperation.updateMany({
      where: { key: `terminal:${payment.id}`, paymentId: payment.id },
      data: { authorizedCents: adjust.amountCents, amountCheck: diffCents > 0 ? "tip" : "partial" },
    });
    // Sin datos de tarjeta: montos, código de autorización y referencia.
    await tx.auditEvent.create({ data: {
      restaurantId: payment.order.restaurantId, actorEmail: "kushki", actorRole: "system",
      kind: "payment.terminal_amount_adjusted", targetType: "payment", targetId: payment.id,
      summary: diffCents > 0
        ? `El datáfono cobró ${diffCents} centavos más que la cuenta: se registró como propina.`
        : `El datáfono aprobó ${-diffCents} centavos menos que la cuenta: el saldo queda pendiente.`,
      diff: {
        expectedCents: payment.amountCents, authorizedCents: adjust.amountCents, diffCents,
        tipBefore: payment.tipCents, tipAfter: adjust.tipCents, check: diffCents > 0 ? "tip" : "partial",
        approvalCode: payload.approvalCode ?? null, providerRef: payload.providerRef ?? null,
        source: payload.amountSource ?? null, eventId: payload.eventId,
      },
    } });
  }
  await tx.financialOperation.updateMany({ where: { paymentId: payment.id, kind: "terminal", ...(manualReference ? { key: `terminal:${payment.id}` } : { status: { in: ["pending", "uncertain"] } }) }, data: { status: approved ? "completed" : "failed", providerRef: payload.providerRef } });
  let paid = false;
  let fired: AutoFiredRound[] = [];
  if (approved && payment.order.status !== "cancelled") {
    const totals = await recomputeOrderTotalsInTx(tx, payment.orderId);
    paid = totals.fullyPaid;
    if (paid) fired = await activateOpenRounds(tx, payment.orderId);
  }
  if (!approved) await releaseOrderFromPaying(tx, payment.orderId, payment.order.status);
  return { id: payment.orderId, restaurantId: payment.order.restaurantId, paid, approved, paymentId: payment.id, fired };
}
