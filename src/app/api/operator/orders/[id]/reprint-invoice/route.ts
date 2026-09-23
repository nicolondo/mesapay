import { secureApi } from "@/lib/secureApi";
import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { getActiveRestaurantId } from "@/lib/activeRestaurant";
import { OPERATOR_ROLES } from "@/lib/staffAccess";
import { recordAuditEvent } from "@/lib/auditLog";
import { formatInvoiceNumber } from "@/lib/invoice";
import { displayOrderCode } from "@/lib/orderCode";
import { enqueueInvoicePrint } from "@/lib/print/invoiceQueue";
import { invoicePrintArgs } from "@/lib/print/routing";

export const dynamic = "force-dynamic";

/**
 * POST /api/operator/orders/{id}/reprint-invoice
 *
 * Vuelve a mandar la tirilla de la factura de una cuenta a las impresoras
 * de FACTURA del comercio. El dueño lo pidió textual: "quiero tener la
 * opción de poder reimprimir una factura desde la lista de pedidos" — el
 * comensal que se fue sin el papel, el rollo que se acabó a mitad de la
 * tirilla, la copia para la caja.
 *
 * Es la MISMA tirilla que salió al cobrar: los argumentos se arman con
 * `invoicePrintArgs`, el mismo helper de `issueSimpleInvoice`, y van con
 * `reprint: true` para saltar la clave de idempotencia (que existe para que
 * los rieles del cobro no impriman tres veces solos, no para impedir que
 * un humano pida otra copia).
 *
 * Nunca lanza: sin impresora de facturas responde `queued: false` y la UI
 * abre la versión imprimible del navegador (/factura/[id]) como respaldo.
 *
 * Sólo roles de operador: el panel `/operator` no lo ve el mesero, y la
 * factura es un asunto de caja (mismo criterio que `invoices/[id]/print`).
 */
async function POSTHandler(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session?.user || !OPERATOR_ROLES.includes(session.user.role)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const restaurantId = await getActiveRestaurantId();
  if (!restaurantId) {
    return NextResponse.json({ error: "no_restaurant" }, { status: 400 });
  }
  const { id } = await params;

  // `orderId` es único en SimpleInvoice: una cuenta tiene a lo sumo una
  // tirilla. 404 también para la cuenta de OTRO comercio: la existencia
  // de un id ajeno no es información que este comercio tenga por qué
  // recibir.
  const invoice = await db.simpleInvoice.findUnique({
    where: { orderId: id },
    select: {
      id: true,
      restaurantId: true,
      orderId: true,
      invoiceNumber: true,
      snapshot: true,
      order: { select: { locale: true, shortCode: true } },
    },
  });
  if (!invoice || invoice.restaurantId !== restaurantId) {
    return NextResponse.json({ error: "no_invoice" }, { status: 404 });
  }

  const args = invoicePrintArgs(invoice, invoice.order);
  let printers: number;
  try {
    printers = await enqueueInvoicePrint({ ...args, reprint: true });
  } catch (err) {
    // La factura existe y su link sigue siendo válido: un fallo de la cola
    // no es un error de la cuenta. Se loguea y se le dice a la UI que no
    // salió, sin tirar el request.
    console.error("[reprint-invoice] falló el encolado", {
      orderId: id,
      invoiceId: invoice.id,
      err,
    });
    return NextResponse.json({ error: "print_failed" }, { status: 500 });
  }

  if (printers === 0) {
    return NextResponse.json({ queued: false, reason: "no_printer" });
  }

  await recordAuditEvent({
    kind: "invoice.reprint",
    restaurantId,
    target: { type: "order", id: invoice.orderId },
    summary: `Reimprimió factura ${formatInvoiceNumber(args.snapshot, invoice.invoiceNumber)} de la cuenta ${displayOrderCode(invoice.order.shortCode)}`,
    diff: { after: { invoiceId: invoice.id, printers } },
  });

  return NextResponse.json({ queued: true, printers });
}

export const POST = secureApi(POSTHandler);
