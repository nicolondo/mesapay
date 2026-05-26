import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { publishOrderEvent } from "@/lib/events";
import { sendPushToMeserosForTable } from "@/lib/push";

/**
 * Endpoint unificado para "llamar al mesero" desde el lado del
 * cliente. Funciona con o sin orden activa:
 *
 *   - Si hay orden abierta en la mesa: setea Order.needsWaiter +
 *     Order.waiterCalledAt (mismo flow que el viejo endpoint
 *     /orders/[orderId]/call-waiter).
 *   - Si NO hay orden abierta (cliente recién escaneó el QR y
 *     todavía no pidió nada): setea Table.waiterCalledAt y limpia
 *     waiterAckedAt para que el Salón lo surface como llamada
 *     pendiente.
 *
 * En ambos casos publica el evento al SSE bus + manda push web a
 * los meseros asignados a esa mesa.
 *
 * Validación: tenant slug + qrToken tienen que coincidir. Sin
 * auth (el cliente está en el QR público).
 */
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ slug: string; qrToken: string }> },
) {
  const { slug, qrToken } = await params;
  const tenant = await db.restaurant.findUnique({ where: { slug } });
  if (!tenant) {
    return NextResponse.json({ error: "unknown_tenant" }, { status: 404 });
  }

  const table = await db.table.findUnique({
    where: { qrToken },
    select: {
      id: true,
      restaurantId: true,
      number: true,
      label: true,
      waiterCalledAt: true,
      waiterAckedAt: true,
    },
  });
  if (!table || table.restaurantId !== tenant.id) {
    return NextResponse.json({ error: "unknown_table" }, { status: 404 });
  }

  // Si hay una orden activa en la mesa, preferimos atarcar la
  // llamada al Order (mismo flow que el endpoint legacy) para que
  // los meseros vean el shortCode en el Salón. Si no, la marcamos
  // a nivel de Table.
  const activeOrder = await db.order.findFirst({
    where: {
      tableId: table.id,
      restaurantId: tenant.id,
      status: { notIn: ["paid", "cancelled"] },
    },
    select: { id: true, needsWaiter: true },
    orderBy: { createdAt: "desc" },
  });

  if (activeOrder) {
    if (!activeOrder.needsWaiter) {
      await db.order.update({
        where: { id: activeOrder.id },
        data: { needsWaiter: true, waiterCalledAt: new Date() },
      });
    }
    publishOrderEvent(tenant.id, {
      type: "order.waiter_called",
      orderId: activeOrder.id,
    });
    void notifyMeseros(tenant.id, table, activeOrder.id);
    return NextResponse.json({
      ok: true,
      level: "order",
      orderId: activeOrder.id,
      alreadyCalled: activeOrder.needsWaiter,
    });
  }

  // Pre-orden: persistimos en la mesa misma.
  const now = new Date();
  const alreadyPending =
    table.waiterCalledAt != null &&
    (!table.waiterAckedAt ||
      table.waiterAckedAt.getTime() < table.waiterCalledAt.getTime());

  if (!alreadyPending) {
    await db.table.update({
      where: { id: table.id },
      data: { waiterCalledAt: now, waiterAckedAt: null },
    });
  }

  // Reusamos el mismo event-type para que el Salón refresque igual.
  // No hay orderId — el listener del cliente solo dispara
  // router.refresh() y los datos nuevos vienen del server.
  publishOrderEvent(tenant.id, {
    type: "order.waiter_called",
    orderId: `table:${table.id}`,
  });
  void notifyMeseros(tenant.id, table, null);

  return NextResponse.json({
    ok: true,
    level: "table",
    alreadyCalled: alreadyPending,
  });
}

async function notifyMeseros(
  restaurantId: string,
  table: { number: number; label: string | null },
  orderId: string | null,
) {
  try {
    // Pickup pseudo-tables son número < 0 — no notificamos meseros,
    // los pickups van al operador.
    if (table.number < 0) return;
    const where = table.label ?? `Mesa ${table.number}`;
    await sendPushToMeserosForTable(restaurantId, table.number, {
      title: `${where} llama al mesero`,
      body: orderId ? "Toca para abrir Salón" : "Sin pedido — solo quiere atención",
      tag: orderId ? `waiter-${orderId}` : `waiter-table-${table.number}`,
      url: "/mesero/salon",
    });
  } catch (err) {
    console.error("[push:waiter-by-table]", err);
  }
}
