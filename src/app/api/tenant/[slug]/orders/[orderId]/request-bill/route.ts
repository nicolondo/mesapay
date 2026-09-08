import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { publishOrderEvent } from "@/lib/events";
import { sendPushToMeserosForTable } from "@/lib/push";

/**
 * "PEDIR LA CUENTA" — acción explícita, distinta del llamado genérico al
 * mesero.
 *
 * Por qué existe: hasta hoy MESAPAY sólo tenía `call-waiter`, un timbre
 * sin motivo. Sirve igual para "traeme servilletas" que para "quiero
 * pagar", así que no se puede usar para disparar el aviso de cobro del
 * administrador sin que suene por cualquier cosa. Esta ruta es la señal
 * inequívoca.
 *
 * Dos orígenes, un mismo endpoint:
 *   - COMENSAL (sin sesión), desde /t/[slug]/order/[orderId].
 *   - MESERO/STAFF (con sesión), desde Salón / Mesas: cuando el comercio
 *     activó "solo el administrador cobra", el mesero ya no ve el botón
 *     de cobrar y en su lugar avisa a caja con un tap.
 *
 * Efectos:
 *   1. Marca Order.needsWaiter + waiterCalledAt. Reusamos los campos que
 *      ya existen para que la mesa quede visible como "atención pendiente"
 *      en Salón y Mesas aunque nadie tenga el panel abierto en ese
 *      instante, y para que walkoutRisk la cuente (una mesa esperando
 *      para pagar ES riesgo de fuga).
 *   2. Publica `order.bill_requested` al bus SSE — el aviso de pantalla
 *      completa del administrador escucha SÓLO este tipo.
 *   3. Push nativo a los meseros de la mesa (el mesero sigue teniendo que
 *      atenderla aunque no cobre).
 *
 * LIMITACIÓN CONOCIDA: el motivo ("pidió la cuenta" vs "llamó al mesero")
 * vive en el evento, no en la base — distinguirlo de forma persistente
 * pide una columna `Order.billRequestedAt`, y este PR tiene el cambio de
 * schema acotado al modelo Restaurant para no chocar con el trabajo en
 * paralelo sobre Order. El aviso del administrador compensa guardando su
 * cola en sessionStorage, así un F5 no se lo come.
 */
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ slug: string; orderId: string }> },
) {
  const { slug, orderId } = await params;
  const tenant = await db.restaurant.findUnique({
    where: { slug },
    select: { id: true },
  });
  if (!tenant) {
    return NextResponse.json({ error: "unknown_tenant" }, { status: 404 });
  }

  const order = await db.order.findUnique({
    where: { id: orderId },
    select: {
      id: true,
      restaurantId: true,
      status: true,
      shortCode: true,
      needsWaiter: true,
      table: { select: { number: true, label: true } },
    },
  });
  if (!order || order.restaurantId !== tenant.id) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  if (order.status === "paid" || order.status === "cancelled") {
    return NextResponse.json({ error: "order_closed" }, { status: 409 });
  }

  // ¿Lo pide el staff o el comensal? Sólo para el copy del aviso — no es
  // un permiso: cualquiera sentado en la mesa puede pedir su cuenta.
  const session = await auth();
  const role = session?.user?.role;
  const source =
    role === "mesero" || role === "operator" || role === "platform_admin"
      ? ("staff" as const)
      : ("diner" as const);

  // needsWaiter idempotente: si la mesa ya tenía una llamada viva no le
  // pisamos el waiterCalledAt (el reloj de espera del Salón tiene que
  // seguir corriendo desde el primer pedido, no reiniciarse con cada tap).
  if (!order.needsWaiter) {
    await db.order.update({
      where: { id: order.id },
      data: { needsWaiter: true, waiterCalledAt: new Date() },
    });
  }

  // El evento SÍ se re-emite aunque ya hubiera llamada viva: si el
  // administrador cerró el aviso y la mesa vuelve a insistir, tiene que
  // volver a sonar.
  publishOrderEvent(tenant.id, {
    type: "order.bill_requested",
    orderId: order.id,
    shortCode: order.shortCode,
    tableNumber: order.table.number,
    tableLabel: order.table.label,
    source,
  });

  // Push a los meseros de la mesa. Fire-and-forget: un servicio de push
  // lento no puede demorar la respuesta al comensal.
  void (async () => {
    // Mesa pseudo de pickup (número < 0) — no hay mesero asignado.
    if (order.table.number < 0) return;
    const where = order.table.label ?? `Mesa ${order.table.number}`;
    await sendPushToMeserosForTable(tenant.id, order.table.number, {
      title: `${where} pidió la cuenta`,
      body: "Toca para abrir Salón",
      tag: `bill-${order.id}`,
      url: "/mesero/salon",
    });
  })().catch((err) => console.error("[push:bill_requested]", err));

  return NextResponse.json({ ok: true });
}
