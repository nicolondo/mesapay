import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { getActiveRestaurantId } from "@/lib/activeRestaurant";

/**
 * Guardar el business code del Cloud Terminal (datáfono cloud) del
 * comercio. Se edita desde Configuración → Datáfonos. "" → null.
 */
const schema = z.object({
  businessCode: z
    .string()
    .trim()
    .max(64)
    .nullable()
    .transform((v) => (v ? v : null)),
});

function guard(role?: string) {
  return role === "operator" || role === "platform_admin";
}

export async function POST(req: Request) {
  const session = await auth();
  if (!guard(session?.user?.role)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const restaurantId = await getActiveRestaurantId();
  if (!restaurantId) {
    return NextResponse.json({ error: "no_restaurant" }, { status: 400 });
  }
  const body = await req.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid" }, { status: 400 });
  }
  await db.restaurant.update({
    where: { id: restaurantId },
    data: { cloudTerminalBusinessCode: parsed.data.businessCode },
  });
  return NextResponse.json({ ok: true });
}
