import { secureApi } from "@/lib/secureApi";
import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { getPaymentProvider, getRestaurantPrivateKey } from "@/lib/payments";
import { getRestaurantKushkiMode } from "@/lib/platformConfig";
import { paymentLinkIsOpen, settlePaymentLinkInTx } from "@/lib/paymentLinks";
import { chargeFailureLogFields, classifyKushkiChargeError } from "@/lib/payments/kushki/chargeError";
import { captureLinkTrackingFields } from "@/lib/walletTrackingCapture";

/**
 * Cobra un LINK DE PAGO con un token de tarjeta / Apple Pay (Kushki).
 * Público — lo llama /r/[slug]/pago/[token]. Mismo patrón que el
 * depósito de reserva (`reservations/[code]/deposit`): el browser
 * tokenizó contra Kushki, acá se cobra con la private key del
 * sub-merchant y, aprobado, se cierra el link (y su efecto: el lote de
 * bonos pasa a `paid`).
 *
 * Los mensajes al pagador salen como CÓDIGOS (`reason`) y los traduce la
 * página — nunca texto en un idioma fijo desde el server.
 *
 * POST { token, method }
 */
const schema = z.object({
  token: z.string().min(1).max(2000),
  method: z.enum(["kushki_card", "kushki_apple_pay"]).default("kushki_card"),
  email: z.string().trim().email().max(160).optional(),
});

async function POSTHandler(
  req: Request,
  { params }: { params: Promise<{ slug: string; token: string }> },
) {
  const { slug, token } = await params;
  const tenant = await db.restaurant.findUnique({
    where: { slug },
    select: { id: true, kushkiMerchantId: true, kushkiMode: true },
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

  // El link es de ESTE comercio o no existe: no se revela lo ajeno.
  const link = await db.paymentLink.findUnique({ where: { token } });
  if (!link || link.restaurantId !== tenant.id) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  if (!paymentLinkIsOpen(link)) {
    return NextResponse.json(
      { error: "link_closed", status: link.status },
      { status: 409 },
    );
  }

  const mode = await getRestaurantKushkiMode(tenant);
  const provider = await getPaymentProvider(mode);
  const privateKey = await getRestaurantPrivateKey(tenant.id);
  if (!privateKey) {
    return NextResponse.json({ error: "credentials_missing" }, { status: 500 });
  }
  const tracking = await captureLinkTrackingFields({ restaurantId: tenant.id, mode, currency: link.currency, privateKey });
  if (Object.keys(tracking).length) await db.paymentLink.updateMany({ where: { id: link.id, status: "pending" }, data: tracking });

  let charge;
  try {
    charge = await provider.chargeWithToken({
      merchantId: privateKey,
      amount: { amountCents: link.amountCents, currency: link.currency as "COP" | "MXN" },
      token: parsed.data.token,
      metadata: { kind: "payment_link", paymentLinkId: link.id },
    });
  } catch (err) {
    // El link no tiene estado «incierto»: sigue pendiente y el pagador puede
    // volver a intentar. Por eso importa NO decirle «falló, prueba de nuevo»
    // cuando no sabemos si Kushki cobró (red, timeout, 5xx, token ya usado):
    // ahí el motivo es `uncertain` y la página pide revisar antes de repetir.
    // Tabla de decisión: lib/payments/kushki/chargeError.ts.
    const failure = classifyKushkiChargeError(err);
    console.error("[pay-link] charge FAILED", { linkId: link.id, ...chargeFailureLogFields(failure) });
    if (failure.outcome === "uncertain") {
      return NextResponse.json({ error: "charge_uncertain", reason: "uncertain" }, { status: 502 });
    }
    return NextResponse.json({ error: "charge_failed", reason: failure.reason }, { status: 502 });
  }

  // Espejo KushkiTransaction (sin paymentId — no hay Order). best-effort.
  try {
    await db.kushkiTransaction.create({
      data: {
        restaurantId: tenant.id,
        kushkiTxId: charge.providerRef,
        kind: "charge",
        status: charge.status === "approved" ? "approved" : "declined",
        amountCents: link.amountCents,
        currency: link.currency,
        raw: charge.raw as object,
        message: charge.message,
      },
    });
  } catch (err) {
    console.error("[pay-link] mirror failed", err);
  }

  if (charge.status !== "approved") {
    return NextResponse.json({ approved: false, reason: "declined" });
  }

  const settled = await db.$transaction((tx) =>
    settlePaymentLinkInTx(
      tx,
      { id: link.id },
      {
        approved: true,
        providerRef: charge.providerRef,
        method: parsed.data.method,
        payerEmail: parsed.data.email ?? null,
      },
    ),
  );
  return NextResponse.json({ approved: true, settled: settled.status });
}

export const POST = secureApi(POSTHandler);
