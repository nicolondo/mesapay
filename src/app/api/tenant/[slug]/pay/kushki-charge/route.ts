import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { getCurrencyForCountry } from "@/lib/billing/countries";
import { publishOrderEvent } from "@/lib/events";
import { welcomeIfFirstTime } from "@/lib/mailer";
import { activateOpenRounds } from "@/lib/prepaidRounds";
import {
  recomputeOrderTotalsInTx,
  validateNewPaymentAmount,
} from "@/lib/orderTotals";
import {
  getPaymentProvider,
  getRestaurantPrivateKey,
} from "@/lib/payments";
import { getRestaurantKushkiMode } from "@/lib/platformConfig";

/**
 * Token-based charge through Kushki. Maneja DOS variantes:
 *
 *   - kushki_apple_pay: token viene del Apple Pay sheet (wallet).
 *   - kushki_card: token viene de Kushki.js tokenizando datos de
 *     tarjeta que el diner ingresó en el form de MESAPAY. Los datos
 *     de la tarjeta NUNCA tocan nuestro server — el browser los manda
 *     directo a Kushki que devuelve un token opaco.
 *
 * Frontend flow (ambas variantes):
 *   1. Get tenant.kushkiPublicKey from page props.
 *   2. Browser obtiene token (Apple Pay sheet O Kushki.js requestToken).
 *   3. POST { orderId, method, token, amountCents, tipCents } here.
 *   4. We charge via provider.chargeWithToken using the sub-merchant key.
 *   5. On approval, Payment becomes approved and the order recomputes.
 *
 * Google Pay isn't offered through Kushki Colombia, así que la opción
 * wallet sigue siendo solo Apple. La carta directa cubre el resto.
 *
 * In KUSHKI_MODE=mock el token puede ser cualquier string non-empty —
 * el mock provider no valida, solo devuelve approved/declined random.
 */

const schema = z.object({
  orderId: z.string().min(1),
  // kushki_apple_pay = wallet (token del Apple Pay sheet)
  // kushki_card     = tarjeta tipeada en MESAPAY (token de Kushki.js)
  method: z.enum(["kushki_apple_pay", "kushki_card"]),
  token: z.string().min(1).max(2000),
  amountCents: z.number().int().min(100),
  tipCents: z.number().int().min(0).default(0),
  // Contacto del titular para el contactDetails de Kushki (3DS). Sólo
  // tenemos lo que el diner tipeó en el form de tarjeta (nombre + correo).
  contactName: z.string().trim().max(120).optional(),
  contactEmail: z.string().trim().max(160).optional(),
});

