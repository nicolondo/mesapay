import { lockOrder } from "@/lib/orderLock";
import { secureApi } from "@/lib/secureApi";
import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { getActiveRestaurantId } from "@/lib/activeRestaurant";
import { getRestaurantPrivateKey } from "@/lib/payments";
import { getRestaurantKushkiMode } from "@/lib/platformConfig";
import { getCurrencyForCountry } from "@/lib/billing/countries";
import { refundKushkiCharge } from "@/lib/payments/kushki/refund";
import { publishOrderEvent } from "@/lib/events";

/**
 * Devolución de un pago con tarjeta de Kushki, disparada por el operador desde
 * el detalle de la orden. Solo dueño/operador (no meseros). Solo pagos Kushki
 * con tarjeta (card / apple pay / datáfono) aprobados. Soporta parcial.
 */

// Métodos que pasaron por un charge de Kushki con ticketNumber refundeable.
// PSE (transferencia) usa otro flujo de devolución → excluido por ahora.
const REFUNDABLE_METHODS = new Set([
  "kushki_card",
  "kushki_apple_pay",
  "kushki_card_terminal",
]);

const schema = z.object({
  // Monto a devolver en cents. Omitido = todo lo que resta del pago.
  amountCents: z.number().int().positive().optional(),
});

/** Lee el ticketNumber del cargo original guardado en KushkiTransaction.raw. */
function ticketNumberFrom(raw: unknown): string | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.ticketNumber === "string" && r.ticketNumber) return r.ticketNumber;
  const details =
    r.details && typeof r.details === "object"
      ? (r.details as Record<string, unknown>)
      : null;
  if (details && typeof details.ticketNumber === "string" && details.ticketNumber) {
    return details.ticketNumber;
  }
  return null;
}

async function POSTHandler(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (
    !session?.user ||
    (session.user.role !== "operator" && session.user.role !== "platform_admin" && session.user.role !== "group_admin")
  ) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { id: paymentId } = await params;
  const requestId = req.headers.get("idempotency-key");
  if (!requestId || !/^[a-zA-Z0-9-]{16,100}$/.test(requestId)) return NextResponse.json({ error: "idempotency_key_required" }, { status: 400 });
  const operationKey = `refund:${paymentId}:${requestId}`;
  const restaurantId = await getActiveRestaurantId();
  if (!restaurantId) {
    return NextResponse.json({ error: "no_restaurant" }, { status: 400 });
  }

  const payment = await db.payment.findUnique({
    where: { id: paymentId },
    include: {
      order: { select: { id: true, restaurantId: true } },
      kushkiTransactions: {
        where: { kind: "charge" },
        orderBy: { createdAt: "desc" },
        take: 1,
      },
    },
  });
  if (!payment || payment.order.restaurantId !== restaurantId) {
    return NextResponse.json({ error: "payment_not_found" }, { status: 404 });
  }
  const previous = await db.financialOperation.findUnique({ where: { key: operationKey } });
  if (previous) return NextResponse.json({ ok: previous.status === "completed", pending: previous.status !== "completed", operationId: previous.key }, { status: previous.status === "completed" ? 200 : 202 });
  if (!REFUNDABLE_METHODS.has(payment.method)) {
    return NextResponse.json({ error: "not_refundable_method" }, { status: 409 });
  }
  if (payment.status !== "approved") {
    return NextResponse.json({ error: "not_approved" }, { status: 409 });
  }
  const remaining = payment.amountCents - payment.refundedCents - payment.refundReservedCents;
  if (remaining <= 0) {
    return NextResponse.json({ error: "already_refunded" }, { status: 409 });
  }

  const body = await req.json().catch(() => ({}));
  const parsed = schema.safeParse(body ?? {});
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid" }, { status: 400 });
  }
  const amountCents = parsed.data.amountCents ?? remaining;
  if (amountCents > remaining) {
    return NextResponse.json(
      { error: "amount_exceeds_remaining", remaining },
      { status: 409 },
    );
  }

  const ticketNumber = ticketNumberFrom(payment.kushkiTransactions[0]?.raw);
  if (!ticketNumber) {
    return NextResponse.json({ error: "no_ticket_number" }, { status: 409 });
  }

  const tenant = await db.restaurant.findUnique({ where: { id: restaurantId } });
  if (!tenant) {
    return NextResponse.json({ error: "no_restaurant" }, { status: 400 });
  }
  const privateKey = await getRestaurantPrivateKey(restaurantId);
  if (!privateKey) {
    return NextResponse.json({ error: "credentials_missing" }, { status: 500 });
  }
  const mode = await getRestaurantKushkiMode(tenant);
  const currency = await getCurrencyForCountry(tenant.country);
  // Total sólo si es el primer reintegro por el monto completo del cargo.
  const full = payment.refundedCents === 0 && amountCents === payment.amountCents;

  const reserved = await db.$transaction(async tx => {
    await lockOrder(tx, payment.orderId);
    if (await tx.financialOperation.findUnique({ where: { key: operationKey } })) return false;
    const current = await tx.payment.findUniqueOrThrow({ where: { id: payment.id } });
    if (current.status !== "approved" || current.refundReservedCents > 0 || amountCents > current.amountCents - current.refundedCents) throw new Error("operation_conflict");
    await tx.financialOperation.create({ data: { key: operationKey, paymentId, kind: "refund", amountCents } });
    await tx.payment.update({ where: { id: payment.id }, data: { refundReservedCents: { increment: amountCents } } });
    return true;
  });
  if (!reserved) return NextResponse.json({ pending: true, operationId: operationKey }, { status: 202 });
  let outcome;
  try {
    outcome = await refundKushkiCharge({
      mode,
      privateKey,
      ticketNumber,
      currency,
      amountCents,
      full,
    });
    if (!outcome.ok) throw new Error("refund_unconfirmed");
  } catch {
    await db.financialOperation.update({ where: { key: operationKey }, data: { status: "uncertain" } });
    await db.payment.update({ where: { id: payment.id }, data: { reconciliationRequired: true } });
    return NextResponse.json({ error: "payment_pending", pending: true, operationId: operationKey }, { status: 202 });
  }

  const newRefunded = payment.refundedCents + amountCents;
  const fullyRefunded = newRefunded >= payment.amountCents;

  await db.$transaction(async (tx) => {
    await lockOrder(tx, payment.orderId);
    await tx.financialOperation.update({ where: { key: operationKey }, data: { status: "completed" } });
    await tx.payment.update({
      where: { id: payment.id },
      data: {
        refundedCents: { increment: amountCents },
        refundReservedCents: { decrement: amountCents },
        refundedAt: new Date(),
        ...(fullyRefunded ? { status: "refunded" as const } : {}),
      },
    });
    await tx.kushkiTransaction.create({
      data: {
        restaurantId,
        paymentId: payment.id,
        // kushkiTxId es @unique; sintetizamos uno propio (la respuesta de la
        // devolución no siempre trae una referencia estable).
        kushkiTxId: operationKey,
        kind: "refund",
        status: "approved",
        amountCents,
        currency,
        raw: (outcome.raw ?? {}) as object,
        message: outcome.message,
      },
    });
  });

  publishOrderEvent(restaurantId, {
    type: "order.updated",
    orderId: payment.order.id,
  });

  return NextResponse.json({
    ok: true,
    refundedCents: newRefunded,
    fullyRefunded,
    amountCents,
  });
}

export const POST = secureApi(POSTHandler);
