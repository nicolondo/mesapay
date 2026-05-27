import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import {
  getPaymentProvider,
  getRestaurantPrivateKey,
} from "@/lib/payments";
import { ensureMockBridge } from "@/lib/payments/mockBridge";
import { validateNewPaymentAmount } from "@/lib/orderTotals";

/**
 * PSE init — crea un Payment pending, llama a Kushki PSE init, y
 * devuelve la URL del banco a la que el cliente debe ir.
 *
 * Flow completo:
 *   1. Diner toca PSE en checkout + elige banco + ingresa datos
 *   2. Este endpoint crea pending Payment(method=kushki_pse)
 *   3. Llama provider.initiatePse() → recibe redirectUrl
 *   4. Devuelve { paymentId, redirectUrl }
 *   5. Front redirige al banco con window.location = redirectUrl
 *   6. Banco autentica, redirige a `${origin}/t/${slug}/pay/${orderId}/pse-return?pid=...`
 *   7. Webhook pse.approved | pse.declined cierra el Payment async
 *
 * El cap usa excludePending=true porque la transacción sweep-y-crea
 * también limpia otros pendings de la orden (misma política que las
 * otras rieles diner-side).
 */

// PSE init/registro. Dos modos:
//   - Mock (mode=mock): browser POSTea sólo buyer+bankCode. Backend
//     usa el provider mock para tokenizar y devolver redirectUrl.
//   - Sandbox/Producción (mode=sandbox|production): browser ya
//     tokenizó con Kushki.js (que maneja Sift Science correctamente)
//     y POSTea {token, redirectUrl}. Backend sólo registra el Payment
//     y devuelve confirmación.
//
// Distinguimos por la presencia del campo `token` en el body.
const schema = z.object({
  orderId: z.string().min(1),
  amountCents: z.number().int().min(100),
  tipCents: z.number().int().min(0).default(0),
  bankCode: z.string().trim().min(1),
  buyer: z.object({
    email: z.string().trim().email(),
    docType: z.enum(["CC", "CE", "NIT", "PA", "TI"]).default("CC"),
    docNumber: z.string().trim().min(4).max(20),
    personType: z.enum(["natural", "juridica"]).default("natural"),
  }),
  // Si el browser ya tokenizó con Kushki.js, pasa el token + redirect.
  // En mock mode estos campos no se envían y el backend tokeniza vía
  // el provider mock.
  token: z.string().trim().min(1).optional(),
  redirectUrl: z.string().trim().url().optional(),
});

