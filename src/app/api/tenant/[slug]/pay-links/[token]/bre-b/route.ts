import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { secureApi } from "@/lib/secureApi";
import { isModuleEnabled } from "@/lib/modules";
import { offerablePaymentMethods } from "@/lib/paymentMethods";
import { appOrigin, paymentLinkIsOpen } from "@/lib/paymentLinks";
import {
  BRE_B_TENANT_SELECT,
  breBChargeView,
  cancelBreBCharge,
  checkBreBCharge,
  startLinkBreBCharge,
} from "@/lib/payments/breB/service";
import { BRE_B_OPEN_STATES } from "@/lib/payments/breB/view";

/**
 * Bre-B en un LINK DE PAGO de monto fijo (`/r/[slug]/pago/[token]`: bonos
 * prepagados, cortes). No hay `Payment`: el intento (`BreBCharge`) cuelga
 * del link y, al aprobarse, lo cierra con el mismo `settlePaymentLinkInTx`
 * que tarjeta y PSE.
 *
 *   POST { action: "start" }  → QR nuevo, o el que ya está vigente (un solo
 *        QR vivo por link: dos pagables serían dos cobros).
 *   POST { action: "check", chargeId }  → consulta el estado y lo aplica.
 *   POST { action: "cancel", chargeId } → cancela el QR (cambiar de medio).
 *
 * El token del link es la credencial: quien lo tiene puede pagarlo.
 */
const schema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("start") }),
  z.object({ action: z.literal("check"), chargeId: z.string().min(1) }),
  z.object({ action: z.literal("cancel"), chargeId: z.string().min(1) }),
]);

async function POSTHandler(req: Request, { params }: { params: Promise<{ slug: string; token: string }> }) {
  const { slug, token } = await params;
  const tenant = await db.restaurant.findUnique({
    where: { slug },
    select: { ...BRE_B_TENANT_SELECT, enabledPaymentMethods: true, enabledModules: true },
  });
  if (!tenant) return NextResponse.json({ error: "unknown_tenant" }, { status: 404 });
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid" }, { status: 400 });

  // El link es de ESTE comercio o no existe: no se revela lo ajeno.
  const link = await db.paymentLink.findUnique({ where: { token } });
  if (!link || link.restaurantId !== tenant.id) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  if (parsed.data.action !== "start") {
    const charge = await db.breBCharge.findUnique({ where: { id: parsed.data.chargeId } });
    if (!charge || charge.paymentLinkId !== link.id) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    const after =
      parsed.data.action === "cancel"
        ? await cancelBreBCharge(charge.id, { reason: "payer" })
        : await checkBreBCharge(charge.id);
    return NextResponse.json({ charge: await breBChargeView(after ?? charge) });
  }

  if (!paymentLinkIsOpen(link)) {
    return NextResponse.json({ error: "link_closed", status: link.status }, { status: 409 });
  }
  if (link.kind.startsWith("voucher_") && !isModuleEnabled(tenant.enabledModules, "vouchers")) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  if (!offerablePaymentMethods(tenant.enabledPaymentMethods, tenant).includes("kushki_bre_b")) {
    return NextResponse.json({ error: "method_disabled" }, { status: 403 });
  }
  const result = await startLinkBreBCharge({
    tenant,
    link: { id: link.id, amountCents: link.amountCents, currency: link.currency },
    webhookUrl: `${appOrigin(req)}/api/webhooks/kushki`,
  });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.httpStatus });
  return NextResponse.json({ charge: result.view }, { status: result.httpStatus });
}

/** El QR vigente del link (para retomarlo al recargar), o `charge: null`. */
async function GETHandler(_req: Request, { params }: { params: Promise<{ slug: string; token: string }> }) {
  const { slug, token } = await params;
  const link = await db.paymentLink.findUnique({
    where: { token },
    select: { id: true, restaurant: { select: { slug: true } } },
  });
  if (!link || link.restaurant.slug !== slug) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const charge = await db.breBCharge.findFirst({
    where: { paymentLinkId: link.id, status: { in: [...BRE_B_OPEN_STATES] } },
    orderBy: { createdAt: "desc" },
  });
  return NextResponse.json({ charge: charge ? await breBChargeView(charge, { withQr: true }) : null });
}

export const GET = secureApi(GETHandler);
export const POST = secureApi(POSTHandler);
