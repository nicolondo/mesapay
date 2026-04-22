import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { auth } from "@/auth";
import { getActiveRestaurantId } from "@/lib/activeRestaurant";
import { publishOrderEvent } from "@/lib/events";

const schema = z.object({
  status: z.enum(["placed", "in_kitchen", "ready"]),
});

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session?.user || (session.user.role !== "operator" && session.user.role !== "platform_admin")) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const body = await req.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "invalid" }, { status: 400 });

  const round = await db.round.findUnique({
    where: { id },
    include: { order: true },
  });
  if (!round) return NextResponse.json({ error: "not found" }, { status: 404 });
  const activeId = await getActiveRestaurantId();
  if (round.order.restaurantId !== activeId) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  await db.$transaction(async (tx) => {
    const now = new Date();
    const data: {
      status: "placed" | "in_kitchen" | "ready";
      readyAt: Date | null;
      kitchenStartedAt?: Date;
    } = {
      status: parsed.data.status,
      readyAt: parsed.data.status === "ready" ? now : null,
    };
    // First time moving into the kitchen: stamp the start so ETAs can subtract
    // elapsed cook time. Re-entering from "ready" keeps the original stamp.
    if (parsed.data.status === "in_kitchen" && !round.kitchenStartedAt) {
      data.kitchenStartedAt = now;
    }
    await tx.round.update({
      where: { id: round.id },
      data,
    });
    // Cascade to all items in the round. The per-item state is the source of
    // truth for the kitchen board; this keeps the bulk "Empezar todo" /
    // "Marcar todo listo" buttons working.
    await tx.orderItem.updateMany({
      where: { roundId: round.id },
      data: { kitchenStatus: parsed.data.status },
    });
    // Bubble aggregate status to order: if any round is in_kitchen, order = in_kitchen.
    // If all rounds are ready, order = ready. Don't clobber an already-paid
    // order — counter-mode is prepay so the order hits "paid" before the
    // kitchen starts, and we'd otherwise lose the paid flag on every flip.
    const currentOrder = await tx.order.findUnique({
      where: { id: round.orderId },
      select: { status: true },
    });
    if (
      currentOrder &&
      currentOrder.status !== "paid" &&
      currentOrder.status !== "paying"
    ) {
      const rounds = await tx.round.findMany({ where: { orderId: round.orderId } });
      let orderStatus: "placed" | "in_kitchen" | "ready" = "placed";
      if (rounds.some((r) => r.status === "in_kitchen")) orderStatus = "in_kitchen";
      if (rounds.every((r) => r.status === "ready")) orderStatus = "ready";
      await tx.order.update({
        where: { id: round.orderId },
        data: { status: orderStatus },
      });
    }
  });

  publishOrderEvent(round.order.restaurantId, {
    type: parsed.data.status === "ready" ? "order.ready" : "order.updated",
    orderId: round.orderId,
  });

  return NextResponse.json({ ok: true });
}
