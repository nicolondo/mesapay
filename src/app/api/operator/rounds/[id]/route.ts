import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { auth } from "@/auth";
import { getActiveRestaurantId } from "@/lib/activeRestaurant";
import { publishOrderEvent } from "@/lib/events";

const schema = z.discriminatedUnion("status", [
  z.object({
    status: z.enum(["placed", "in_kitchen", "ready"]),
  }),
  z.object({
    status: z.literal("cancelled"),
    // Required, but trimmed lazily so a single-space submit fails the
    // min(3) check instead of sneaking through.
    reason: z.string().trim().min(3).max(240),
  }),
]);

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

    if (parsed.data.status === "cancelled") {
      // Cancellation path: stamp who/when/why on the round and pull its
      // items out of every downstream view. We also subtract the cancelled
      // items' value from the order subtotal so the customer's outstanding
      // amount drops in real time — provided the order isn't paid yet.
      const items = await tx.orderItem.findMany({
        where: { roundId: round.id },
      });
      await tx.round.update({
        where: { id: round.id },
        data: {
          status: "cancelled",
          cancelledAt: now,
          cancelledByEmail: session.user.email,
          cancellationReason: parsed.data.reason,
        },
      });
      // Items follow the round into the "cancelled" bucket so the cancelled
      // round can never resurface on the kitchen board even if someone
      // bumps an item directly.
      await tx.orderItem.updateMany({
        where: { roundId: round.id },
        data: { kitchenStatus: "ready", servedAt: null },
      });

      const orderRow = await tx.order.findUnique({
        where: { id: round.orderId },
        select: { status: true, subtotalCents: true, totalCents: true, tipCents: true },
      });
      // Only adjust subtotals on unpaid orders. Once paid, recomputing here
      // would imply a refund we don't model yet — leave the bill alone and
      // let staff handle the refund through the wallet flow.
      if (
        orderRow &&
        orderRow.status !== "paid" &&
        orderRow.status !== "paying"
      ) {
        const cancelledValue = items.reduce(
          (s, i) => s + i.priceCentsSnapshot * i.qty,
          0,
        );
        const newSubtotal = Math.max(0, orderRow.subtotalCents - cancelledValue);
        await tx.order.update({
          where: { id: round.orderId },
          data: {
            subtotalCents: newSubtotal,
            // No payments yet on a non-paying order, so totals match subtotal.
            totalCents: newSubtotal + orderRow.tipCents,
          },
        });
      }
      return;
    }

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
      // Only non-cancelled rounds contribute to the aggregate — a cancelled
      // round shouldn't hold an order at "in_kitchen" forever.
      const rounds = await tx.round.findMany({
        where: { orderId: round.orderId, status: { not: "cancelled" } },
      });
      let orderStatus: "placed" | "in_kitchen" | "ready" = "placed";
      if (rounds.some((r) => r.status === "in_kitchen")) orderStatus = "in_kitchen";
      if (rounds.length > 0 && rounds.every((r) => r.status === "ready"))
        orderStatus = "ready";
      await tx.order.update({
        where: { id: round.orderId },
        data: { status: orderStatus },
      });
    }
  });

  if (parsed.data.status === "cancelled") {
    publishOrderEvent(round.order.restaurantId, {
      type: "order.round_cancelled",
      orderId: round.orderId,
      roundId: round.id,
      reason: parsed.data.reason,
    });
    // Also bump the generic update so any non-specialised subscriber (the
    // mesas grid, the kitchen board) refreshes too.
    publishOrderEvent(round.order.restaurantId, {
      type: "order.updated",
      orderId: round.orderId,
    });
  } else {
    publishOrderEvent(round.order.restaurantId, {
      type: parsed.data.status === "ready" ? "order.ready" : "order.updated",
      orderId: round.orderId,
    });
  }

  return NextResponse.json({ ok: true });
}
