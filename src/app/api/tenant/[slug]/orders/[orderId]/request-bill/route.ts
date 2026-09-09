import { secureApi } from "@/lib/secureApi";
import { NextResponse } from "next/server";
import { auth } from "@/auth";
import {
  billRequestSourceForRole,
  publishBillRequested,
} from "@/lib/billRequest";
import { db } from "@/lib/db";
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
 * Quién la usa hoy: el MESERO/STAFF (con sesión), desde Salón / Mesas —
 * cuando el comercio activó "solo el administrador cobra" él ya no ve el
 * botón de cobrar y en su lugar avisa a caja con un tap. El comensal ya
 * no tiene un botón aparte: pide la cuenta eligiendo forma de pago en
 * /t/[slug]/pay/[orderId], que emite el mismo evento (ver
 * src/lib/billRequest.ts). La ruta sigue aceptando al comensal sin
 * sesión — pedir la propia cuenta nunca fue un permiso.
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
async function POSTHandler(
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
  const source = billRequestSourceForRole(session?.user?.role);

  // Marca de "atención pendiente" + evento. Sin `method`: pedir la cuenta
  // a secas no dice cómo va a pagar la mesa (eso lo aporta la elección de
  // forma de pago del comensal).
  await publishBillRequested({ tenantId: tenant.id, order, source });

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

export const POST = secureApi(POSTHandler);
