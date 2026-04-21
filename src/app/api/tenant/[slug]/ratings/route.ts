import { NextResponse } from "next/server";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { publishOrderEvent } from "@/lib/events";

const schema = z.object({
  orderItemId: z.string().min(1),
  stars: z.number().int().min(1).max(5),
  comment: z.string().trim().max(500).optional(),
  guestName: z.string().trim().max(40).optional(),
});

export async function POST(
  req: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;
  const tenant = await db.restaurant.findUnique({ where: { slug } });
  if (!tenant) return NextResponse.json({ error: "unknown tenant" }, { status: 404 });

  const body = await req.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid payload" }, { status: 400 });
  }

  const item = await db.orderItem.findUnique({
    where: { id: parsed.data.orderItemId },
    include: { order: true },
  });
  if (!item || item.order.restaurantId !== tenant.id) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  // Only let the diner rate once the dish has actually been served.
  if (!item.servedAt) {
    return NextResponse.json({ error: "not served yet" }, { status: 400 });
  }

  try {
    await db.dishRating.create({
      data: {
        restaurantId: tenant.id,
        menuItemId: item.menuItemId,
        orderId: item.orderId,
        orderItemId: item.id,
        stars: parsed.data.stars,
        comment: parsed.data.comment || null,
        guestName: parsed.data.guestName || item.guestName || null,
      },
    });
  } catch (e) {
    if (
      e instanceof Prisma.PrismaClientKnownRequestError &&
      e.code === "P2002"
    ) {
      return NextResponse.json({ error: "already rated" }, { status: 409 });
    }
    throw e;
  }

  publishOrderEvent(tenant.id, {
    type: "order.updated",
    orderId: item.orderId,
  });

  return NextResponse.json({ ok: true });
}
