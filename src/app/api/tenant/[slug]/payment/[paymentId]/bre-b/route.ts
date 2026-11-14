import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { secureApi } from "@/lib/secureApi";
import { isChargeBlocked, chargeBlockedResponse } from "@/lib/chargeGuard";
import { COLLECTOR_ROLES, staffForRestaurant } from "@/lib/staffAccess";
import { breBChargeView, cancelBreBCharge, checkBreBCharge } from "@/lib/payments/breB/service";

/**
 * El QR Bre-B de un pago de la cuenta: verlo, consultarlo y cancelarlo.
 * `secureApi` ya verificó que quien llama tiene acceso a la orden del pago
 * (la cookie de invitado de esa cuenta, o alguien del equipo).
 *
 *   GET  → el cobro con su QR (para pintarlo o retomarlo tras recargar).
 *   POST { action: "check" }  → consulta el estado real en Kushki (como
 *        mucho cada 10 s por cobro; `force` = «Consultar estado» del staff)
 *        y lo aplica: aprobado, rechazado, vencido…
 *   POST { action: "cancel" } → cancela el QR en Kushki. La cuenta se libera
 *        SÓLO si Kushki lo confirma; si no, el cobro queda `uncertain`.
 */

async function loadCharge(slug: string, paymentId: string) {
  const payment = await db.payment.findUnique({
    where: { id: paymentId },
    select: {
      id: true,
      method: true,
      order: { select: { restaurantId: true, restaurant: { select: { slug: true } } } },
      breBCharge: true,
    },
  });
  if (!payment || payment.order.restaurant.slug !== slug || payment.method !== "kushki_bre_b" || !payment.breBCharge) {
    return null;
  }
  return { charge: payment.breBCharge, restaurantId: payment.order.restaurantId };
}

async function GETHandler(_req: Request, { params }: { params: Promise<{ slug: string; paymentId: string }> }) {
  const { slug, paymentId } = await params;
  const found = await loadCharge(slug, paymentId);
  if (!found) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({ charge: await breBChargeView(found.charge, { withQr: true }) });
}

const schema = z.object({
  action: z.enum(["check", "cancel"]),
  // «Consultar estado» del staff: pregunta a Kushki ya, sin esperar el turno.
  force: z.boolean().optional(),
});

async function POSTHandler(req: Request, { params }: { params: Promise<{ slug: string; paymentId: string }> }) {
  const { slug, paymentId } = await params;
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid_payload" }, { status: 400 });
  const found = await loadCharge(slug, paymentId);
  if (!found) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const staff = await staffForRestaurant(found.restaurantId, COLLECTOR_ROLES);
  if (parsed.data.action === "cancel") {
    // Con "solo el administrador cobra", el mesero tampoco cancela cobros.
    const session = staff ?? (await auth());
    if (await isChargeBlocked(session?.user?.role, found.restaurantId)) return chargeBlockedResponse();
    const after = await cancelBreBCharge(found.charge.id, { reason: staff ? "staff" : "payer" });
    return NextResponse.json({ charge: await breBChargeView(after ?? found.charge) });
  }
  // Sólo el equipo puede saltarse el turno de consulta a Kushki.
  const after = await checkBreBCharge(found.charge.id, { force: !!staff && parsed.data.force === true });
  return NextResponse.json({ charge: await breBChargeView(after ?? found.charge) });
}

export const GET = secureApi(GETHandler);
export const POST = secureApi(POSTHandler);
