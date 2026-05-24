import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { auth } from "@/auth";
import { getActiveRestaurantId } from "@/lib/activeRestaurant";
import { publishOrderEvent } from "@/lib/events";

const schema = z
  .object({
    served: z.boolean().optional(),
    kitchenStatus: z.enum(["placed", "in_kitchen", "ready"]).optional(),
  })
  .refine((d) => d.served !== undefined || d.kitchenStatus !== undefined, {
    message: "served or kitchenStatus required",
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

  const item = await db.orderItem.findUnique({
    where: { id },
    include: { order: true },
  });
  if (!item) return NextResponse.json({ error: "not found" }, { status: 404 });
  const activeId = await getActiveRestaurantId();
  if (item.order.restaurantId !== activeId) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  let becameRoundReady = false;

  await db.$transaction(async (tx) => {
    const now = new Date();

    if (parsed.data.kitchenStatus !== undefined) {
      await tx.orderItem.update({
        where: { id: item.id },
        data: { kitchenStatus: parsed.data.kitchenStatus },
      });
    }

    if (parsed.data.served !== undefined) {
      await tx.orderItem.update({
        where: { id: item.id },
        data: {
          servedAt: parsed.data.served ? now : null,
          // Serving implies the kitchen finished this one.
          kitchenStatus: parsed.data.served ? "ready" : item.kitchenStatus,
        },
      });
    }

    if (item.roundId) {
      // Derive round.status from the weakest link of its items:
      //  - any placed → placed
      //  - any in_kitchen (none placed) → in_kitchen
      //  - all ready → ready
      const siblings = await tx.orderItem.findMany({
        where: { roundId: item.roundId },
        select: { id: true, kitchenStatus: true, servedAt: true },
      });
      const effective = siblings.map((s) => {
        if (s.id !== item.id) return s.kitchenStatus;
        if (parsed.data.kitchenStatus !== undefined) return parsed.data.kitchenStatus;
        if (parsed.data.served === true) return "ready" as const;
        return s.kitchenStatus;
      });
      let roundStatus: "placed" | "in_kitchen" | "ready" = "ready";
      if (effective.some((s) => s === "placed")) roundStatus = "placed";
      else if (effective.some((s) => s === "in_kitchen")) roundStatus = "in_kitchen";

      const round = await tx.round.findUnique({ where: { id: item.roundId } });
      const roundData: {
        status: typeof roundStatus;
        kitchenStartedAt?: Date;
        readyAt?: Date | null;
      } = { status: roundStatus };
      if (roundStatus === "in_kitchen" && round && !round.kitchenStartedAt) {
        roundData.kitchenStartedAt = now;
      }
      if (roundStatus === "ready" && round && !round.readyAt) {
        roundData.readyAt = now;
        becameRoundReady = true;
      }
      if (roundStatus !== "ready" && round?.readyAt) {
        // Someone pulled an item back from ready — round is no longer done.
        roundData.readyAt = null;
      }
      await tx.round.update({ where: { id: item.roundId }, data: roundData });
    }

    if (parsed.data.served !== undefined && item.roundId) {
      // Bubble served-state up to order (unchanged from earlier behaviour).
      const siblings = await tx.orderItem.findMany({
        where: { roundId: item.roundId },
        select: { id: true, servedAt: true },
      });
      const allServed = siblings.every((i) =>
        i.id === item.id ? parsed.data.served : !!i.servedAt,
      );
      await tx.round.update({
        where: { id: item.roundId },
        data: { status: allServed ? "served" : undefined },
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
            data: { status: "served", servedAt: now },
          });
        }
      } else if (!parsed.data.served && item.order.status === "served") {
        await tx.order.update({
          where: { id: item.order.id },
          data: { status: "ready", servedAt: null },
        });
      }
    }
  });

  publishOrderEvent(item.order.restaurantId, {
    type: becameRoundReady ? "order.ready" : "order.updated",
    orderId: item.orderId,
  });

  // Auto-print on the kitchen station when an item transitions
  // placed → in_kitchen. We fire one event per (roundId, station) pair —
  // the print page coalesces these by roundId so a kitchen with five
  // items in the same round prints a single ticket, not five.
  if (
    parsed.data.kitchenStatus === "in_kitchen" &&
    item.kitchenStatus === "placed" &&
    item.station === "kitchen" &&
    item.roundId
  ) {
    const tenant = await db.restaurant.findUnique({
      where: { id: item.order.restaurantId },
      select: { kitchenPrintEnabled: true },
    });
    if (tenant?.kitchenPrintEnabled) {
      publishOrderEvent(item.order.restaurantId, {
        type: "ticket.printable",
        roundId: item.roundId,
        orderId: item.orderId,
        station: "kitchen",
        barSubStation: null,
      });
    }
  }

  return NextResponse.json({ ok: true });
}
