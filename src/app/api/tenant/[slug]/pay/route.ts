import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { publishOrderEvent } from "@/lib/events";
import { welcomeIfFirstTime } from "@/lib/mailer";
import { activateOpenRounds } from "@/lib/prepaidRounds";
import {
  recomputeOrderTotalsInTx,
  validateNewPaymentAmount,
} from "@/lib/orderTotals";
import { sendPushToMeserosForTable } from "@/lib/push";

const schema = z.object({
  orderId: z.string().min(1),
  method: z.enum(["demo_card", "demo_cash", "demo_nequi"]),
  amountCents: z.number().int().min(100),
  tipCents: z.number().int().min(0).default(0),
  // Only meaningful for demo_cash. Ignored otherwise.
  cashTenderCents: z.number().int().min(0).max(10_000_000_000).optional(),
  // The vuelto the mesero physically handed back. Only meaningful when
  // settleNow + demo_cash + cashTenderCents are all set. Lets us
  // record the keep-the-change tip in a single round-trip when the
  // operator initiates the cobro (diner says "quédate con todo" /
  // "con $2k" and we capture both numbers right there).
  changeGivenCents: z.number().int().min(0).max(10_000_000_000).optional(),
  // When the operator/mesero is the one collecting (waiter mode),
  // there's no point creating a pending demo_cash payment that the
  // SAME person will then settle from Salón one second later. With
  // settleNow=true we skip the pending step entirely and write the
  // payment as approved straight away — but only when the request is
  // actually coming from an operator/mesero session. A diner who
  // somehow forges this flag still falls back to the pending flow.
  settleNow: z.boolean().optional(),
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

  const order = await db.order.findUnique({ where: { id: parsed.data.orderId } });
  if (!order || order.restaurantId !== tenant.id) {
    return NextResponse.json({ error: "order not found" }, { status: 404 });
  }

  // Server-side cap: never accept a payment whose food portion would
  // push the bill over the subtotal. Same guardrail in the kushki and
  // terminal routes — see src/lib/orderTotals.ts.
  //
  // For the operator-mode cash settle path we exclude pending demo_cash
  // from the cap: the operator IS the canonical settler and we'll
  // dismiss any stale pending in the transaction below. Counting them
  // here was producing false "amount_exceeds_outstanding" rejections
  // for legit cobros (e.g. diner had tapped "llamar al mesero" earlier,
  // creating a pending, and then the operator tried to close the bill
  // themselves).
  const foodPortion = parsed.data.amountCents - parsed.data.tipCents;
  const willOperatorSettle =
    parsed.data.settleNow === true && parsed.data.method === "demo_cash";
  const cap = await validateNewPaymentAmount(order.id, foodPortion, {
    excludePending: willOperatorSettle,
  });
  if (!cap.ok) {
    return NextResponse.json(
      {
        error: cap.reason,
        outstandingCents: cap.outstandingCents,
        message:
          cap.reason === "order_already_paid"
            ? "Esta cuenta ya fue pagada."
            : `Quedan $${(cap.outstandingCents / 100).toLocaleString("es-CO")} pendientes — intenta de nuevo con un monto menor.`,
      },
      { status: 409 },
    );
  }

  // Cash path. By default the payment stays PENDING — the diner pushed
  // the "Llamar al mesero" button and we need someone with cash in hand
  // to physically deliver it before we mark anything paid. Order moves
  // to "paying" so it shows up as a pending collection in Salón.
  //
  // Exception: operator/mesero session with settleNow=true. They're the
  // ones who'd "settle" the pending payment one second later anyway —
  // we collapse the two clicks into one and write the payment as
  // approved directly. Diners can't trigger this branch (we verify
  // session.user.role server-side, never trust the flag alone).
  if (parsed.data.method === "demo_cash") {
    const session = parsed.data.settleNow ? await auth() : null;
    const operatorSettling =
      parsed.data.settleNow === true &&
      !!session?.user &&
      (session.user.role === "operator" ||
        session.user.role === "mesero" ||
        session.user.role === "platform_admin");

    if (operatorSettling) {
      // Keep-the-change math. When the mesero hands us both the
      // tender ($ recibido del cliente) and the change ($ devuelta
      // dada), the diner's "leftover" — tender minus change minus
      // the expected bill — is the keep-the-change propina.
      //
      // Example: bill $43.000 with $3.000 propina seleccionada
      //   tender = $50.000, change = $5.000
      //   netReceived = $45.000
      //   extraTip = $45.000 - $43.000 = $2.000 (cliente dejó vuelto)
      //   final amountCents = $45.000
      //   final tipCents = $3.000 + $2.000 = $5.000
      //
      // If only tender is provided (no change number), we assume the
      // mesero gave exact change and the keep-the-change is zero.
      const baseAmount = parsed.data.amountCents;
      const baseTip = parsed.data.tipCents;
      let finalAmount = baseAmount;
      let finalTip = baseTip;
      const tender = parsed.data.cashTenderCents;
      const change = parsed.data.changeGivenCents;
      if (tender != null && change != null) {
        const netReceived = tender - change;
        if (netReceived < baseAmount) {
          return NextResponse.json(
            { error: "Recibido neto menor al monto a cobrar." },
            { status: 400 },
          );
        }
        if (change > tender) {
          return NextResponse.json(
            { error: "La devuelta no puede ser mayor a lo recibido." },
            { status: 400 },
          );
        }
        const extraTip = netReceived - baseAmount;
        finalAmount = netReceived;
        finalTip = baseTip + extraTip;
      }

      const result = await db.$transaction(async (tx) => {
        // Sweep stale pending demo_cash payments for this order. They
        // typically come from a diner who tapped "llamar al mesero"
        // earlier — by the time the operator settles directly, that
        // intent is being overridden by THIS payment, and leaving the
        // pending row alive would double-collect on the order. We
        // mark them declined (not deleted) so they stay in the
        // history for audit.
        await tx.payment.updateMany({
          where: {
            orderId: order.id,
            method: "demo_cash",
            status: "pending",
          },
          data: { status: "declined" },
        });

        const payment = await tx.payment.create({
          data: {
            orderId: order.id,
            method: "demo_cash",
            status: "approved",
            amountCents: finalAmount,
            tipCents: finalTip,
            cashTenderCents: tender ?? null,
            settledAt: new Date(),
            // Tracking de quién cobró físicamente. Se usa por la vista
            // "Yo" del mesero y por reportes de propinas. Lo
            // guardamos siempre que se cobra desde sesión staff,
            // independiente de tipPolicy.
            collectedByUserId: session!.user.id,
          },
        });
        const totals = await recomputeOrderTotalsInTx(tx, order.id);
        if (totals.fullyPaid) {
          await activateOpenRounds(tx, order.id);
        }
        return { payment, fullyPaid: totals.fullyPaid };
      });

      publishOrderEvent(tenant.id, {
        type: result.fullyPaid ? "order.paid" : "order.updated",
        orderId: order.id,
      });
      if (result.fullyPaid && order.customerId) {
        welcomeIfFirstTime(order.customerId).catch((err) =>
          console.error("[welcomeIfFirstTime]", err),
        );
      }
      return NextResponse.json({
        paymentId: result.payment.id,
        paid: result.fullyPaid,
        // Explicitly NOT pending — lets the client skip the cash-wait
        // screen and bounce back to /operator/tables.
        pending: false,
      });
    }

    const payment = await db.$transaction(async (tx) => {
      const p = await tx.payment.create({
        data: {
          orderId: order.id,
          method: "demo_cash",
          status: "pending",
          amountCents: parsed.data.amountCents,
          tipCents: parsed.data.tipCents,
          // Optional diner-declared tender so the waiter brings change ready.
          cashTenderCents:
            parsed.data.cashTenderCents != null
              ? parsed.data.cashTenderCents
              : null,
        },
      });
      await tx.order.update({
        where: { id: order.id },
        data: {
          status: order.status === "paid" ? order.status : "paying",
        },
      });
      return p;
    });

    publishOrderEvent(tenant.id, {
      type: "order.cash_requested",
      orderId: order.id,
      paymentId: payment.id,
    });

    // Native push to meseros assigned to this table. Fire-and-forget
    // so a slow push service doesn't delay the diner's response.
    void (async () => {
      const table = order.tableId
        ? await db.table.findUnique({
            where: { id: order.tableId },
            select: { number: true, label: true },
          })
        : null;
      if (!table || table.number < 0) return; // pickup pseudo-table
      const where = table.label ?? `Mesa ${table.number}`;
      await sendPushToMeserosForTable(tenant.id, table.number, {
        title: `${where} pidió cobrar`,
        body: `Pago en efectivo · ${(parsed.data.amountCents / 100).toLocaleString("es-CO")} COP`,
        tag: `cash-${order.id}`,
        url: "/mesero/salon",
      });
    })().catch((err) => console.error("[push:cash]", err));

    return NextResponse.json({
      paymentId: payment.id,
      paid: false,
      pending: true,
    });
  }

  // Demo: approve immediately. demo_nequi rides on wompi_nequi until we wire
  // real Wompi — keeps reports honest about which rail the diner picked.
  const method = parsed.data.method === "demo_nequi" ? "wompi_nequi" : parsed.data.method;

  const result = await db.$transaction(async (tx) => {
    const payment = await tx.payment.create({
      data: {
        orderId: order.id,
        method,
        status: "approved",
        amountCents: parsed.data.amountCents,
        tipCents: parsed.data.tipCents,
        settledAt: new Date(),
      },
    });
    // Tips are per-payment: each diner picks their own on their own share.
    // recomputeOrderTotalsInTx aggregates across approved payments and
    // flips the order to "paid" iff the food portion covers the subtotal.
    const totals = await recomputeOrderTotalsInTx(tx, order.id);
    // Counter-mode prepay: release any open rounds to the kitchen now that
    // the money is in.
    if (totals.fullyPaid) {
      await activateOpenRounds(tx, order.id);
    }
    return { payment, fullyPaid: totals.fullyPaid };
  });

  publishOrderEvent(tenant.id, {
    type: result.fullyPaid ? "order.paid" : "order.updated",
    orderId: order.id,
  });

  if (result.fullyPaid && order.customerId) {
    welcomeIfFirstTime(order.customerId).catch((err) =>
      console.error("[welcomeIfFirstTime]", err),
    );
  }

  return NextResponse.json({
    paymentId: result.payment.id,
    paid: result.fullyPaid,
  });
}
