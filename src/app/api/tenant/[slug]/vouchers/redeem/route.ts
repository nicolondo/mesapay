import { secureApi } from "@/lib/secureApi";
import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { isChargeBlockedForRole } from "@/lib/chargeControl";
import { chargeBlockedResponse } from "@/lib/chargeGuard";
import { rateLimit } from "@/lib/rateLimit";
import { COLLECTOR_ROLES, staffForRestaurant } from "@/lib/staffAccess";
import { redeemVoucher } from "@/lib/vouchers/redeem";

/**
 * Aplica un bono a la cuenta: nace un Payment `voucher` aprobado por el
 * menor entre el saldo y lo pendiente. Canal `staff` si hay sesión de
 * staff del comercio (mesero / caja), `diner` si viene del portal del
 * comensal (el guard de secureApi ya validó el acceso a la orden).
 *
 * Control de caja: con "solo el administrador cobra" el mesero tampoco
 * puede aplicar bonos (es una forma de pago como cualquier otra); el
 * comensal desde su QR sí.
 *
 * POST { orderId, code }
 */
const schema = z.object({
  orderId: z.string().min(1),
  code: z.string().trim().min(4).max(40),
});

const STATUS: Record<string, number> = {
  module_disabled: 403,
  not_found: 404,
  batch_unpaid: 409,
  batch_cancelled: 409,
  cancelled: 409,
  expired: 409,
  exhausted: 409,
  order_closed: 409,
  nothing_outstanding: 409,
};

async function POSTHandler(
  req: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;
  const tenant = await db.restaurant.findUnique({
    where: { slug },
    select: { id: true, adminOnlyCharge: true },
  });
  if (!tenant) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid" }, { status: 400 });
  if (!(await rateLimit(`vouchers:redeem:${tenant.id}:${parsed.data.orderId}`, 20, 300))) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429, headers: { "Retry-After": "300" } });
  }

  const staff = await staffForRestaurant(tenant.id, COLLECTOR_ROLES);
  if (staff && isChargeBlockedForRole(staff.user.role, tenant.adminOnlyCharge)) {
    return chargeBlockedResponse();
  }

  const result = await redeemVoucher({
    restaurantId: tenant.id,
    code: parsed.data.code,
    orderId: parsed.data.orderId,
    channel: staff ? "staff" : "diner",
    userId: staff?.user.id ?? null,
  });
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: STATUS[result.error] ?? 400 });
  }
  return NextResponse.json(result);
}

export const POST = secureApi(POSTHandler);
