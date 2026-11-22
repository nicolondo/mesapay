import { NextResponse } from "next/server";
import { getTranslations } from "next-intl/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { secureApi } from "@/lib/secureApi";
import { staffForRestaurant, COLLECTOR_ROLES } from "@/lib/staffAccess";
import { lockOrder } from "@/lib/orderLock";
import { staffTerminalRequestKey } from "@/lib/payments/staffTerminalRequest";

const querySchema = z.object({
  attempt: z.string().uuid(),
  method: z.enum(["kushki_card_terminal", "external_terminal"]),
});

async function status(req: Request, { params }: { params: Promise<{ slug: string; orderId: string }> }) {
  const { slug, orderId } = await params;
  const tenant = await db.restaurant.findUnique({ where: { slug }, select: { id: true } });
  const staff = tenant && await staffForRestaurant(tenant.id, COLLECTOR_ROLES);
  if (!staff || !tenant) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const query = querySchema.safeParse(Object.fromEntries(new URL(req.url).searchParams));
  if (!query.success) return NextResponse.json({ error: "invalid_payload" }, { status: 400 });

  const key = staffTerminalRequestKey(orderId, query.data.method, query.data.attempt);
  const order = await db.order.findFirst({ where: { id: orderId, restaurantId: tenant.id }, select: { id: true } });
  if (!order) return NextResponse.json({ error: "not_found" }, { status: 404 });

  if (req.method === "GET") {
    const attempt = await db.financialOperation.findUnique({ where: { key }, select: { paymentId: true } });
    return NextResponse.json({ paymentId: attempt?.paymentId ?? null });
  }

  // Final lookup after aborting the client POST. Fence an absent request
  // under the writers' lock: even a POST delivered later cannot create it.
  const t = await getTranslations("pay");
  const paymentId = await db.$transaction(async tx => {
    await lockOrder(tx, orderId);
    const attempt = await tx.financialOperation.findUnique({ where: { key }, select: { paymentId: true } });
    if (attempt) return attempt.paymentId;
    const actor = staff.user;
    await tx.auditEvent.upsert({
      where: { id: key }, update: {}, create: {
        id: key, kind: "payment.request_closed_before_creation", restaurantId: tenant.id,
        actorUserId: actor.id, actorRole: actor.role, actorEmail: actor.email ?? "",
        targetType: "order", targetId: orderId, summary: t("terminalNotCharged"),
      },
    });
    return null;
  });
  return NextResponse.json({ paymentId });
}

export const GET = secureApi(status);
export const POST = secureApi(status);
