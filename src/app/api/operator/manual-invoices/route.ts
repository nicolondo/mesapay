import { secureApi } from "@/lib/secureApi";
import { NextResponse } from "next/server";
import { getLocale } from "next-intl/server";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { getActiveRestaurantId } from "@/lib/activeRestaurant";
import { publishOrderEvent } from "@/lib/events";
import { recordAuditEvent } from "@/lib/auditLog";
import { openManualInvoiceInTx } from "@/lib/manualInvoice";

/**
 * Abrir una FACTURA MANUAL: una cuenta que no está en ninguna mesa física,
 * para cobrar (y facturar) platos, cargos o servicios que no salieron de un
 * pedido de salón. Reutiliza una mesa oculta `kind = manual` sin orden
 * abierta o crea una nueva, y deja una `Order` vacía sobre ella; el resto
 * (agregar platos, líneas libres, cobrar) son los caminos de siempre. Ver
 * src/lib/manualInvoice.ts.
 *
 * Sólo caja: operador (o quien lo impersona). El mesero no abre ni ve
 * facturas manuales — su trabajo es el salón.
 *
 * Los errores viajan como código (`error`), nunca como texto: MESAPAY es
 * trilingüe y el cliente los traduce.
 */
async function POSTHandler() {
  const session = await auth();
  const role = session?.user?.role;
  if (
    !session?.user ||
    (role !== "operator" && role !== "platform_admin" && role !== "group_admin")
  ) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const restaurantId = await getActiveRestaurantId();
  if (!restaurantId) {
    return NextResponse.json({ error: "no_restaurant" }, { status: 400 });
  }

  // Idioma de quien la abre: es el que llevará la tirilla y el correo de la
  // factura, igual que en una orden de mesa.
  const locale = await getLocale();
  const opened = await db.$transaction((tx) =>
    openManualInvoiceInTx(tx, { restaurantId, locale }),
  );

  await recordAuditEvent({
    kind: "order.manual_invoice.open",
    restaurantId,
    target: { type: "order", id: opened.orderId },
    summary: `Abrió factura manual ${opened.shortCode}`,
    diff: {
      after: {
        tableId: opened.tableId,
        tableNumber: opened.tableNumber,
        createdTable: opened.createdTable,
      },
    },
  });

  // Mesas se refresca sola en las demás pantallas abiertas del comercio.
  publishOrderEvent(restaurantId, {
    type: "order.updated",
    orderId: opened.orderId,
  });

  return NextResponse.json(
    {
      orderId: opened.orderId,
      tableId: opened.tableId,
      shortCode: opened.shortCode,
    },
    { status: 201 },
  );
}

export const POST = secureApi(POSTHandler);
