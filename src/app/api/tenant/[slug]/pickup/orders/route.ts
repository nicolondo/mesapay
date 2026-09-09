import { createHash } from "node:crypto";
import { processKushkiWebhook } from "@/lib/payments/webhookHandler";
import { markPaymentUncertain } from "@/lib/payments/intent";
import { grantGuestAccess } from "@/lib/guestAccess";
import { demoPaymentsAllowed } from "@/lib/payments/validation";
import { secureApi } from "@/lib/secureApi";
import { shortCode } from "@/lib/shortCode";
import { NextResponse } from "next/server";
import { z } from "zod";
import { getLocale } from "next-intl/server";
import { db } from "@/lib/db";
import {
  DEMO_PAYMENTS_DISABLED,
  shouldBlockDemoPayment,
} from "@/lib/demoPayments";
import { getDiner } from "@/lib/dinerSession";
import { getCurrencyForCountry } from "@/lib/billing/countries";
import { publishOrderEvent } from "@/lib/events";
import { computeEtaMinutes } from "@/lib/pickupEta";
import { isAutoReadyStation, resolveStation } from "@/lib/prep";
import {
  computeSelectionsPriceDelta,
  normalizeModifiers,
} from "@/lib/modifiers";
import {
  isWithinEtaCap,
  pickupStatus,
} from "@/lib/pickupAvailability";
import { welcomeIfFirstTime } from "@/lib/mailer";
import {
  getPaymentProvider,
  getRestaurantPrivateKey,
} from "@/lib/payments";
import { getRestaurantKushkiMode } from "@/lib/platformConfig";

const itemSchema = z.object({
  menuItemId: z.string().min(1),
  qty: z.number().int().min(1).max(20),
  selections: z
    .record(z.string(), z.union([z.string(), z.array(z.string())]))
    .optional(),
  notes: z.string().max(240).optional(),
});

const schema = z.object({
  tableId: z.string().min(1),
  pickupName: z.string().trim().min(1).max(40),
  pickupPhone: z.string().trim().min(6).max(32),
  // Pickup is prepay: only "instant" methods make sense. Cash and terminal
  // require a waiter and a physical presence, so we exclude them here. The
  // demo methods stay around for local dev when KUSHKI_MODE=mock.
  method: z.enum([
    "demo_card",
    "demo_nequi",
    "kushki_apple_pay",
  ]),
  // Required when method is kushki_*; ignored for demo methods.
  token: z.string().min(1).max(2000).optional(),
  items: z.array(itemSchema).min(1).max(100),
});



