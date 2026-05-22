import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { auth } from "@/auth";
import { publishOrderEvent } from "@/lib/events";
import { computeEtaMinutes } from "@/lib/pickupEta";
import {
  isWithinEtaCap,
  pickupStatus,
} from "@/lib/pickupAvailability";
import { welcomeIfFirstTime } from "@/lib/mailer";
import {
  getPaymentProvider,
  getRestaurantPrivateKey,
} from "@/lib/payments";

const itemSchema = z.object({
  menuItemId: z.string().min(1),
  qty: z.number().int().min(1).max(20),
  selections: z.record(z.string(), z.string()).optional(),
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
    "kushki_google_pay",
  ]),
  // Required when method is kushki_*; ignored for demo methods.
  token: z.string().min(1).max(2000).optional(),
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

  // Kushki path: charge BEFORE creating the order so a declined card doesn't
  // leave food in the kitchen queue. Demo path: stay with the legacy
  // immediate-approval flow so local dev works without onboarding.
  const isKushki =
    parsed.data.method === "kushki_apple_pay" ||
    parsed.data.method === "kushki_google_pay";

  let providerRef: string | null = null;

  if (isKushki) {
    if (!tenant.kushkiMerchantId) {
      return NextResponse.json(
        { error: "tenant_not_onboarded" },
        { status: 409 },
      );
    }
    if (!parsed.data.token) {
      return NextResponse.json(
        { error: "missing_token" },
        { status: 400 },
      );
    }
    const privateKey = await getRestaurantPrivateKey(tenant.id);
    if (!privateKey) {
      return NextResponse.json(
        { error: "credentials_missing" },
        { status: 500 },
      );
    }
    try {
      const charge = await getPaymentProvider().chargeWithToken({
        merchantId: privateKey,
        amount: { amountCents: subtotalCents, currency: "COP" },
        token: parsed.data.token,
        metadata: {
          orderId: "pending", // No order id yet; we annotate later via webhook reconciliation.
          paymentId: "pending",
          tableId: pickupTable.id,
        },
      });
      if (charge.status !== "approved") {
        return NextResponse.json(
          { error: "charge_declined", message: charge.message },
          { status: 402 },
        );
      }
      providerRef = charge.providerRef;
    } catch (err) {
      return NextResponse.json(
        {
          error: "charge_failed",
          message: err instanceof Error ? err.message : "unknown",
        },
        { status: 502 },
      );
    }
  }

  // Translate to enum values that exist in the schema. demo_nequi is a UI
  // label only — on the books it rides on wompi_nequi until we drop the
  // demo path entirely.
  let paymentMethod:
    | "demo_card"
    | "wompi_nequi"
    | "kushki_apple_pay"
    | "kushki_google_pay";
  if (parsed.data.method === "kushki_apple_pay") {
    paymentMethod = "kushki_apple_pay";
  } else if (parsed.data.method === "kushki_google_pay") {
    paymentMethod = "kushki_google_pay";
  } else if (parsed.data.method === "demo_nequi") {
    paymentMethod = "wompi_nequi";
  } else {
    paymentMethod = "demo_card";
  }

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
          modifierSelections: it.selections ?? undefined,
          notes: it.notes,
          guestName: parsed.data.pickupName,
        },
      });
    }

    const payment = await tx.payment.create({
      data: {
        orderId: order.id,
        method: paymentMethod,
        status: "approved",
        amountCents: subtotalCents,
        providerRef,
        settledAt: now,
      },
    });

    if (isKushki && providerRef) {
      await tx.kushkiTransaction.create({
        data: {
          restaurantId: tenant.id,
          paymentId: payment.id,
          kushkiTxId: providerRef,
          kind: "charge",
          status: "approved",
          amountCents: subtotalCents,
          raw: { pickup: true, orderId: order.id },
        },
      });
    }

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
