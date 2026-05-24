import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { getActiveRestaurantId } from "@/lib/activeRestaurant";
import {
  computeOpenShiftMetrics,
  getCurrentShift,
  listOpenOrders,
} from "@/lib/shift";

export const dynamic = "force-dynamic";

export async function GET() {
  const session = await auth();
  if (
    !session?.user ||
    (session.user.role !== "operator" && session.user.role !== "platform_admin")
  ) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const restaurantId = await getActiveRestaurantId();
  if (!restaurantId) {
    return NextResponse.json({ error: "no restaurant" }, { status: 400 });
  }

  const shift = await getCurrentShift(restaurantId);
  if (!shift) {
    return NextResponse.json({ open: false });
  }

  const metrics = await computeOpenShiftMetrics(restaurantId, shift);
  const openOrders = await listOpenOrders(restaurantId, shift.openedAt);

  return NextResponse.json({
    open: true,
    shift: {
      id: shift.id,
      openedAt: shift.openedAt.toISOString(),
      openingCashCents: shift.openingCashCents,
    },
    metrics,
    openOrders: openOrders.map((o) => ({
      id: o.id,
      shortCode: o.shortCode,
      status: o.status,
      subtotalCents: o.subtotalCents,
      totalCents: o.totalCents,
      tableLabel: o.table
        ? o.table.label ?? `Mesa ${o.table.number}`
        : "Para llevar",
    })),
    expectedCashCents: shift.openingCashCents + metrics.cashCents,
  });
}
