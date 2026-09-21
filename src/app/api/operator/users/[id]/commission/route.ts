import { secureApi } from "@/lib/secureApi";
import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { getActiveRestaurantId } from "@/lib/activeRestaurant";
import { pctToBps } from "@/lib/waiterCommissions";

/**
 * `commissionPct`: porcentaje con hasta dos decimales (2,5 = 2,5 %), o
 * null para quitar la comisión. Se guarda en puntos base
 * (`User.waiterCommissionBps`, 250 = 2,5 %).
 */
const putBody = z.object({
  commissionPct: z.number().min(0).max(100).nullable(),
});

function guard(role?: string) {
  return role === "operator" || role === "platform_admin";
}

/**
 * Tasa de comisión de ventas de UN mesero. Es la tasa VIGENTE: se copia a
 * cada cuenta al cobrarla (sellado), así que cambiarla acá no reescribe
 * cuentas ya cobradas — sólo afecta las futuras.
 *
 * Mismo alcance que `tables/route.ts`: el usuario objetivo tiene que ser
 * un mesero del restaurante activo del operador.
 */
async function PUTHandler(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!guard(session?.user?.role)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const restaurantId = await getActiveRestaurantId();
  if (!restaurantId) {
    return NextResponse.json({ error: "no_restaurant" }, { status: 400 });
  }
  const { id } = await params;

  const body = await req.json().catch(() => null);
  const parsed = putBody.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid" }, { status: 400 });
  }

  const target = await db.user.findUnique({
    where: { id },
    select: { id: true, role: true, restaurantId: true },
  });
  if (!target || target.restaurantId !== restaurantId) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  if (target.role !== "mesero") {
    return NextResponse.json({ error: "only_mesero_supported" }, { status: 400 });
  }

  const pct = parsed.data.commissionPct;
  const commissionBps = pct === null ? null : pctToBps(pct);
  await db.user.update({
    where: { id },
    data: { waiterCommissionBps: commissionBps },
  });

  return NextResponse.json({ ok: true, commissionBps });
}

export const PUT = secureApi(PUTHandler);
