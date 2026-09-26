import { secureApi } from "@/lib/secureApi";
import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { rateLimit } from "@/lib/rateLimit";
import { COLLECTOR_ROLES, staffForRestaurant } from "@/lib/staffAccess";
import { previewVoucher } from "@/lib/vouchers/redeem";

/**
 * Verifica un código de bono contra una cuenta SIN aplicarlo: devuelve
 * saldo y cuánto se aplicaría. Público (comensal desde su QR o staff);
 * el guard de secureApi ya exige acceso a la orden del body. Con límite
 * por cuenta para que nadie adivine códigos a fuerza bruta.
 *
 * POST { orderId, code }
 */
const schema = z.object({
  orderId: z.string().min(1),
  code: z.string().trim().min(4).max(40),
});

async function POSTHandler(
  req: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;
  const tenant = await db.restaurant.findUnique({ where: { slug }, select: { id: true } });
  if (!tenant) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid" }, { status: 400 });
  if (!(await rateLimit(`vouchers:lookup:${tenant.id}:${parsed.data.orderId}`, 20, 300))) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429, headers: { "Retry-After": "300" } });
  }
  // Canal como en la redención: al staff las solicitudes del comensal
  // pendientes no le restan (el bono las reemplaza al aplicarse).
  const staff = await staffForRestaurant(tenant.id, COLLECTOR_ROLES);
  const result = await previewVoucher({
    restaurantId: tenant.id,
    code: parsed.data.code,
    orderId: parsed.data.orderId,
    channel: staff ? "staff" : "diner",
  });
  if (!result.ok) {
    const status = result.error === "module_disabled" ? 403 : result.error === "not_found" ? 404 : 409;
    return NextResponse.json({ error: result.error }, { status });
  }
  return NextResponse.json(result);
}

export const POST = secureApi(POSTHandler);