export async function POST(
  req: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;
  const tenant = await db.restaurant.findUnique({ where: { slug } });
  if (!tenant) {
    return NextResponse.json({ error: "unknown tenant" }, { status: 404 });
  }
  if (!tenant.kushkiMerchantId) {
    return NextResponse.json(
      { error: "tenant_not_onboarded" },
      { status: 409 },
    );
  }

  const body = await req.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid payload" }, { status: 400 });
  }

  const order = await db.order.findUnique({ where: { id: parsed.data.orderId } });
  if (!order || order.restaurantId !== tenant.id) {
    return NextResponse.json({ error: "order not found" }, { status: 404 });
  }

  // Barrer pendings en vuelo de esta orden (intentos previos de tarjeta/
  // datáfono/wallet abandonados o interrumpidos): el diner está haciendo ESTE
  // cobro ahora → los anteriores quedan obsoletos. "Última intención gana",
  // mismo patrón que el efectivo y el datáfono. SIN esto, un pending viejo
  // consumía el outstanding y el cap rechazaba el charge con 409 ANTES de
  // llegar a Kushki (Kushki "no veía ejecutarse el charge" tras el 3DS).
  await db.payment.updateMany({
    where: { orderId: order.id, status: "pending" },
    data: { status: "declined" },
  });

  // Cap before reaching out to Kushki — much better to reject the
  // overcharge here than to capture a real card transaction we'd then
  // have to refund manually. excludePending: ya barrimos los pendings arriba,
  // pero lo excluimos igual por si entra otro en la misma ventana.
  const foodPortion = parsed.data.amountCents - parsed.data.tipCents;
  const cap = await validateNewPaymentAmount(order.id, foodPortion, {
    excludePending: true,
  });
  if (!cap.ok) {
    return NextResponse.json(
      {
        error: cap.reason,
        outstandingCents: cap.outstandingCents,
        message:
          cap.reason === "order_already_paid"
            ? "Esta cuenta ya fue pagada."
            : `Quedan $${(cap.outstandingCents / 100).toLocaleString("es-CO")} pendientes — intenta de nuevo con un monto menor.`,
      },
      { status: 409 },
    );
  }

  // Pre-create the payment row so we can reference it from logs/webhooks even
  // if the provider call fails. Status starts pending; we flip it after the
  // provider replies.
  const pendingPayment = await db.payment.create({
    data: {
      orderId: order.id,
      method: parsed.data.method,
      status: "pending",
      amountCents: parsed.data.amountCents,
      tipCents: parsed.data.tipCents,
    },
  });

  const provider = await getPaymentProvider(
    await getRestaurantKushkiMode(tenant),
  );
  const privateKey = await getRestaurantPrivateKey(tenant.id);
  if (!privateKey) {
    await db.payment.update({
      where: { id: pendingPayment.id },
      data: { status: "declined" },
    });
    return NextResponse.json(
      { error: "credentials_missing" },
      { status: 500 },
    );
  }

  const currency = await getCurrencyForCountry(tenant.country);

  // contactDetails para Kushki (lo pide en el charge para el 3DS). Un solo
  // campo `name` con el nombre completo; el correo va sólo si existe. Antes
  // partíamos el nombre en firstName/lastName y con un nombre de una palabra
  // mandábamos el mismo valor repetido.
  const rawName = parsed.data.contactName?.trim();
  const rawEmail = parsed.data.contactEmail?.trim();
  const contactDetails = rawName
    ? {
        name: rawName,
        ...(rawEmail && rawEmail.includes("@") ? { email: rawEmail } : {}),
      }
    : undefined;

  let charge;
  try {
    charge = await provider.chargeWithToken({
      // For Kushki, the per-merchant private key is what authenticates the
      // charge; we pass it where the interface asks for merchantId.
      merchantId: privateKey,
      amount: { amountCents: parsed.data.amountCents, currency },
      token: parsed.data.token,
      metadata: {
        orderId: order.id,
        paymentId: pendingPayment.id,
        tableId: order.tableId,
      },
      ...(contactDetails ? { contactDetails } : {}),
    });
  } catch (err) {
    await db.payment.update({
      where: { id: pendingPayment.id },
      data: { status: "declined" },
    });
    publishOrderEvent(tenant.id, {
      type: "payment.declined",
      orderId: order.id,
      paymentId: pendingPayment.id,
      reason: err instanceof Error ? err.message : "provider_error",
    });
    // Surface the underlying Kushki error so el diner (y devs viendo
    // consola) entienden qué pasó. Para errores estándar como CVV
    // inválido / fondos insuficientes la mensaje cruda de Kushki es
    // más útil que "charge_failed" genérico.
    const detail =
      err instanceof Error ? err.message.slice(0, 300) : "provider_error";
    console.error("[kushki-charge] FAILED", { detail });
    // Parse common Kushki codes para mensaje user-friendly.
    let userMessage = "El pago falló. Probá con otra tarjeta o método.";
    if (detail.includes('"code":"022"') || detail.includes("(022)")) {
      userMessage = "Tarjeta declinada — CVV inválido.";
    } else if (detail.includes('"code":"021"') || detail.includes("(021)")) {
      userMessage = "Tarjeta declinada — fondos insuficientes.";
    } else if (detail.includes('"code":"017"') || detail.includes("(017)")) {
      userMessage = "Tarjeta inválida.";
    } else if (detail.includes('"code":"023"') || detail.includes("(023)")) {
      userMessage = "Tarjeta bloqueada.";
    } else if (detail.includes('"code":"577"')) {
      // Token ya usado. Pasa cuando un charge anterior consumió el
      // token (con éxito o no) y el cliente intenta cobrarlo de nuevo.
      // Le pedimos al diner que cierre y reabra el form para forzar
      // una tokenización fresca.
      userMessage =
        "El intento anterior expiró. Cerrá esta ventana y volvé a ingresar los datos.";
    } else if (detail.includes('"code":"K040"')) {
      userMessage =
        "Credenciales del comercio no configuradas correctamente. Avisá al restaurante.";
    } else if (detail.includes("K220")) {
      userMessage = "Error procesando el cobro — reintentá.";
    }
    return NextResponse.json(
      {
        error: "charge_failed",
        message: userMessage,
        detail,
      },
      { status: 502 },
    );
  }

  // Persist the provider reference + KushkiTransaction mirror regardless of
  // outcome so we can audit declined attempts.
  await db.kushkiTransaction.create({
    data: {
      restaurantId: tenant.id,
      paymentId: pendingPayment.id,
      kushkiTxId: charge.providerRef,
      kind: "charge",
      status: charge.status === "approved" ? "approved" : "declined",
      amountCents: parsed.data.amountCents,
      raw: charge.raw as object,
      message: charge.message,
    },
  });

  if (charge.status !== "approved") {
    await db.payment.update({
      where: { id: pendingPayment.id },
      data: { status: "declined", providerRef: charge.providerRef },
    });
    publishOrderEvent(tenant.id, {
      type: "payment.declined",
      orderId: order.id,
      paymentId: pendingPayment.id,
      reason: charge.message ?? "declined",
    });
    return NextResponse.json({
      paymentId: pendingPayment.id,
      approved: false,
      message: charge.message ?? "Pago rechazado",
    });
  }

  // Approved: flip payment, recompute order, release rounds if fully paid.
  const result = await db.$transaction(async (tx) => {
    await tx.payment.update({
      where: { id: pendingPayment.id },
      data: {
        status: "approved",
        providerRef: charge.providerRef,
        settledAt: new Date(),
      },
    });
    // Guardamos el correo del titular en la orden para prellenar el pedido de
    // factura en /done y no volver a pedírselo. Sólo si vino uno válido.
    if (rawEmail && rawEmail.includes("@")) {
      await tx.order.update({
        where: { id: order.id },
        data: { customerEmail: rawEmail },
      });
    }
    const totals = await recomputeOrderTotalsInTx(tx, order.id);
    if (totals.fullyPaid) {
      await activateOpenRounds(tx, order.id);
    }
    return { fullyPaid: totals.fullyPaid };
  });

  publishOrderEvent(tenant.id, {
    type: "payment.approved",
    orderId: order.id,
    paymentId: pendingPayment.id,
  });
  publishOrderEvent(tenant.id, {
    type: result.fullyPaid ? "order.paid" : "order.updated",
    orderId: order.id,
  });

  if (result.fullyPaid && order.customerId) {
    welcomeIfFirstTime(order.customerId, order.locale).catch((err) =>
      console.error("[welcomeIfFirstTime]", err),
    );
  }

  return NextResponse.json({
    paymentId: pendingPayment.id,
    approved: true,
    paid: result.fullyPaid,
  });
}
