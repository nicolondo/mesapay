import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { secureApi } from "@/lib/secureApi";
import { isChargeBlockedForRole } from "@/lib/chargeControl";
import { chargeBlockedResponse } from "@/lib/chargeGuard";
import { appOrigin } from "@/lib/http/publicOrigin";
import { meseroNeedsShiftToCharge } from "@/lib/meseroShift";
import { offerablePaymentMethods } from "@/lib/paymentMethods";
import { COLLECTOR_ROLES, staffForRestaurant } from "@/lib/staffAccess";
import { amountCentsSchema, tipCentsSchema, validPaymentAmounts } from "@/lib/payments/validation";
import { startOrderBreBCharge } from "@/lib/payments/breB/service";
import { collectorUserIdFor } from "@/lib/payments/staffCheckout";

/**
 * «Pagar con Bre-B» / «Cobrar con Bre-B»: reserva un pago pendiente por
 * (una parte de) la cuenta y devuelve el QR para mostrarlo.
 *
 *   - El comensal lo abre desde su celular (paga con la app de su banco:
 *     escanea desde otro aparato o copia el código).
 *   - El staff (mesero, administrador o el usuario de datáfono desde
 *     «Mesas en vivo»; ver `staffCheckoutCapabilities.breB`) lo abre en SU
 *     dispositivo para que el cliente lo escanee.
 *     Como en el resto del cobro del staff, reemplaza las solicitudes del
 *     comensal y respeta los pagos en vuelo (409 `pending_payment_in_flight`).
 *
 * El resultado NO llega acá: llega por webhook y por la consulta de estado
 * (`/api/tenant/[slug]/payment/[paymentId]/bre-b`). Mientras el QR esté vivo
 * el pago está en vuelo y nadie puede cobrar esa parte por otro medio.
 *
 * `secureApi` ya exigió acceso a la orden y que `kushki_bre_b` esté
 * habilitado (`method_disabled`). `Idempotency-Key`: un reintento de la
 * misma pantalla devuelve el mismo cobro, no otro QR.
 */
const schema = z
  .object({
    orderId: z.string().min(1),
    // amountCents = TOTAL (comida + propina), como el resto de los rieles.
    amountCents: amountCentsSchema,
    tipCents: tipCentsSchema,
  })
  .refine(validPaymentAmounts, { message: "invalid_amount" });

async function POSTHandler(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const tenant = await db.restaurant.findUnique({ where: { slug } });
  if (!tenant) return NextResponse.json({ error: "not_found" }, { status: 404 });

  // Control de caja: Bre-B también es un cobro. Con "solo el administrador
  // cobra", un mesero no puede iniciarlo; el comensal llega sin sesión y pasa.
  if (tenant.adminOnlyCharge) {
    const session = await auth();
    if (isChargeBlockedForRole(session?.user?.role, true)) return chargeBlockedResponse();
  }

  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid_amount" }, { status: 400 });

  // Habilitado Y con las llaves del comercio Bre-B cargadas.
  if (!offerablePaymentMethods(tenant.enabledPaymentMethods, tenant).includes("kushki_bre_b")) {
    return NextResponse.json({ error: "bre_b_not_configured" }, { status: 409 });
  }

  const order = await db.order.findUnique({ where: { id: parsed.data.orderId }, select: { id: true, restaurantId: true } });
  if (!order || order.restaurantId !== tenant.id) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const staff = await staffForRestaurant(tenant.id, COLLECTOR_ROLES);
  if (staff && (await meseroNeedsShiftToCharge(staff.user.id, staff.user.role, tenant.id))) {
    return NextResponse.json({ error: "mesero_no_shift" }, { status: 409 });
  }

  const result = await startOrderBreBCharge({
    tenant,
    orderId: order.id,
    amountCents: parsed.data.amountCents,
    tipCents: parsed.data.tipCents,
    collectedByUserId: collectorUserIdFor(staff?.user),
    staffCharge: !!staff,
    idempotencyKey: req.headers.get("idempotency-key"),
    // Kushki avisa también a esta URL (además de las de la Consola del
    // comercio Bre-B). Sólo viaja si el origen público es https.
    webhookUrl: `${appOrigin(req)}/api/webhooks/kushki`,
  });
  if (!result.ok) {
    return NextResponse.json(
      { error: result.error, ...(result.paymentId ? { paymentId: result.paymentId } : {}) },
      { status: result.httpStatus },
    );
  }
  return NextResponse.json(
    { paymentId: result.view.paymentId, charge: result.view },
    { status: result.httpStatus },
  );
}

export const POST = secureApi(POSTHandler);
