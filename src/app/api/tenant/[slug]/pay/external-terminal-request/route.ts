import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { fmtCOP, fmtMiles } from "@/lib/format";
import { publishOrderEvent } from "@/lib/events";
import { validateNewPaymentAmount } from "@/lib/orderTotals";
import { sendPushToMeserosForTable } from "@/lib/push";

/**
 * "Tarjeta con datáfono del comercio" — el comercio cobra con su
 * datáfono físico externo (Bancolombia, Davivienda, etc.), MESAPAY
 * sólo registra el cobro. Crea un Payment pending con
 * method=external_terminal que el mesero aprueba/rechaza desde Salón
 * después de pasar la tarjeta por su POS propio.
 *
 * No hay integración con ningún adquiriente externo — el mesero hace
 * el cobro manualmente. Si el datáfono rechaza, el mesero marca el
 * Payment como declined desde Salón y el outstanding queda intacto
 * para que el diner intente con otro método.
 *
 * Mismo cap server-side que las otras rieles para evitar over-payment.
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

  const order = await db.order.findUnique({
    where: { id: parsed.data.orderId },
  });
  if (!order || order.restaurantId !== tenant.id) {
    return NextResponse.json({ error: "order not found" }, { status: 404 });
  }

  // Cap antes de crear el pending. Excluímos TODOS los pendings
  // (excludePending=true) porque vamos a barrerlos en la tx —
  // "última intención del diner gana", igual que en terminal-request
  // de Kushki. Maneja "cliente cambia de efectivo a datáfono propio"
  // y otros switches de método.
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

  // Tracking de quién lo inicia — útil si es un mesero/operator
  // cobrando desde su PWA para reportes de propinas.
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
    // método. Maneja switches "efectivo → external_terminal",
    // "Kushki → external_terminal", etc. El cap arriba usa
    // excludePending=true para que la operación sea consistente.
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
        method: "external_terminal",
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

  // Reusamos order.terminal_requested para que el ServeBoard pesque
  // ambos tipos de cobro con tarjeta en la misma sección "datáfono".
  // El consumer distingue por payment.method al renderizar.
  publishOrderEvent(tenant.id, {
    type: "order.terminal_requested",
    orderId: order.id,
    paymentId: payment.id,
    // amountCents YA es el TOTAL (food + tip) — sumar tipCents otra
    // vez duplicaba la propina en push/SSE.
    amountCents: parsed.data.amountCents,
  });

  // Push al mesero de la mesa.
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
      tag: `external-terminal-${order.id}`,
      url: "/mesero/salon",
    });
  })().catch((err) => console.error("[push:external_terminal]", err));

  return NextResponse.json({
    paymentId: payment.id,
    pending: true,
  });
}
