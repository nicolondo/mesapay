import { secureApi } from "@/lib/secureApi";
import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { getActiveRestaurantId } from "@/lib/activeRestaurant";
import { MENU_ITEM_ORDERS } from "@/lib/menuOrder";

/**
 * Ajustes de la carta del comercio activo. Hoy sólo el orden de los platos
 * dentro de cada categoría: "alphabetical" (default) o "manual" (según el
 * editor). Se autoguarda desde el selector del encabezado del editor de la
 * carta. Ver src/lib/menuOrder.ts.
 */
const schema = z.object({
  menuItemOrder: z.enum(MENU_ITEM_ORDERS),
});

async function PATCHHandler(req: Request) {
  const session = await auth();
  if (
    !session?.user ||
    (session.user.role !== "operator" &&
      session.user.role !== "platform_admin" &&
      session.user.role !== "group_admin")
  ) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const restaurantId = await getActiveRestaurantId();
  if (!restaurantId) {
    return NextResponse.json({ error: "no_restaurant" }, { status: 400 });
  }

  const body = await req.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  await db.restaurant.update({
    where: { id: restaurantId },
    data: { menuItemOrder: parsed.data.menuItemOrder },
  });
  return NextResponse.json({ ok: true, menuItemOrder: parsed.data.menuItemOrder });
}

export const PATCH = secureApi(PATCHHandler);