export async function POST(
  req: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  // En mock mode, instalamos el bridge que enchufa el bus de webhooks
  // simulados al handler real. Es idempotente — solo se instala la
  // primera vez por proceso.
  ensureMockBridge();
  const { slug } = await params;
  const tenant = await db.restaurant.findUnique({ where: { slug } });
  if (!tenant) {
    return NextResponse.json({ error: "unknown tenant" }, { status: 404 });
  }
  if (
    !tenant.kushkiMerchantId ||
    tenant.kushkiOnboardingStatus !== "active"
  ) {
    return NextResponse.json(
      { error: "pse_not_available" },
      { status: 400 },
    );
  }

  const body = await req.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid payload", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const order = await db.order.findUnique({
    where: { id: parsed.data.orderId },
  });
  if (!order || order.restaurantId !== tenant.id) {
    return NextResponse.json({ error: "order not found" }, { status: 404 });
  }

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

  // Tracking de quién inicia el cobro (mesero/operator/diner anon).
  const session = await auth();
  const collectedByUserId =
    session?.user &&
    (session.user.role === "mesero" ||
      session.user.role === "operator" ||
      session.user.role === "platform_admin")
      ? session.user.id
      : null;

  // Origin para construir el callbackUrl absoluto que Kushki necesita.
  // Detrás de nginx/proxy, req.url es la URL interna (localhost:3300),
  // no la que ve el cliente. Preferimos APP_PUBLIC_BASE_URL (canónica)
  // → headers x-forwarded-host/proto que nginx forwardea → fallback a
  // req.url para dev local sin proxy.
  const origin = (() => {
    if (env.APP_PUBLIC_BASE_URL) {
      return env.APP_PUBLIC_BASE_URL.replace(/\/$/, "");
    }
    const xfHost = req.headers.get("x-forwarded-host");
    const xfProto = req.headers.get("x-forwarded-proto") ?? "https";
    if (xfHost) return `${xfProto}://${xfHost}`;
    const host = req.headers.get("host");
    if (host) {
      const proto = host.includes("localhost") ? "http" : "https";
      return `${proto}://${host}`;
    }
    return new URL(req.url).origin;
  })();

  // 1. Crear pending Payment + sweep otros pendings (mismo patrón
  //    que cash / terminal). El providerRef se completa después con
  //    el ticket que devuelve Kushki.
  const payment = await db.$transaction(async (tx) => {
    await tx.payment.updateMany({
      where: { orderId: order.id, status: "pending" },
      data: { status: "declined" },
    });
    const p = await tx.payment.create({
      data: {
        orderId: order.id,
        method: "kushki_pse",
        status: "pending",
        amountCents: parsed.data.amountCents,
        tipCents: parsed.data.tipCents,
        collectedByUserId,
      },
    });
    await tx.order.update({
      where: { id: order.id },
      data: {
        status: order.status === "paid" ? order.status : "paying",
      },
    });
    return p;
  });

  // 2. Si el browser ya tokenizó con Kushki.js (sandbox/prod), sólo
  //    registramos el Payment con el token. El redirect lo armó el
  //    SDK con security.acsURL del response real de Kushki.
  if (parsed.data.token && parsed.data.redirectUrl) {
    await db.payment.update({
      where: { id: payment.id },
      data: { providerRef: parsed.data.token },
    });
    return NextResponse.json({
      paymentId: payment.id,
      redirectUrl: parsed.data.redirectUrl,
    });
  }

  // 3. Mock path: el backend tokeniza con el provider mock.
  const publicKey =
    tenant.kushkiPublicKey ??
    ((await getRestaurantPrivateKey(tenant.id)) ? "mock_public_key" : null);
  if (!publicKey) {
    await db.payment.update({
      where: { id: payment.id },
      data: { status: "declined" },
    });
    return NextResponse.json(
      { error: "missing_credentials" },
      { status: 500 },
    );
  }

  const returnUrl = `${origin}/t/${slug}/pay/${order.id}/pse-return?pid=${payment.id}`;

  try {
    const result = await getPaymentProvider().initiatePse({
      merchantId: publicKey,
      amount: {
        amountCents: parsed.data.amountCents,
        currency: "COP",
      },
      buyer: parsed.data.buyer,
      bankCode: parsed.data.bankCode,
      paymentDescription: `Pago ${tenant.name} · orden ${order.id.slice(0, 6)}`,
      callbackUrl: returnUrl,
      metadata: {
        orderId: order.id,
        paymentId: payment.id,
      },
    });

    await db.payment.update({
      where: { id: payment.id },
      data: { providerRef: result.providerRef },
    });

    const absoluteRedirect = result.redirectUrl.startsWith("http")
      ? result.redirectUrl
      : `${origin}${result.redirectUrl}`;

    return NextResponse.json({
      paymentId: payment.id,
      redirectUrl: absoluteRedirect,
    });
  } catch (err) {
    console.error("[pse-init] provider failed", err);
    await db.payment.update({
      where: { id: payment.id },
      data: { status: "declined" },
    });
    // Surface the underlying error message so we can debug. Para
    // Kushki nuestros KushkiHttpError tienen body con el mensaje.
    const detail =
      err && typeof err === "object" && "message" in err
        ? String((err as { message: unknown }).message).slice(0, 300)
        : "Error desconocido";
    return NextResponse.json(
      {
        error: "provider_error",
        message: "No pudimos iniciar PSE.",
        detail,
      },
      { status: 502 },
    );
  }
}
