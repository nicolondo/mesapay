import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { auth } from "@/auth";
import { publishOrderEvent } from "@/lib/events";

const schema = z.object({
  status: z.enum(["served", "cancelled"]),
});

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

  const order = await db.order.findUnique({ where: { id } });
  if (!order) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (
    session.user.role === "operator" &&
    order.restaurantId !== session.user.restaurantId
  ) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  if (order.status === "paid") {
    return NextResponse.json({ error: "order already paid" }, { status: 409 });
  }

  const now = new Date();
  await db.order.update({
    where: { id: order.id },
    data: {
      status: parsed.data.status,
      servedAt: parsed.data.status === "served" ? now : order.servedAt,
    },
  });

  publishOrderEvent(order.restaurantId, {
    type: "order.updated",
    orderId: order.id,
  });

  return NextResponse.json({ ok: true });
}
