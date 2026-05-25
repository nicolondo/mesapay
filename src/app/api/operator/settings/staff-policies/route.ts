import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { getActiveRestaurantId } from "@/lib/activeRestaurant";
import { TIP_POLICIES, SHIFT_POLICIES } from "@/lib/staffPolicies";

const putBody = z.object({
  tipPolicy: z.enum(TIP_POLICIES).optional(),
  shiftPolicy: z.enum(SHIFT_POLICIES).optional(),
});

/**
 * Actualiza las dos políticas del staff del restaurante activo:
 *   - tipPolicy:   "shared" vs "by_waiter"
 *   - shiftPolicy: "global" vs "by_waiter"
 *
 * Tenant-scoped + operator/admin only. Aceptamos PUT con cualquiera de
 * las dos llaves (o ambas) — el cliente puede actualizar una sola sin
 * mandar la otra.
 */
export async function PUT(req: Request) {
  const session = await auth();
  if (
    !session?.user ||
    (session.user.role !== "operator" && session.user.role !== "platform_admin")
  ) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const restaurantId = await getActiveRestaurantId();
  if (!restaurantId) {
    return NextResponse.json({ error: "no_restaurant" }, { status: 400 });
  }

  const body = await req.json().catch(() => null);
  const parsed = putBody.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  await db.restaurant.update({
    where: { id: restaurantId },
    data: {
      ...(parsed.data.tipPolicy !== undefined && {
        tipPolicy: parsed.data.tipPolicy,
      }),
      ...(parsed.data.shiftPolicy !== undefined && {
        shiftPolicy: parsed.data.shiftPolicy,
      }),
    },
  });

  return NextResponse.json({ ok: true });
}
