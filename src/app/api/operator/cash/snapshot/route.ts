import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { getActiveRestaurantId } from "@/lib/activeRestaurant";
import { buildCashSnapshot } from "@/lib/cashBox";
import { resolveShiftPolicy } from "@/lib/staffPolicies";

/** Snapshot de caja en vivo del restaurante activo (operator o admin). */
export async function GET() {
  const session = await auth();
  const role = session?.user?.role;
  if (!session?.user || (role !== "operator" && role !== "platform_admin")) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const restaurantId = await getActiveRestaurantId();
  if (!restaurantId) {
    return NextResponse.json({ error: "no_restaurant" }, { status: 400 });
  }
  const tenant = await db.restaurant.findUnique({
    where: { id: restaurantId },
    select: { shiftPolicy: true },
  });
  const snapshot = await buildCashSnapshot(
    restaurantId,
    resolveShiftPolicy(tenant?.shiftPolicy),
  );
  return NextResponse.json(snapshot);
}
