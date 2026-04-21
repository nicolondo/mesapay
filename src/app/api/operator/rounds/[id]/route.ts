import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { auth } from "@/auth";
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
  if (
    session.user.role === "operator" &&
    round.order.restaurantId !== session.user.restaurantId
  ) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  await db.$transaction(async (tx) => {
    await tx.round.update({
      where: { id: round.id },
      data: {
        status: parsed.data.status,
        readyAt: parsed.data.status === "ready" ? new Date() : null,
      },
    });
    // Bubble aggregate status to order: if any round is in_kitchen, order = in_kitchen.
    // If all rounds are ready, order = ready.
    const rounds = await tx.round.findMany({ where: { orderId: round.orderId } });
    let orderStatus: "placed" | "in_kitchen" | "ready" = "placed";
    if (rounds.some((r) => r.status === "in_kitchen")) orderStatus = "in_kitchen";
    if (rounds.every((r) => r.status === "ready")) orderStatus = "ready";
    await tx.order.update({
      where: { id: round.orderId },
      data: { status: orderStatus },
    });
  });

  publishOrderEvent(round.order.restaurantId, {
    type: parsed.data.status === "ready" ? "order.ready" : "order.updated",
    orderId: round.orderId,
  });

  return NextResponse.json({ ok: true });
}