async function POSTHandler(
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

  // Mismo agujero que en /pay, y acá sale más caro: pickup es prepago,
  // así que un demo_card crea la orden ya en `paid` Y la manda a cocina.
  // Sin gate, cualquiera con el link público de recogida pedía comida
  // gratis. Cortamos antes de tocar la DB.
  if (shouldBlockDemoPayment(parsed.data.method)) {
    return NextResponse.json(
      { error: DEMO_PAYMENTS_DISABLED },
      { status: 403 },
    );
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

  // Igual que en /orders: el comensal con sesión EN ESTE COMERCIO, para que
  // el pedido para llevar quede enlazado a su cuenta de acá.
  const diner = await getDiner(tenant.id);
  // Subtotal must factor modifier price deltas too — otherwise the
  // Kushki charge below would undercharge by the value of every
  // "+$5.000 Camarón" the diner added.
  const subtotalCents = parsed.data.items.reduce((s, it) => {
    const mi = menuById.get(it.menuItemId)!;
    const liveMods = normalizeModifiers(mi.modifiers);
    const delta = computeSelectionsPriceDelta(liveMods, it.selections);
    return s + Math.max(0, mi.priceCents + delta) * it.qty;
  }, 0);

  // Gate on hours and capacity before we touch the DB. The client also
  // surfaces these but we cannot trust it — someone can POST straight to
  // this route outside of business hours.
  const status = pickupStatus(tenant.pickupHours);
  if (!status.open) {
    return NextResponse.json(
      {
        error: "closed",
        nextOpenAt: status.nextOpenAt ? status.nextOpenAt.toISOString() : null,
      },
      { status: 409 },
    );
  }

  // Lock in the ETA at payment approval so the customer sees a stable
  // "ready in ~X min" after they tap pay, even if more orders queue behind.
  const etaMinutes = await computeEtaMinutes(tenant.id, parsed.data.items);
  if (!isWithinEtaCap(etaMinutes, tenant.pickupMaxEtaMinutes)) {
    return NextResponse.json(
      {
        error: "saturated",
        etaMinutes,
        maxEtaMinutes: tenant.pickupMaxEtaMinutes,
      },
      { status: 409 },
    );
  }
  const now = new Date();
  const readyEta = new Date(now.getTime() + etaMinutes * 60_000);

  const isKushki = parsed.data.method === "kushki_apple_pay";
  const provider = isKushki ? await getPaymentProvider(await getRestaurantKushkiMode(tenant)) : null;
  const privateKey = isKushki ? await getRestaurantPrivateKey(tenant.id) : null;
  if (isKushki && (!tenant.kushkiMerchantId || !privateKey || !parsed.data.token)) return NextResponse.json({ error: "credentials_missing" }, { status: 409 });
  if (!Number.isSafeInteger(subtotalCents) || subtotalCents <= 0 || subtotalCents > 2_000_000_000) return NextResponse.json({ error: "invalid_amount" }, { status: 400 });
  const requestKey = parsed.data.token ? createHash("sha256").update(`pickup:${tenant.id}:${parsed.data.token}`).digest("hex") : null;

  // Translate to enum values that exist in the schema. demo_nequi is a UI
  // label only — on the books it rides on wompi_nequi until we drop the
  // demo path entirely.
  let paymentMethod:
    | "demo_card"
    | "wompi_nequi"
    | "kushki_apple_pay";
  if (parsed.data.method === "kushki_apple_pay") {
    paymentMethod = "kushki_apple_pay";
  } else if (parsed.data.method === "demo_nequi") {
    paymentMethod = "wompi_nequi";
  } else {
    paymentMethod = "demo_card";
  }

  const result = await db.$transaction(async (tx) => {
    if (requestKey) {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${requestKey}), 735)`;
      const previous = await tx.payment.findUnique({ where: { requestKey }, include: { order: true } });
      if (previous) {
        if (previous.amountCents !== subtotalCents) throw new Error("operation_conflict");
        return { order: previous.order, payment: previous, created: false };
      }
    }
    // Prepaid: the bill is closed at creation (status=paid, paidAt=now) so
    // reports count it. The kitchen still sees it through Round.status, which
    // is what the kitchen board actually queries — not Order.status.
    const order = await tx.order.create({
      data: {
        restaurantId: tenant.id,
        tableId: pickupTable.id,
        dinerId: diner?.id,
        orderType: "pickup",
        status: isKushki ? "paying" : "paid",
        shortCode: shortCode(),
        locale: await getLocale(),
        subtotalCents,
        totalCents: subtotalCents,
        etaMinutes,
        readyEta,
        pickupName: parsed.data.pickupName,
        pickupPhone: parsed.data.pickupPhone,
        placedAt: now,
        paidAt: isKushki ? null : now,
      },
    });

    // Single round — pickup orders are one-shot.
    const round = await tx.round.create({
      data: {
        orderId: order.id,
        seq: 1,
        status: isKushki ? "open" : "placed",
      },
    });

    for (const it of parsed.data.items) {
      const mi = menuById.get(it.menuItemId)!;
      const station = resolveStation(mi.prepStation, mi.category.prepStation);
      const autoReady = isAutoReadyStation(station, tenant.hasBar);
      const barSubStation =
        station === "bar" && tenant.barSubStations.length > 0
          ? (mi.category.barSubStation ?? null)
          : null;
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
          guestName: parsed.data.pickupName,
        },
      });
    }

    // If every item was auto-ready (drinks-only pickup), the round is
    // already done — no kitchen/bar work needed.
    const createdItems = await tx.orderItem.findMany({
      where: { roundId: round.id },
      select: { kitchenStatus: true },
    });
    if (
      !isKushki && createdItems.length > 0 &&
      createdItems.every((i) => i.kitchenStatus === "ready")
    ) {
      await tx.round.update({
        where: { id: round.id },
        data: { status: "ready", readyAt: now },
      });
    }

    const payment = await tx.payment.create({
      data: {
        orderId: order.id,
        method: paymentMethod,
        status: isKushki ? "pending" : "approved",
        amountCents: subtotalCents,
        requestKey,
        settledAt: isKushki ? null : now,
      },
    });

    return { order, payment, created: true };
  });
  await grantGuestAccess({ restaurantId: tenant.id, orderId: result.order.id });
  if (isKushki && result.created && provider && privateKey && parsed.data.token) {
    try {
      const charge = await provider.chargeWithToken({
        merchantId: privateKey, token: parsed.data.token,
        amount: { amountCents: subtotalCents, currency: await getCurrencyForCountry(tenant.country) },
        metadata: { orderId: result.order.id, paymentId: result.payment.id, tableId: pickupTable.id },
      });
      if (charge.status === "pending") {
        await markPaymentUncertain(result.payment.id);
      } else {
        const processed = await processKushkiWebhook({
          eventId: `pickup:${result.payment.id}:${charge.status}`,
          type: charge.status === "approved" ? "charge.approved" : "charge.declined",
          paymentId: result.payment.id, restaurantId: tenant.id,
          providerRef: charge.providerRef, amountCents: subtotalCents, raw: charge.raw,
        });
        if (processed.status === "error") await markPaymentUncertain(result.payment.id);
      }
    } catch { await markPaymentUncertain(result.payment.id); }
  }
  const finalPayment = await db.payment.findUniqueOrThrow({ where: { id: result.payment.id } });
  if (finalPayment.status === "declined") return NextResponse.json({ error: "payment_declined", orderId: result.order.id }, { status: 402 });
  if (finalPayment.status === "pending") return NextResponse.json({ pending: true, orderId: result.order.id, paymentId: result.payment.id }, { status: 202 });

  publishOrderEvent(tenant.id, {
    type: "order.updated",
    orderId: result.order.id,
  });

  // No more arrival-print for bar — pickup tickets print when somebody
  // taps "Empezar" at the station (see operator/order-items PATCH).

  if (diner) {
    welcomeIfFirstTime(diner.id, result.order.locale).catch((err) =>
      console.error("[welcomeIfFirstTime]", err),
    );
  }

  await grantGuestAccess({ restaurantId: tenant.id, orderId: result.order.id });
  return NextResponse.json({
    orderId: result.order.id,
    shortCode: result.order.shortCode,
    etaMinutes,
  });
}

export const POST = secureApi(POSTHandler);
