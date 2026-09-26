import { secureApi } from "@/lib/secureApi";
import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { getActiveRestaurantId } from "@/lib/activeRestaurant";
import { STAFF_PRINT_ROLES } from "@/lib/print/staffPrint";
import { recordAuditEvent } from "@/lib/auditLog";
import { formatInvoiceNumber } from "@/lib/invoice";
import { displayOrderCode } from "@/lib/orderCode";
import { isModuleEnabled } from "@/lib/modules";
import { dianEnvironment } from "@/lib/dian/config";
import { dianQrUrl } from "@/lib/dian/crypto";
import { enqueueInvoicePrintDetailed } from "@/lib/print/invoiceQueue";
import {
  invoicePrintArgs,
  type InvoiceDianPrintData,
} from "@/lib/print/routing";

export const dynamic = "force-dynamic";

/**
 * POST /api/operator/orders/{id}/reprint-invoice
 *
 * Manda la factura de una cuenta a la impresora de facturas del comercio
 * (la elegida en Configuración, o todas las de tipo factura), por el
 * AGENTE, como las comandas. Es la ruta de TODOS los botones "Imprimir
 * factura" del staff: la lista y el detalle de pedidos ("quiero tener la
 * opción de poder reimprimir una factura desde la lista de pedidos"), el
 * "listo" del cobro del mesero, las hojas de factura del salón y la vista
 * `/factura/[id]` cuando la abre el staff. El dueño: "quisiera que la
 * impresión de facturas se haga como se hacen las de las comandas en vez
 * de con el driver de Windows" — el driver pagina el documento y corta
 * la factura larga en dos tiras; el agente la manda en ESC/POS con un
 * solo corte.
 *
 * QUÉ sale: con facturación electrónica y la factura ya ACEPTADA por la
 * DIAN, la factura electrónica (CUFE + QR), que es la misma hoja que salió
 * sola al aceptarse. Si la DIAN la rechazó o sigue pendiente —o el
 * comercio no factura electrónicamente— sale el comprobante: una "factura
 * electrónica" impresa sin CUFE aceptado no existe, y ofrecerla sería
 * ponerle al cliente en la mano un documento que la DIAN no conoce.
 *
 * Los argumentos se arman con `invoicePrintArgs`, el mismo helper de
 * `issueSimpleInvoice`, y van con `reprint: true` para saltar la clave de
 * idempotencia (que existe para que los rieles del cobro no impriman tres
 * veces solos, no para impedir que un humano pida otra copia) y el toggle
 * de impresión automática (apagarlo no apaga la reimpresión).
 *
 * Nunca lanza: sin impresora de facturas (`no_printer`) o con su agente
 * sin responder (`agent_offline`) responde `queued: false` y la UI imprime
 * la versión del navegador (/factura/[id]) como respaldo. Con impresora
 * responde además `printerName` ("Enviada a Caja").
 *
 * Quién: el staff que cobra — roles de operador y el MESERO (que cobra la
 * mesa y entrega la factura desde su pantalla de "listo"), del comercio
 * activo. El COMENSAL nunca: su sesión (o la falta de ella) da 401 acá,
 * así que desde su celular no se puede disparar papel en el local.
 */
const PRINT_ROLES = STAFF_PRINT_ROLES;
async function POSTHandler(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session?.user || !PRINT_ROLES.includes(session.user.role)) {
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
      dianDocument: { select: { state: true, cufe: true } },
      restaurant: { select: { enabledModules: true } },
    },
  });
  if (!invoice || invoice.restaurantId !== restaurantId) {
    return NextResponse.json({ error: "no_invoice" }, { status: 404 });
  }

  const dian = await dianPrintDataFor(invoice, restaurantId);
  const args = {
    ...invoicePrintArgs(invoice, invoice.order),
    ...(dian && { dian }),
  };
  let result: Awaited<ReturnType<typeof enqueueInvoicePrintDetailed>>;
  try {
    // `requireReachable`: con el agente caído el trabajo saldría cuando el
    // cliente ya se fue; mejor que el botón imprima desde el navegador ya.
    result = await enqueueInvoicePrintDetailed({
      ...args,
      reprint: true,
      requireReachable: true,
    });
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

  if (!result.queued) {
    return NextResponse.json({
      queued: false,
      reason: result.reason === "agent_offline" ? "agent_offline" : "no_printer",
    });
  }
  const printers = result.jobs;
  const printerName = result.printerNames.join(" · ");

  const document = dian ? "factura_electronica" : "comprobante";
  await recordAuditEvent({
    kind: "invoice.reprint",
    restaurantId,
    target: { type: "order", id: invoice.orderId },
    summary: `Reimprimió ${dian ? "factura electrónica" : "factura"} ${formatInvoiceNumber(args.snapshot, invoice.invoiceNumber)} de la cuenta ${displayOrderCode(invoice.order.shortCode)}`,
    diff: { after: { invoiceId: invoice.id, printers, document } },
  });

  // Comercio con facturación electrónica y la factura TODAVÍA sin aceptar
  // (pendiente, rechazada, en error): salió el comprobante, y la UI lo
  // dice — el operador no puede creer que entregó la factura electrónica.
  const dianPending =
    !dian && isModuleEnabled(invoice.restaurant.enabledModules, "einvoicing");
  return NextResponse.json({
    queued: true,
    printers,
    printerName,
    document,
    ...(dianPending && { dianPending: true }),
  });
}

/**
 * CUFE + URL del QR si —y sólo si— el comercio factura electrónicamente y
 * la DIAN ya aceptó ESTA factura. Rechazada, pendiente o sin módulo ⇒
 * null, y sale el comprobante de siempre.
 */
async function dianPrintDataFor(
  invoice: {
    restaurant: { enabledModules: unknown };
    dianDocument: { state: string; cufe: string | null } | null;
  },
  restaurantId: string,
): Promise<InvoiceDianPrintData | null> {
  if (!isModuleEnabled(invoice.restaurant.enabledModules, "einvoicing")) {
    return null;
  }
  const doc = invoice.dianDocument;
  if (!doc || doc.state !== "accepted" || !doc.cufe) return null;
  // `dianEnvironment` no descifra nada: sólo dice contra qué catálogo de
  // la DIAN se arma la URL de consulta. Sin config (raro con una factura
  // aceptada) se cae al de habilitación.
  const environment = await dianEnvironment(restaurantId);
  return {
    cufe: doc.cufe,
    qrUrl: dianQrUrl(doc.cufe, environment === "produccion" ? "1" : "2"),
  };
}

export const POST = secureApi(POSTHandler);
