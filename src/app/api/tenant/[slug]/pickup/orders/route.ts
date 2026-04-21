import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { auth } from "@/auth";
import { publishOrderEvent } from "@/lib/events";
import { computeEtaMinutes } from "@/lib/pickupEta";
import { welcomeIfFirstTime } from "@/lib/mailer";

const itemSchema = z.object({
  menuItemId: z.string().min(1),
  qty: z.number().int().min(1).max(20),
});

const schema = z.object({
  tableId: z.string().min(1),
  pickupName: z.string().trim().min(1).max(40),
  pickupPhone: z.string().trim().min(6).max(24).optional(),
  method: z.enum(["demo_card", "demo_nequi"]),
  items: z.array(itemSchema).min(1),
});

function shortCode() {
  const n = Math.floor(1000 + Math.random() * 9000);
  const letters = ["P", "R", "K"][Math.floor(Math.random() * 3)];
  return `${letters}-${n}`;
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;
  const tenant = await db.restaurant.findUnique({ where: { slug } });
  if (!tenant || !tenant.pickupEnabled) {
    return NextResponse.json({ error: "not available" }, { status: 404 });
  }

  const body = await req.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid payload" }, { status: 400 });
  }

  const pickupTable = await db.table.findUnique({
    where: { id: parsed.data.tableId },
  });
  if (
    !pickupTable ||
    pickupTable.restaurantId !== tenant.id ||
    pickupTable.number !== -1
  ) {
    return NextResponse.json({ error: "invalid table" }, { status: 400 });
  }

  const menuIds = Array.from(
    new Set(parsed.data.items.map((i) => i.menuItemId)),
  );
  const menuItems = await db.menuItem.findMany({
    where: { id: { in: menuIds }, restaurantId: tenant.id, available: true },
    include: { category: { select: { kind: true } } },
  });
  const menuById = new Map(menuItems.map((m) => [m.id, m]));
  if (menuById.size !== menuIds.length) {
    return NextResponse.json({ error: "invalid items" }, { status: 400 });
  }

  const session = await auth();
  const subtotalCents = parsed.data.items.reduce(
    (s, it) => s + menuById.get(it.menuItemId)!.priceCents * it.qty,
    0,
  );

  // Lock in the ETA at payment approval so the customer sees a stable
  // "ready in ~X min" after they tap pay, even if more orders queue behind.
  const etaMinutes = await computeEtaMinutes(tenant.id, parsed.data.items);
  const now = new Date();
  const readyEta = new Date(now.getTime() + etaMinutes * 60_000);

  const result = await db.$transaction(async (tx) => {
    // Prepaid: the bill is closed at creation (status=paid, paidAt=now) so
    // reports count it. The kitchen still sees it through Round.status, which
    // is what the kitchen board actually queries — not Order.status.
    const order = await tx.order.create({
      data: {
        restaurantId: tenant.id,
        tableId: pickupTable.id,
        customerId: session?.user?.id,
        orderType: "pickup",
        status: "paid",
        shortCode: shortCode(),
        subtotalCents,
        totalCents: subtotalCents,
        etaMinutes,
        readyEta,
        pickupName: parsed.data.pickupName,
        pickupPhone: parsed.data.pickupPhone,
        placedAt: now,
        paidAt: now,
      },
    });

    // Single round — pickup orders are one-shot.
    const round = await tx.round.create({
      data: {
        orderId: order.id,
        seq: 1,
        status: "placed",
      },
    });

    for (const it of parsed.data.items) {
      const mi = menuById.get(it.menuItemId)!;
      await tx.orderItem.create({
        data: {
          orderId: order.id,
          roundId: round.id,
          menuItemId: mi.id,
          qty: it.qty,
          nameSnapshot: mi.name,
          priceCentsSnapshot: mi.priceCents,
          categoryKind: mi.category.kind,
          guestName: parsed.data.pickupName,
        },
      });
    }

    // Demo prepay: approve immediately. demo_nequi rides on wompi_nequi for
    // reporting — same trick the table pay route uses.
    const method =
      parsed.data.method === "demo_nequi" ? "wompi_nequi" : "demo_card";
    await tx.payment.create({
      data: {
        orderId: order.id,
        method,
        status: "approved",
        amountCents: subtotalCents,
        settledAt: now,
      },
    });

    return { order };
  });

  publishOrderEvent(tenant.id, {
    type: "order.updated",
    orderId: result.order.id,
  });

  if (session?.user?.id) {
    welcomeIfFirstTime(session.user.id).catch((err) =>
      console.error("[welcomeIfFirstTime]", err),
    );
  }

  return NextResponse.json({
    orderId: result.order.id,
    shortCode: result.order.shortCode,
    etaMinutes,
  });
}
