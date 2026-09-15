import { secureApi } from "@/lib/secureApi";
import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { getRestaurantPrivateKey } from "@/lib/payments";
import { kushkiApiBase } from "@/lib/payments/pseStatus";
import { getRestaurantKushkiMode } from "@/lib/platformConfig";
import {
  appOrigin,
  markPaymentLinkPending,
  paymentLinkIsOpen,
  paymentLinkPath,
  settlePaymentLinkInTx,
} from "@/lib/paymentLinks";

/**
 * Inicia el cobro de un LINK DE PAGO con PSE. Mismo flujo que el depósito
 * de reserva (`reservations/[code]/deposit/pse`):
 *
 * Sandbox/prod: el browser tokenizó con Kushki.js → manda { token, buyer }.
 *   Acá /transfer/v1/init con la private key devuelve la URL del banco;
 *   el token queda en `PaymentLink.providerRef` para que la página de
 *   retorno (`/r/[slug]/pago/[token]/return`) reconcilie con
 *   /transfer/v1/status. El webhook, si casa la referencia, también cierra.
 * Mock: no hay banco → se cierra el link al toque y se devuelve la URL de
 *   retorno (que muestra éxito).
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

async function POSTHandler(
  req: Request,
  { params }: { params: Promise<{ slug: string; token: string }> },
) {
  const { slug, token } = await params;
  const tenant = await db.restaurant.findUnique({
    where: { slug },
    select: { id: true, name: true, kushkiMerchantId: true, kushkiMode: true },
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

  const link = await db.paymentLink.findUnique({ where: { token } });
  if (!link || link.restaurantId !== tenant.id) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  if (!paymentLinkIsOpen(link)) {
    return NextResponse.json({ error: "link_closed", status: link.status }, { status: 409 });
  }

  const returnUrl = `${appOrigin(req)}${paymentLinkPath(slug, token)}/return`;
  const mode = await getRestaurantKushkiMode(tenant);

  // ── Mock: sin banco real, se cierra directo ─────────────────────────
  if (mode === "mock" || !parsed.data.token) {
    if (mode === "mock") {
      await db.$transaction((tx) =>
        settlePaymentLinkInTx(
          tx,
          { id: link.id },
          {
            approved: true,
            providerRef: `mock_pse_${link.id.slice(0, 8)}`,
            method: "kushki_pse",
            payerEmail: parsed.data.buyer.email,
          },
        ),
      );
      return NextResponse.json({ redirectUrl: returnUrl });
    }
    return NextResponse.json({ error: "missing_token" }, { status: 400 });
  }

  // ── Live/sandbox: /transfer/v1/init con la private key ─────────────
  const privateKey = await getRestaurantPrivateKey(tenant.id);
  if (!privateKey) {
    return NextResponse.json({ error: "credentials_missing" }, { status: 500 });
  }
  try {
    const res = await fetch(`${kushkiApiBase(mode)}/transfer/v1/init`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Private-Merchant-Id": privateKey,
      },
      body: JSON.stringify({
        token: parsed.data.token,
        amount: { subtotalIva: 0, subtotalIva0: link.amountCents / 100, iva: 0 },
        contactDetails: {
          fullName: tenant.name,
          email: parsed.data.buyer.email,
          documentType: parsed.data.buyer.docType,
          documentNumber: parsed.data.buyer.docNumber,
        },
        metadata: { paymentLinkId: link.id, kind: "payment_link" },
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
    if (!redirectUrl) throw new Error("Kushki init sin redirectUrl");
    await markPaymentLinkPending(link.id, parsed.data.token, "kushki_pse", parsed.data.buyer.email);
    return NextResponse.json({ redirectUrl });
  } catch (err) {
    console.error("[pay-link-pse] init FAILED", err);
    return NextResponse.json({ error: "init_failed" }, { status: 502 });
  }
}

export const POST = secureApi(POSTHandler);
