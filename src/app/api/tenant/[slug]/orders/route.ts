import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { auth } from "@/auth";
import { publishOrderEvent } from "@/lib/events";

const itemSchema = z.object({
  menuItemId: z.string().min(1),
  qty: z.number().int().min(1).max(20),
  selections: z.record(z.string(), z.string()).optional(),
  notes: z.string().max(240).optional(),
});

const createSchema = z.object({
  tableId: z.string().min(1),
  items: z.array(itemSchema).min(1),
  // If omitted, create a new order. Otherwise add a new round to an existing order.
  orderId: z.string().optional(),
  // Display name of the guest sending the round. Shown in the shared bill
  // so every diner at the table can see who ordered what.
  guestName: z.string().trim().min(1).max(40).optional(),
});

function shortCode() {
  const n = Math.floor(1000 + Math.random() * 9000);
  const letters = ["T", "M", "C", "N", "B"][Math.floor(Math.random() * 5)];
  return `${letters}-${n}`;
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;
  const session = await auth();

  const tenant = await db.restaurant.findUnique({ where: { slug } });
  if (!tenant) return NextResponse.json({ error: "unknown tenant" }, { status: 404 });

  const body = await req.json().catch(() => null);
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid payload" }, { status: 400 });
  }

  const table = await db.table.findUnique({ where: { id: parsed.data.tableId } });
  if (!table || table.restaurantId !== tenant.id) {
    return NextResponse.json({ error: "invalid table" }, { status: 400 });
  }

  // Resolve menu items + prices (snapshot at order time)
  const menuIds = Array.from(new Set(parsed.data.items.map((i) => i.menuItemId)));
  const menuItems = await db.menuItem.findMany({
    where: { id: { in: menuIds }, restaurantId: tenant.id },
  });
  const menuById = new Map(menuItems.map((m) => [m.id, m]));
  if (menuById.size !== menuIds.length) {
    return NextResponse.json({ error: "invalid items" }, { status: 400 });
  }

  const result = await db.$transaction(async (tx) => {
    let order = parsed.data.orderId
      ? await tx.order.findUnique({ where: { id: parsed.data.orderId } })
      : null;
    if (order && (order.restaurantId !== tenant.id || order.tableId !== table.id)) {
      throw new Error("order mismatch");
    }
    if (!order) {
      order = await tx.order.create({
        data: {
          restaurantId: tenant.id,
          tableId: table.id,
          customerId: session?.user?.id,
          status: "open",
          shortCode: shortCode(),
        },
      });
    }

    const existingRounds = await tx.round.count({ where: { orderId: order.id } });
    const round = await tx.round.create({
      data: {
        orderId: order.id,
        seq: existingRounds + 1,
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
          modifierSelections: it.selections ?? undefined,
          notes: it.notes,
          guestName: parsed.data.guestName,
        },
      });
    }

    // Recalculate subtotal / total
    const items = await tx.orderItem.findMany({ where: { orderId: order.id } });
    const subtotalCents = items.reduce(
      (s, i) => s + i.priceCentsSnapshot * i.qty,
      0,
    );
    const updated = await tx.order.update({
      where: { id: order.id },
      data: {
        subtotalCents,
        totalCents: subtotalCents, // taxes/tips applied at payment time
        status: order.status === "open" ? "placed" : order.status,
        placedAt: order.placedAt ?? new Date(),
      },
    });
    return { order: updated, round };
  });

  publishOrderEvent(tenant.id, { type: "order.updated", orderId: result.order.id });

  return NextResponse.json({
    orderId: result.order.id,
    shortCode: result.order.shortCode,
    roundSeq: result.round.seq,
  });
}
