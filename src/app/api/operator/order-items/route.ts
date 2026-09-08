import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { getActiveRestaurantId } from "@/lib/activeRestaurant";
import { syncOrderSubtotalFromLiveItems } from "@/lib/orderTotals";
import { publishOrderEvent } from "@/lib/events";
import { recordAuditEvent } from "@/lib/auditLog";
import {
  isValidSalesTaxRate,
  lineTaxOnTopCents,
  MAX_FREE_LINE_QTY,
  MAX_FREE_LINE_TOTAL_CENTS,
  MAX_ORDER_TOTAL_CENTS,
} from "@/lib/salesTax";

/**
 * Agregar una LÍNEA LIBRE a una cuenta: algo que no está en la carta y que
 * igual hay que cobrar y facturar — catering de un evento, alquiler del
 * salón, una consultoría, un bono. Se abre la cuenta, se escribe la línea a
 * mano con su precio y su impuesto, y se cobra como cualquier otra.
 *
 * Una línea libre es un `OrderItem` con `menuItemId: null`: el nombre y el
 * precio ya viajaban en los snapshots, así que no necesita nada del catálogo
 * para facturarse. Su impuesto es EXPLÍCITO y se SUMA ENCIMA del precio
 * digitado, que es como se cotiza un servicio ("$2.400.000 + IVA"); los
 * platos del menú siguen con el impuesto embebido a la tarifa del comercio.
 * Todo ese cálculo ya vive en `salesTax` / `orderTotals` — acá sólo se crea
 * la fila con `taxKind`/`taxPct` y se deja que la función canónica
 * (`syncOrderSubtotalFromLiveItems`) re-derive subtotal, impuesto y total.
 *
 * La línea NO es un plato: nace sin ronda, en estación "counter" y ya
 * servida, así que no cae en el board de cocina (que consulta rondas y
 * filtra por estación), no dispara comanda, no tiene receta y no se califica.
 *
 * Los errores viajan como código (`error`), nunca como texto: MESAPAY es
 * trilingüe y el cliente los traduce.
 */

const bodySchema = z.object({
  orderId: z.string().min(1),
  name: z.string().trim().min(2).max(120),
  qty: z.number().int().min(1).max(MAX_FREE_LINE_QTY),
  unitPriceCents: z.number().int().min(0).max(MAX_FREE_LINE_TOTAL_CENTS),
  taxKind: z.enum(["none", "inc", "iva"]),
  taxPct: z.number().int().min(0).max(100),
  notes: z.string().trim().max(240).optional(),
});

export async function POST(req: Request) {
  const session = await auth();
  const role = session?.user?.role;
  // Mismo allow-list que mover un plato: quien gestiona el salón puede
  // agregar un cargo a la cuenta. Cocina y bar no pintan nada acá.
  if (
    !session?.user ||
    (role !== "operator" && role !== "platform_admin" && role !== "mesero")
  ) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const restaurantId = await getActiveRestaurantId();
  if (!restaurantId) {
    return NextResponse.json({ error: "no_restaurant" }, { status: 400 });
  }

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid" }, { status: 400 });
  }
  const { orderId, name, qty, unitPriceCents, taxKind, taxPct } = parsed.data;

  const order = await db.order.findUnique({
    where: { id: orderId },
    select: {
      id: true,
      restaurantId: true,
      status: true,
      subtotalCents: true,
      taxCents: true,
      tipCents: true,
      table: { select: { number: true } },
    },
  });
  if (!order || order.restaurantId !== restaurantId) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  // Una cuenta cerrada o en cobro no admite cargos nuevos: el comensal ya
  // está viendo (o pagando) un total que dejaría de ser cierto. Mismo criterio
  // que el gate de mover platos.
  if (order.status === "paid" || order.status === "cancelled") {
    return NextResponse.json({ error: "order_closed" }, { status: 409 });
  }
  if (order.status === "paying") {
    return NextResponse.json({ error: "order_paying" }, { status: 409 });
  }

  const tenant = await db.restaurant.findUnique({
    where: { id: restaurantId },
    select: { country: true },
  });
  // La tarifa tiene que ser una de las del país; si no, un cliente viejo (o
  // manipulado) podría facturar un IVA que no existe.
  if (!isValidSalesTaxRate(taxKind, taxPct, tenant?.country)) {
    return NextResponse.json({ error: "invalid_tax_rate" }, { status: 400 });
  }

  const lineCents = unitPriceCents * qty;
  if (lineCents > MAX_FREE_LINE_TOTAL_CENTS) {
    return NextResponse.json({ error: "line_too_large" }, { status: 400 });
  }
  // Los totales de la orden son Int: chequear la línea sola no alcanza,
  // porque lo que desborda es la SUMA. Se proyecta el total resultante contra
  // el techo antes de escribir — pasarse sería un 500 al guardar, no un error
  // de negocio que el mesero pueda entender.
  const lineTaxCents = lineTaxOnTopCents({
    amountCents: lineCents,
    taxKind,
    taxPct,
  });
  const projectedTotal =
    order.subtotalCents +
    order.taxCents +
    order.tipCents +
    lineCents +
    lineTaxCents;
  if (projectedTotal > MAX_ORDER_TOTAL_CENTS) {
    return NextResponse.json({ error: "order_too_large" }, { status: 400 });
  }

  const item = await db.orderItem.create({
    data: {
      orderId: order.id,
      // Sin menuItem: no sale de la carta. Sin ronda: no es un pedido a
      // cocina, y el board de cocina consulta rondas — así ni siquiera puede
      // aparecer allí.
      menuItemId: null,
      roundId: null,
      qty,
      nameSnapshot: name,
      priceCentsSnapshot: unitPriceCents,
      taxKind,
      taxPct,
      notes: parsed.data.notes,
      categoryKind: "other",
      // "counter" + ya servida: nadie tiene que prepararla ni entregarla, así
      // que no debe quedar pendiente en ninguna cola del personal.
      station: "counter",
      kitchenStatus: "ready",
      servedAt: new Date(),
    },
    select: { id: true },
  });

  // Función canónica: re-deriva subtotal + impuesto + total de la orden desde
  // los items vivos. Es la que sabe que el impuesto de las líneas libres se
  // suma encima y el de los platos va embebido.
  const totals = await syncOrderSubtotalFromLiveItems(order.id);

  // Meterle plata a una cuenta es sensible — queda en la bitácora igual que
  // cancelar o mover un plato.
  await recordAuditEvent({
    kind: "order_item.free_line",
    restaurantId,
    target: { type: "order_item", id: item.id },
    summary: `Agregó línea libre ${qty}× ${name} (${taxKind} ${taxPct}%) a ${
      order.table ? `Mesa ${order.table.number}` : "Mostrador"
    }`,
    diff: {
      before: { subtotalCents: order.subtotalCents, taxCents: order.taxCents },
      after: { lineCents, lineTaxCents, totalCents: totals.totalCents },
    },
  });

  publishOrderEvent(restaurantId, { type: "order.updated", orderId: order.id });

  return NextResponse.json({
    ok: true,
    itemId: item.id,
    lineCents,
    lineTaxCents,
    subtotalCents: totals.subtotalCents,
    totalCents: totals.totalCents,
  });
}
