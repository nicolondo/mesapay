import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { fmtCOP, fmtMiles } from "@/lib/format";
import { publishOrderEvent } from "@/lib/events";
import { validateNewPaymentAmount } from "@/lib/orderTotals";
import { sendPushToMeserosForTable } from "@/lib/push";

/**
 * "Tarjeta con datáfono" — the diner taps this and we create a pending
 * Payment row with method=kushki_card_terminal. The terminal grid surfaces
 * it and a server can push the amount to the actual terminal.
 *
 * No call to Kushki here. That happens when the terminal operator clicks
 * "Cobrar" on the table — see /api/tenant/[slug]/terminal/charge.
 */

const schema = z.object({
  orderId: z.string().min(1),
  amountCents: z.number().int().min(100),
  tipCents: z.number().int().min(0).default(0),
});

export async function POST(
  req: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;
  const tenant = await db.restaurant.findUnique({ where: { slug } });
  if (!tenant) {
    return NextResponse.json({ error: "unknown tenant" }, { status: 404 });
  }

  const body = await req.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid payload" }, { status: 400 });
  }

  const order = await db.order.findUnique({ where: { id: parsed.data.orderId } });
  if (!order || order.restaurantId !== tenant.id) {
    return NextResponse.json({ error: "order not found" }, { status: 404 });
  }

  // Cap before queuing the datáfono push. Excluímos TODOS los
  // pendings (excludePending=true) porque vamos a barrerlos dentro
  // de la transacción al crear el nuevo. Diseño: "última intención
  // del diner gana" — si tocó efectivo y luego cambió a datáfono,
  // el cash pending se cancela y el datáfono toma el lugar.
  //
  // Trade-off conocido: en escenarios de split-bill simultáneo
  // (raro), el segundo diner podría cancelar el pending del
  // primero. Resolverlo correctamente requiere tracking de identidad
  // por diner (cookie/session), que no tenemos hoy. Para el caso
  // 99% (single payer cambia de método) este sweep es lo correcto.
  const foodPortion = parsed.data.amountCents - parsed.data.tipCents;
  const cap = await validateNewPaymentAmount(order.id, foodPortion, {
    excludePending: true,
  });
  if (!cap.ok) {
    return NextResponse.json(
      {
        error: cap.reason,
        outstandingCents: cap.outstandingCents,
        message:
          cap.reason === "order_already_paid"
            ? "Esta cuenta ya fue pagada."
            : `Quedan ${fmtCOP(cap.outstandingCents)} pendientes — intenta de nuevo con un monto menor.`,
      },
      { status: 409 },
    );
  }

  // Quién inicia el cobro vía datáfono. Si lo lanza un mesero/operator
  // desde su PWA, lo registramos para reportes de propinas/turno
  // personal — el webhook que luego aprueba el pago preserva esta
  // referencia (sólo cambia status + settledAt).
  const session = await auth();
  const collectedByUserId =
    session?.user &&
    (session.user.role === "mesero" ||
      session.user.role === "operator" ||
      session.user.role === "platform_admin")
      ? session.user.id
      : null;

  const payment = await db.$transaction(async (tx) => {
    // Sweep de TODOS los pendings de esta orden, no solo del mismo
    // método. Casos típicos:
    //   - Diner tocó "Tarjeta con datáfono", no completó, vuelve a
    //     tocarlo → sweep del datáfono pending viejo
    //   - Diner tocó "Efectivo" y cambia a "Tarjeta con datáfono" →
    //     sweep del cash pending para liberar outstanding
    //   - Diner tocó "Datáfono del comercio" y cambia a Kushki →
    //     sweep del external_terminal pending
    // El cap arriba ya usa excludePending=true para que esta
    // operación sea consistente.
    await tx.payment.updateMany({
      where: {
        orderId: order.id,
        status: "pending",
      },
      data: { status: "declined" },
    });
    const p = await tx.payment.create({
      data: {
        orderId: order.id,
        method: "kushki_card_terminal",
        status: "pending",
        amountCents: parsed.data.amountCents,
        tipCents: parsed.data.tipCents,
        collectedByUserId,
      },
    });
    await tx.order.update({
      where: { id: order.id },
      data: { status: order.status === "paid" ? order.status : "paying" },
    });
    return p;
  });

  publishOrderEvent(tenant.id, {
    type: "order.terminal_requested",
    orderId: order.id,
    paymentId: payment.id,
    // amountCents YA es el TOTAL (food + tip) — sumar tipCents otra
    // vez duplicaba la propina en push/SSE.
    amountCents: parsed.data.amountCents,
  });

  // Native push to meseros assigned to this table.
  void (async () => {
    const table = order.tableId
      ? await db.table.findUnique({
          where: { id: order.tableId },
          select: { number: true, label: true },
        })
      : null;
    if (!table || table.number < 0) return;
    const where = table.label ?? `Mesa ${table.number}`;
    const totalCop = parsed.data.amountCents / 100;
    await sendPushToMeserosForTable(tenant.id, table.number, {
      title: `${where} pidió datáfono`,
      body: `Cobro con tarjeta · ${fmtMiles(totalCop)} COP`,
      tag: `terminal-${order.id}`,
      url: "/mesero/salon",
    });
  })().catch((err) => console.error("[push:terminal]", err));

  return NextResponse.json({
    paymentId: payment.id,
    pending: true,
  });
}
