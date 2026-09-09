import { reservePayment, markPaymentUncertain } from "@/lib/payments/intent";
import { processKushkiWebhook } from "@/lib/payments/webhookHandler";
import { validPaymentAmounts, amountCentsSchema, tipCentsSchema } from "@/lib/payments/validation";
import { secureApi } from "@/lib/secureApi";
import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { getCurrencyForCountry } from "@/lib/billing/countries";
import { welcomeIfFirstTime } from "@/lib/mailer";
import {
  getPaymentProvider,
  getRestaurantPrivateKey,
} from "@/lib/payments";
import { extractKushkiCardInfo } from "@/lib/payments/kushki/chargeDetails";
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
  amountCents: amountCentsSchema,
  tipCents: tipCentsSchema,
  // Contacto del titular para el contactDetails de Kushki (3DS). Sólo
  // tenemos lo que el diner tipeó en el form de tarjeta (nombre + correo).
  contactName: z.string().trim().max(120).optional(),
  contactEmail: z.string().trim().max(160).optional(),
}).refine(validPaymentAmounts, { message: "invalid_amount" });

async function POSTHandler(
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

  const provider = await getPaymentProvider(await getRestaurantKushkiMode(tenant));
  const privateKey = await getRestaurantPrivateKey(tenant.id);
  if (!privateKey) return NextResponse.json({ error: "credentials_missing" }, { status: 503 });
  const intent = await reservePayment({ orderId: order.id, method: parsed.data.method, status: "pending", amountCents: parsed.data.amountCents, tipCents: parsed.data.tipCents }, parsed.data.token);
  const pendingPayment = intent.payment;
  if (!intent.created) return NextResponse.json({ paymentId: pendingPayment.id, approved: pendingPayment.status === "approved", pending: pendingPayment.status === "pending" });

  const currency = await getCurrencyForCountry(tenant.country);

  // contactDetails para Kushki (lo pide en el charge para el 3DS). Su API
  // exige firstName y lastName por separado, así que partimos el nombre
  // completo que tipeó el diner: la primera palabra es firstName y el resto
  // lastName. Con una sola palabra repetimos el valor porque Kushki exige
  // lastName no vacío. El correo va sólo si existe.
  const rawName = parsed.data.contactName?.trim();
  const rawEmail = parsed.data.contactEmail?.trim();
  const contactDetails = rawName
    ? (() => {
        const parts = rawName.split(/\s+/).filter(Boolean);
        const firstName = parts[0] ?? rawName;
        const lastName = parts.length > 1 ? parts.slice(1).join(" ") : firstName;
        return {
          firstName,
          lastName,
          ...(rawEmail && rawEmail.includes("@") ? { email: rawEmail } : {}),
        };
      })()
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
    await markPaymentUncertain(pendingPayment.id);
    console.error("charge_uncertain", { paymentId: pendingPayment.id, error: err instanceof Error ? err.name : "provider_error" });
    return NextResponse.json({ error: "payment_pending", paymentId: pendingPayment.id, pending: true }, { status: 202 });
  }


  // Persist the provider reference + KushkiTransaction mirror regardless of
  // outcome so we can audit declined attempts. Extraemos los datos ricos de la
  // tarjeta (fullResponse:"v2") a columnas legibles para la vista de pagos.
  const cardInfo = extractKushkiCardInfo(charge.raw);
  await db.kushkiTransaction.upsert({
    where: { kushkiTxId: charge.providerRef },
    update: {},
    create: {
      restaurantId: tenant.id,
      paymentId: pendingPayment.id,
      kushkiTxId: charge.providerRef,
      kind: "charge",
      status: charge.status,
      amountCents: parsed.data.amountCents,
      raw: charge.raw as object,
      message: charge.message,
      ...cardInfo,
    },
  });

  if (charge.status === "pending") {
    await db.payment.updateMany({ where: { id: pendingPayment.id, status: "pending" }, data: { providerRef: charge.providerRef, reconciliationRequired: true } });
    return NextResponse.json({ paymentId: pendingPayment.id, pending: true }, { status: 202 });
  }
  const processed = await processKushkiWebhook({
    eventId: `charge:${pendingPayment.id}:${charge.status}`, type: charge.status === "approved" ? "charge.approved" : "charge.declined",
    paymentId: pendingPayment.id, restaurantId: tenant.id, providerRef: charge.providerRef,
    amountCents: parsed.data.amountCents, raw: charge.raw,
  });
  if (processed.status === "error") {
    await markPaymentUncertain(pendingPayment.id);
    return NextResponse.json({ paymentId: pendingPayment.id, pending: true }, { status: 202 });
  }
  if (charge.status !== "approved") return NextResponse.json({ paymentId: pendingPayment.id, approved: false, error: "payment_declined" });
  if (rawEmail?.includes("@")) await db.order.update({ where: { id: order.id }, data: { customerEmail: rawEmail } });
  const settled = await db.order.findUniqueOrThrow({ where: { id: order.id }, select: { status: true } });
  const result = { fullyPaid: settled.status === "paid" };
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

export const POST = secureApi(POSTHandler);
