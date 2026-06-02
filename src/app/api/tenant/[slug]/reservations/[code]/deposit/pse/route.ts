import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import {
  getPaymentProvider,
  getRestaurantPrivateKey,
} from "@/lib/payments";
import { getKushkiModeSync } from "@/lib/platformConfig";
import { publishOrderEvent } from "@/lib/events";
import { resolveReservationConfig } from "@/lib/reservations";
import { sendReservationConfirmation } from "@/lib/reservationEmail";

/**
 * Inicia el cobro del DEPÓSITO de una reserva con PSE.
 *
 * PSE es asíncrono: el cliente sale al banco y vuelve. La confirmación
 * la resuelve la página de retorno consultando /transfer/v1/status del
 * token (polling) — no dependemos del webhook (que es order-céntrico).
 *
 * Sandbox/prod: el browser ya tokenizó con Kushki.js → manda { token,
 *   buyer }. Acá llamamos /transfer/v1/init con la private key para
 *   obtener la URL del banco y guardamos el token en la reserva.
 * Mock: no hay banco real → confirmamos el depósito al toque y
 *   devolvemos la URL de retorno (que muestra éxito).
 *
 * POST { token?, buyer: { email, docType, docNumber, personType }, bankCode? }
 */
const schema = z.object({
  token: z.string().trim().min(1).optional(),
  bankCode: z.string().trim().optional(),
  buyer: z.object({
    email: z.string().trim().email(),
    docType: z.enum(["CC", "CE", "NIT", "PA", "TI"]).default("CC"),
    docNumber: z.string().trim().min(4).max(20),
    personType: z.enum(["natural", "juridica"]).default("natural"),
  }),
});

function appOrigin(req: Request): string {
  if (env.APP_PUBLIC_BASE_URL) return env.APP_PUBLIC_BASE_URL.replace(/\/$/, "");
  const xfHost = req.headers.get("x-forwarded-host");
  const xfProto = req.headers.get("x-forwarded-proto") ?? "https";
  if (xfHost) return `${xfProto}://${xfHost}`;
  const host = req.headers.get("host");
  if (host) return `${host.includes("localhost") ? "http" : "https"}://${host}`;
  return new URL(req.url).origin;
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
      kushkiPublicKey: true,
      kushkiOnboardingStatus: true,
      legalCity: true,
      reservationConfig: true,
    },
  });
  if (!tenant) {
    return NextResponse.json({ error: "unknown_tenant" }, { status: 404 });
  }
  if (!tenant.kushkiMerchantId) {
    return NextResponse.json({ error: "tenant_not_onboarded" }, { status: 409 });
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
    reservation.depositCents <= 0 ||
    reservation.status !== "pending"
  ) {
    return NextResponse.json(
      { error: "no_deposit_pending", message: "Esta reserva no tiene un depósito pendiente." },
      { status: 409 },
    );
  }
  if (
    reservation.holdExpiresAt &&
    reservation.holdExpiresAt.getTime() < Date.now()
  ) {
    return NextResponse.json(
      { error: "hold_expired", message: "El tiempo para pagar venció. Reservá de nuevo." },
      { status: 409 },
    );
  }

  const depositCents = reservation.depositCents;
  const origin = appOrigin(req);
  const returnUrl = `${origin}/r/${slug}/reserva/${code}/deposit-return`;
  const mode = getKushkiModeSync();

  // ── Mock: confirmamos el depósito directo (no hay banco real) ──────
  if (mode === "mock" || !parsed.data.token) {
    if (mode === "mock") {
      await db.reservation.update({
        where: { id: reservation.id },
        data: {
          depositStatus: "paid",
          depositMethod: "kushki_pse",
          depositTxId: `mock_pse_${reservation.id.slice(0, 8)}`,
          status: "confirmed",
          holdExpiresAt: null,
        },
      });
      publishOrderEvent(tenant.id, {
        type: "order.updated",
        orderId: `reservation:${reservation.id}`,
      });
      sendDepositEmail(req, slug, tenant, reservation, depositCents);
      return NextResponse.json({ redirectUrl: returnUrl });
    }
    return NextResponse.json(
      { error: "missing_token", message: "Falta tokenizar PSE." },
      { status: 400 },
    );
  }

  // ── Live/sandbox: /transfer/v1/init con la private key ─────────────
  const privateKey = await getRestaurantPrivateKey(tenant.id);
  if (!privateKey) {
    return NextResponse.json({ error: "credentials_missing" }, { status: 500 });
  }

  const baseUrl =
    mode === "production"
      ? "https://api.kushkipagos.com"
      : "https://api-uat.kushkipagos.com";

  try {
    const res = await fetch(`${baseUrl}/transfer/v1/init`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Private-Merchant-Id": privateKey,
      },
      body: JSON.stringify({
        token: parsed.data.token,
        amount: { subtotalIva: 0, subtotalIva0: depositCents / 100, iva: 0 },
        contactDetails: {
          fullName: reservation.customerName || "Cliente",
          email: parsed.data.buyer.email,
          documentType: parsed.data.buyer.docType,
          documentNumber: parsed.data.buyer.docNumber,
        },
        metadata: {
          reservationId: reservation.id,
          kind: "reservation_deposit",
        },
      }),
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`kushki ${res.status} /transfer/v1/init: ${text.slice(0, 300)}`);
    }
    const initResp = (text ? JSON.parse(text) : {}) as {
      redirectUrl?: string;
      url?: string;
      security?: { acsURL?: string };
    };
    const redirectUrl =
      initResp.redirectUrl || initResp.url || initResp.security?.acsURL || "";
    if (!redirectUrl) {
      throw new Error("Kushki init sin redirectUrl");
    }
    // Guardamos el token para reconciliar en la página de retorno.
    await db.reservation.update({
      where: { id: reservation.id },
      data: { depositTxId: parsed.data.token, depositMethod: "kushki_pse" },
    });
    return NextResponse.json({ redirectUrl });
  } catch (err) {
    console.error("[reservation-deposit-pse] init FAILED", err);
    const detail =
      err instanceof Error ? err.message.slice(0, 300) : "provider_error";
    return NextResponse.json(
      {
        error: "init_failed",
        message: "No pudimos iniciar la transferencia PSE.",
        detail,
      },
      { status: 502 },
    );
  }
}

function sendDepositEmail(
  req: Request,
  slug: string,
  tenant: { name: string; legalCity: string | null },
  reservation: {
    customerEmail: string;
    customerName: string;
    partySize: number;
    startsAt: Date;
    confirmationCode: string;
    locale: string | null;
    table: { number: number; label: string | null };
  },
  depositCents: number,
) {
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
    locale: reservation.locale,
    manageUrl: `${appOrigin(req)}/r/${slug}/reserva/${reservation.confirmationCode}`,
    depositPaidCents: depositCents,
  }).catch((e) => console.error("[reservation-deposit-pse] email", e));
}

// (resolveReservationConfig importado por consistencia con el flujo de
// órdenes; el slot ya está fijo en la reserva, así que no se usa acá.)
void resolveReservationConfig;
