import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { getActiveRestaurantId } from "@/lib/activeRestaurant";
import { getSubscriptionProvider } from "@/lib/payments/subscription";
import { getRestaurantKushkiMode } from "@/lib/platformConfig";
import { recordAuditEvent } from "@/lib/auditLog";

function guard(role?: string | null) {
  return role === "operator" || role === "platform_admin";
}

const bodySchema = z.object({
  token: z.string().min(1),
});

export async function PATCH(req: Request) {
  const session = await auth();
  if (!guard(session?.user?.role)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const restaurantId = await getActiveRestaurantId();
  if (!restaurantId) {
    return NextResponse.json({ error: "no_restaurant" }, { status: 400 });
  }

  const parsed = bodySchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "validation", issues: parsed.error.issues }, { status: 422 });
  }
  const { token } = parsed.data;

  const sub = await db.billingSubscription.findUnique({
    where: { restaurantId },
    include: { restaurant: { select: { kushkiMode: true } } },
  });

  if (!sub || sub.status === "canceled" || !sub.kushkiSubscriptionId) {
    return NextResponse.json({ error: "no_active_subscription" }, { status: 404 });
  }

  const mode = await getRestaurantKushkiMode(sub.restaurant);
  const provider = await getSubscriptionProvider(mode);

  let result: Awaited<ReturnType<typeof provider.updateSubscriptionCard>>;
  try {
    result = await provider.updateSubscriptionCard({
      subscriptionId: sub.kushkiSubscriptionId,
      token,
    });
  } catch (err) {
    console.error("[billing] card update: updateSubscriptionCard failed", err);
    return NextResponse.json({ error: "update_failed" }, { status: 502 });
  }

  const { card } = result;
  await db.billingSubscription.update({
    where: { restaurantId },
    data: {
      cardBrand: card.brand,
      cardLast4: card.last4,
      cardExpMonth: card.expMonth,
      cardExpYear: card.expYear,
    },
  });

  await recordAuditEvent({
    kind: "subscription.card.update",
    restaurantId,
    target: { type: "billing_subscription", id: sub.kushkiSubscriptionId },
    summary: `Actualizó tarjeta de débito last4=${card.last4} brand=${card.brand}`,
  });

  return NextResponse.json({ ok: true, card });
}
