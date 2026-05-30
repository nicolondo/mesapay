import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { publishOrderEvent } from "@/lib/events";
import {
  getPaymentProvider,
  getRestaurantPrivateKey,
} from "@/lib/payments";
import { resolveReservationConfig } from "@/lib/reservations";
import { sendReservationConfirmation } from "@/lib/reservationEmail";

/**
 * Cobra el DEPÓSITO de una reserva con un token de tarjeta (Kushki).
 * Público — lo llama /r/[slug] después de crear la reserva en estado
 * `pending` con un hold. Mismo patrón que pay/kushki-charge pero
 * centrado en la Reserva (todavía no hay Order).
 *
 * Flujo:
 *   1. La reserva ya existe (pending, depositStatus=pending, hold vivo).
 *   2. El browser tokenizó la tarjeta directo contra Kushki.
 *   3. Acá cobramos con la private key del sub-merchant.
 *   4. Aprobado → reserva confirmada, depositStatus=paid, email. El
 *      abono se acreditará a la cuenta cuando lleguen (Fase C).
 *   5. Rechazado → la reserva sigue pending; pueden reintentar hasta
 *      que venza el hold.
 *
 * POST { token }
 */
const schema = z.object({ token: z.string().min(1).max(2000) });

function mapKushkiError(detail: string): string {
  if (detail.includes('"code":"022"') || detail.includes("(022)"))
    return "Tarjeta declinada — CVV inválido.";
  if (detail.includes('"code":"021"') || detail.includes("(021)"))
    return "Tarjeta declinada — fondos insuficientes.";
  if (detail.includes('"code":"017"') || detail.includes("(017)"))
    return "Tarjeta inválida.";
  if (detail.includes('"code":"023"') || detail.includes("(023)"))
    return "Tarjeta bloqueada.";
  if (detail.includes('"code":"577"'))
    return "El intento anterior expiró. Volvé a ingresar los datos.";
  if (detail.includes('"code":"K040"'))
    return "Credenciales del comercio mal configuradas. Avisá al restaurante.";
  return "El pago falló. Probá con otra tarjeta.";
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ slug: string; code: string }> },
) {
  const { slug, code } = await params;
  const tenant = await db.restaurant.findUnique({
    where: { slug },
    select: {
      id: true,
      name: true,
      kushkiMerchantId: true,
      legalCity: true,
      reservationConfig: true,
    },
  });
  if (!tenant) {
    return NextResponse.json({ error: "unknown_tenant" }, { status: 404 });
  }
  if (!tenant.kushkiMerchantId) {
    return NextResponse.json(
      { error: "tenant_not_onboarded" },
      { status: 409 },
    );
  }

  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid" }, { status: 400 });
  }

  const reservation = await db.reservation.findUnique({
    where: { confirmationCode: code },
    include: { table: { select: { number: true, label: true } } },
  });
  if (!reservation || reservation.restaurantId !== tenant.id) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  if (
    reservation.depositStatus !== "pending" ||
    !reservation.depositCents ||
    reservation.depositCents <= 0
  ) {
    return NextResponse.json(
      { error: "no_deposit_pending", message: "Esta reserva no tiene un depósito pendiente." },
      { status: 409 },
    );
  }
  if (reservation.status !== "pending") {
    return NextResponse.json({ error: "bad_state" }, { status: 409 });
  }
  if (
    reservation.holdExpiresAt &&
    reservation.holdExpiresAt.getTime() < Date.now()
  ) {
    return NextResponse.json(
      {
        error: "hold_expired",
        message:
          "El tiempo para pagar el depósito venció. Volvé a hacer la reserva.",
      },
      { status: 409 },
    );
  }

  const provider = await getPaymentProvider();
  const privateKey = await getRestaurantPrivateKey(tenant.id);
  if (!privateKey) {
    return NextResponse.json({ error: "credentials_missing" }, { status: 500 });
  }

  const depositCents = reservation.depositCents;
  let charge;
  try {
    charge = await provider.chargeWithToken({
      merchantId: privateKey,
      amount: { amountCents: depositCents, currency: "COP" },
      token: parsed.data.token,
      metadata: {
        reservationId: reservation.id,
        kind: "reservation_deposit",
        tableId: reservation.tableId,
      },
    });
  } catch (err) {
    const detail =
      err instanceof Error ? err.message.slice(0, 300) : "provider_error";
    console.error("[reservation-deposit] charge FAILED", { detail });
    return NextResponse.json(
      { error: "charge_failed", message: mapKushkiError(detail), detail },
      { status: 502 },
    );
  }

  // Espejo KushkiTransaction (sin paymentId — todavía no hay Order).
  // best-effort: un fallo del mirror no debe tumbar el cobro real.
  try {
    await db.kushkiTransaction.create({
      data: {
        restaurantId: tenant.id,
        kushkiTxId: charge.providerRef,
        kind: "charge",
        status: charge.status === "approved" ? "approved" : "declined",
        amountCents: depositCents,
        raw: charge.raw as object,
        message: charge.message,
      },
    });
  } catch (err) {
    console.error("[reservation-deposit] mirror failed", err);
  }

  if (charge.status !== "approved") {
    return NextResponse.json({
      approved: false,
      message: charge.message ?? "Pago rechazado",
    });
  }

  // Aprobado: el depósito quedó pago → confirmamos la reserva y soltamos
  // el hold. El abono se acreditará a la cuenta al sentarse (Fase C).
  await db.reservation.update({
    where: { id: reservation.id },
    data: {
      depositStatus: "paid",
      depositMethod: "kushki_card",
      depositTxId: charge.providerRef,
      status: "confirmed",
      holdExpiresAt: null,
    },
  });

  publishOrderEvent(tenant.id, {
    type: "order.updated",
    orderId: `reservation:${reservation.id}`,
  });

  const config = resolveReservationConfig(tenant.reservationConfig);
  void config; // (slotMinutes ya está fijo en la reserva)
  sendReservationConfirmation({
    to: reservation.customerEmail,
    customerName: reservation.customerName,
    restaurantName: tenant.name,
    restaurantCity: tenant.legalCity,
    tableLabel: reservation.table.label ?? `Mesa ${reservation.table.number}`,
    partySize: reservation.partySize,
    startsAt: reservation.startsAt,
    confirmationCode: reservation.confirmationCode,
    autoConfirmed: true,
    manageUrl: `${new URL(req.url).origin}/r/${slug}/reserva/${reservation.confirmationCode}`,
    depositPaidCents: depositCents,
  }).catch((err) =>
    console.error("[reservation-deposit] email failed", err),
  );

  return NextResponse.json({
    approved: true,
    confirmationCode: reservation.confirmationCode,
  });
}
