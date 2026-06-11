import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { getTranslations } from "next-intl/server";
import { db } from "@/lib/db";
import { fmtCOP } from "@/lib/format";
import { env } from "@/lib/env";
import {
  getPaymentProvider,
  getRestaurantPrivateKey,
} from "@/lib/payments";
import { ensureMockBridge } from "@/lib/payments/mockBridge";
import { getRestaurantKushkiMode, type KushkiMode } from "@/lib/platformConfig";
import { validateNewPaymentAmount } from "@/lib/orderTotals";

/**
 * POST /transfer/v1/init de Kushki (server-side, con private key).
 * El browser ya tokenizó con Kushki.js usando la public key; acá
 * completamos el flow para obtener la URL del banco.
 *
 * Body shape (docs.kushki.com/co/en/transfer-payments/accept-a-payment):
 *   {
 *     token, amount: { subtotalIva, subtotalIva0, iva },
 *     contactDetails: { fullName, email, address?, phoneNumber? },
 *     metadata: { ... }
 *   }
 *
 * Kushki devuelve { redirectUrl } al que mandamos al diner.
 */
async function chargeTransferInit(args: {
  token: string;
  amountPesos: number;
  buyer: {
    email: string;
    docType: string;
    docNumber: string;
    personType: string;
  };
  metadata: { orderId: string; paymentId: string };
  privateKey: string;
  mode: KushkiMode;
}): Promise<{
  redirectUrl?: string;
  url?: string;
  security?: { acsURL?: string };
  [k: string]: unknown;
}> {
  const baseUrl =
    args.mode === "production"
      ? "https://api.kushkipagos.com"
      : "https://api-uat.kushkipagos.com";

  const body = {
    token: args.token,
    amount: {
      subtotalIva: 0,
      subtotalIva0: args.amountPesos,
      iva: 0,
    },
    // contactDetails es requerido en PSE v1 según T016 que estábamos
    // recibiendo. fullName lo derivamos del email porque no lo
    // pedimos en el sheet; phoneNumber lo dejamos vacío (Kushki acepta).
    contactDetails: {
      fullName: args.buyer.email.split("@")[0] || "Cliente",
      email: args.buyer.email,
      documentType: args.buyer.docType,
      documentNumber: args.buyer.docNumber,
    },
    metadata: {
      orderId: args.metadata.orderId,
      paymentId: args.metadata.paymentId,
    },
  };

  const t0 = Date.now();
  console.log("[pse-init] calling /transfer/v1/init", {
    url: `${baseUrl}/transfer/v1/init`,
  });

  const res = await fetch(`${baseUrl}/transfer/v1/init`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Private-Merchant-Id": args.privateKey,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  console.log(
    `[pse-init] /transfer/v1/init response status=${res.status} en ${Date.now() - t0}ms`,
  );
  if (!res.ok) {
    throw new Error(`kushki ${res.status} on /transfer/v1/init: ${text.slice(0, 300)}`);
  }
  return text ? JSON.parse(text) : {};
}

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
  // Modo efectivo del comercio (override propio o global) → host de Kushki.
  const mode = await getRestaurantKushkiMode(tenant);
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
    const t = await getTranslations("pay");
    return NextResponse.json(
      {
        error: cap.reason,
        outstandingCents: cap.outstandingCents,
        message:
          cap.reason === "order_already_paid"
            ? t("errAlreadyPaid")
            : t("errOutstanding", { amount: fmtCOP(cap.outstandingCents) }),
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

  // 2. Si el browser ya tokenizó con Kushki.js (sandbox/prod), llamamos
  //    a /transfer/v1/init server-side con la private key + el token
  //    para obtener la URL del banco. Kushki PSE v1 NO devuelve la URL
  //    en la respuesta de tokenización — solo el token.
  if (parsed.data.token) {
    const privateKey = await getRestaurantPrivateKey(tenant.id);
    if (!privateKey) {
      await db.payment.update({
        where: { id: payment.id },
        data: { status: "declined" },
      });
      return NextResponse.json(
        {
          error: "missing_credentials",
          message:
            "Falta la private key del sub-merchant para completar PSE.",
        },
        { status: 500 },
      );
    }
    try {
      const initResp = await chargeTransferInit({
        token: parsed.data.token,
        amountPesos: parsed.data.amountCents / 100,
        buyer: parsed.data.buyer,
        metadata: { orderId: order.id, paymentId: payment.id },
        privateKey,
        mode,
      });
      const redirectUrl =
        (typeof initResp.redirectUrl === "string" && initResp.redirectUrl) ||
        (typeof initResp.url === "string" && initResp.url) ||
        initResp.security?.acsURL ||
        "";
      if (!redirectUrl) {
        throw new Error(
          "Kushki init sin redirectUrl: " +
            JSON.stringify(initResp).slice(0, 200),
        );
      }
      await db.payment.update({
        where: { id: payment.id },
        data: { providerRef: parsed.data.token },
      });
      return NextResponse.json({
        paymentId: payment.id,
        redirectUrl,
      });
    } catch (err) {
      console.error("[pse-init] transfer init FAILED", err);
      await db.payment.update({
        where: { id: payment.id },
        data: { status: "declined" },
      });
      const detail =
        err && typeof err === "object" && "message" in err
          ? String((err as { message: unknown }).message).slice(0, 300)
          : "Error desconocido";
      return NextResponse.json(
        {
          error: "init_failed",
          message: "No pudimos iniciar la transferencia con Kushki.",
          detail,
        },
        { status: 502 },
      );
    }
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
    const provider = await getPaymentProvider(mode);
    const result = await provider.initiatePse({
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
