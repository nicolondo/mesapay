import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { auth } from "@/auth";
import { publishOrderEvent } from "@/lib/events";

const schema = z.object({ served: z.boolean() });

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (
    !session?.user ||
    (session.user.role !== "operator" && session.user.role !== "platform_admin")
  ) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const body = await req.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid" }, { status: 400 });
  }

  const item = await db.orderItem.findUnique({
    where: { id },
    include: { order: true },
  });
  if (!item) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (
    session.user.role === "operator" &&
    item.order.restaurantId !== session.user.restaurantId
  ) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  await db.$transaction(async (tx) => {
    await tx.orderItem.update({
      where: { id: item.id },
      data: { servedAt: parsed.data.served ? new Date() : null },
    });

    if (!item.roundId) return;

    // If every item in the round is now served, bubble the round up to "served".
    // If every round in the order is served, bubble the order up too.
    const siblings = await tx.orderItem.findMany({
      where: { roundId: item.roundId },
      select: { id: true, servedAt: true },
    });
    const allServed = siblings.every((i) =>
      i.id === item.id ? parsed.data.served : !!i.servedAt,
    );
    const roundStatus = allServed ? "served" : "ready";
    await tx.round.update({
      where: { id: item.roundId },
      data: { status: roundStatus },
    });

    if (allServed) {
      const rounds = await tx.round.findMany({
        where: { orderId: item.order.id },
        select: { id: true, status: true },
      });
      const allRoundsServed = rounds.every((r) =>
        r.id === item.roundId ? true : r.status === "served",
      );
      if (allRoundsServed && item.order.status !== "paid") {
        await tx.order.update({
          where: { id: item.order.id },
          data: { status: "served", servedAt: new Date() },
        });
      }
    } else if (!parsed.data.served && item.order.status === "served") {
      // Un-serving an item pulls the order back to "ready".
      await tx.order.update({
        where: { id: item.order.id },
        data: { status: "ready", servedAt: null },
      });
    }
  });

  publishOrderEvent(item.order.restaurantId, {
    type: "order.updated",
    orderId: item.orderId,
  });

  return NextResponse.json({ ok: true });
}
