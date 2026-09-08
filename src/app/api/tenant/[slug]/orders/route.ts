import { NextResponse } from "next/server";
import { z } from "zod";
import { getLocale } from "next-intl/server";
import { db } from "@/lib/db";
import { getDiner } from "@/lib/dinerSession";
import { publishOrderEvent } from "@/lib/events";
import { isAutoReadyStation, resolveStation } from "@/lib/prep";
import {
  computeSelectionsPriceDelta,
  normalizeModifiers,
} from "@/lib/modifiers";
import {
  computeDiscountCents,
  getActiveDiscountPct,
} from "@/lib/dinerDiscount";

const itemSchema = z.object({
  menuItemId: z.string().min(1),
  qty: z.number().int().min(1).max(20),
  // A radio modifier's value is the chosen option label (string).
  // A checkbox modifier's value is an array of zero or more labels.
  // The server validates types and ignores unknown options.
  selections: z
    .record(z.string(), z.union([z.string(), z.array(z.string())]))
    .optional(),
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
  // Serving preference. Only honoured on the first round (when the order is
  // created); subsequent rounds inherit the existing order's mode.
  servingMode: z.enum(["asReady", "together"]).optional(),
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

  const tenant = await db.restaurant.findUnique({ where: { slug } });
  if (!tenant) return NextResponse.json({ error: "unknown tenant" }, { status: 404 });

  // Comensal con sesión EN ESTE COMERCIO. El tenant se resuelve primero a
  // propósito: la identidad del comensal no existe fuera de un restaurante.
  // Antes esto era `getViewer()`, que caía al JWT de NextAuth y terminaba
  // enlazando la cuenta al mesero o al platform_admin que había abierto la
  // carta con su propia sesión — en producción la mayoría de las órdenes
  // "con comensal" eran justamente eso.
  const diner = await getDiner(tenant.id);

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
    include: {
      category: {
        select: { kind: true, prepStation: true, barSubStation: true },
      },
    },
  });
  const menuById = new Map(menuItems.map((m) => [m.id, m]));
  if (menuById.size !== menuIds.length) {
    return NextResponse.json({ error: "invalid items" }, { status: 400 });
  }

  // Descuento del comensal identificado. Se resuelve fuera de la
  // transacción (es una lectura) y se aplica adentro. El descuento cuelga
  // del comensal, y el comensal de un solo comercio: el pactado en otro
  // local no llega hasta acá ni por accidente.
  const dinerDiscountPct = diner ? await getActiveDiscountPct(diner.id) : null;

  const result = await db.$transaction(async (tx) => {
    let order = parsed.data.orderId
      ? await tx.order.findUnique({ where: { id: parsed.data.orderId } })
      : null;
    if (order && (order.restaurantId !== tenant.id || order.tableId !== table.id)) {
      throw new Error("order mismatch");
    }
    if (!order) {
      // Counter-mode tenants (food trucks, mostrador) have no
      // mains-together flow — force "asReady" regardless of what the
      // client sends, since the picker is hidden there.
      const servingMode =
        tenant.serviceMode === "counter"
          ? "asReady"
          : parsed.data.servingMode ?? "asReady";
      order = await tx.order.create({
        data: {
          restaurantId: tenant.id,
          tableId: table.id,
          dinerId: diner?.id,
          status: "open",
          shortCode: shortCode(),
          servingMode,
          locale: await getLocale(),
          // Snapshot del porcentaje pactado al abrir la cuenta. El valor en
          // pesos se calcula abajo, cuando ya se conoce el subtotal.
          discountPct: dinerDiscountPct,
        },
      });
    }

    const existingRounds = await tx.round.count({ where: { orderId: order.id } });
    // Counter-mode tenants (food trucks, mostrador) are prepay — the round is
    // created in "open" state so the kitchen board (which filters on
    // placed/in_kitchen/ready) doesn't pick it up until the payment approval
    // path flips it to "placed".
    const isCounter = tenant.serviceMode === "counter";
    const round = await tx.round.create({
      data: {
        orderId: order.id,
        seq: existingRounds + 1,
        status: isCounter ? "open" : "placed",
      },
    });

    for (const it of parsed.data.items) {
      const mi = menuById.get(it.menuItemId)!;
      const station = resolveStation(mi.prepStation, mi.category.prepStation);
      // Counter items (and bar items when the restaurant has no dedicated
      // bartender) skip the prep stage entirely — they're already ready
      // the moment the round is sent. The waiter sees them in their serve
      // list with the appropriate "Refri / Bar" pill.
      const autoReady = isAutoReadyStation(station, tenant.hasBar);
      // Snapshot the bar sub-station (e.g. "Cocteles") so the bar board
      // can filter tabs without re-resolving. Only meaningful for bar
      // items in a restaurant that defined sub-stations.
      const barSubStation =
        station === "bar" && tenant.barSubStations.length > 0
          ? (mi.category.barSubStation ?? null)
          : null;
      // Effective price = base + sum of selected modifier deltas. We
      // recompute server-side so a tampered cart can't undercharge.
      const liveMods = normalizeModifiers(mi.modifiers);
      const delta = computeSelectionsPriceDelta(liveMods, it.selections);
      const effectivePrice = Math.max(0, mi.priceCents + delta);
      await tx.orderItem.create({
        data: {
          orderId: order.id,
          roundId: round.id,
          menuItemId: mi.id,
          qty: it.qty,
          nameSnapshot: mi.name,
          priceCentsSnapshot: effectivePrice,
          categoryKind: mi.category.kind,
          station,
          barSubStation,
          prepMinutesSnapshot: mi.prepMinutes,
          kitchenStatus: autoReady ? "ready" : "placed",
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

    // If every item in this round was auto-ready (counter / bar-without-
    // bartender), the round is already done — no station ever has to
    // touch it. Mark it ready right now so the waiter sees it in their
    // serve queue without anyone having to click "listo".
    const roundItems = items.filter((i) => i.roundId === round.id);
    if (
      !isCounter &&
      roundItems.length > 0 &&
      roundItems.every((i) => i.kitchenStatus === "ready")
    ) {
      await tx.round.update({
        where: { id: round.id },
        data: { status: "ready", readyAt: new Date() },
      });
    }
    // El descuento sigue al subtotal: si el comensal manda otra ronda, el
    // porcentaje pactado se re-aplica sobre la cuenta completa.
    const discountCents = computeDiscountCents(
      subtotalCents,
      order.discountPct,
    );
    const updated = await tx.order.update({
      where: { id: order.id },
      data: {
        subtotalCents,
        discountCents,
        totalCents: Math.max(0, subtotalCents - discountCents), // taxes/tips applied at payment time
        // Counter-mode orders stay "open" until the payment path marks them
        // paid — they must not reach the kitchen before cash hits the till.
        status: isCounter
          ? order.status
          : order.status === "open"
            ? "placed"
            : order.status,
        placedAt: isCounter ? order.placedAt : (order.placedAt ?? new Date()),
      },
    });
    return { order: updated, round, roundItems };
  });

  publishOrderEvent(tenant.id, { type: "order.updated", orderId: result.order.id });

  // Printing now fires on placed → in_kitchen for both stations (see
  // operator/order-items PATCH route). At round-arrival we only update
  // the boards; no ticket prints until someone clicks "Empezar".

  return NextResponse.json({
    orderId: result.order.id,
    shortCode: result.order.shortCode,
    roundSeq: result.round.seq,
  });
}
