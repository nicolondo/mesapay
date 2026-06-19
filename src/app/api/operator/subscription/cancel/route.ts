import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { getActiveRestaurantId } from "@/lib/activeRestaurant";
import { getSubscriptionProvider } from "@/lib/payments/subscription";
import { getRestaurantKushkiMode } from "@/lib/platformConfig";
import { recordAuditEvent } from "@/lib/auditLog";

function guard(role?: string | null) {
  return role === "operator" || role === "platform_admin";
}

export async function POST() {
  const session = await auth();
  if (!guard(session?.user?.role)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const restaurantId = await getActiveRestaurantId();
  if (!restaurantId) {
    return NextResponse.json({ error: "no_restaurant" }, { status: 400 });
  }

  const sub = await db.billingSubscription.findUnique({
    where: { restaurantId },
    include: { restaurant: { select: { kushkiMode: true } } },
  });

  if (!sub || sub.status === "canceled") {
    return NextResponse.json({ error: "no_active_subscription" }, { status: 404 });
  }

  const mode = await getRestaurantKushkiMode(sub.restaurant);
  const provider = await getSubscriptionProvider(mode);

  if (sub.kushkiSubscriptionId) {
    try {
      await provider.cancelSubscription({ subscriptionId: sub.kushkiSubscriptionId });
    } catch (err) {
      console.error("[billing] cancel: cancelSubscription failed", err);
      // No bloqueamos — si Kushki falla (ej: ya cancelada), igual marcamos en DB
    }
  }

  await db.billingSubscription.update({
    where: { restaurantId },
    data: {
      status: "canceled",
      canceledAt: new Date(),
    },
  });

  await recordAuditEvent({
    kind: "subscription.cancel",
    restaurantId,
    target: { type: "billing_subscription", id: sub.kushkiSubscriptionId ?? sub.id },
    summary: `Canceló débito automático (subscriptionId=${sub.kushkiSubscriptionId})`,
  });

  return NextResponse.json({ ok: true });
}
