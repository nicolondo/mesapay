import { db } from "@/lib/db";
import { issueSimpleInvoice, sendSimpleInvoiceEmail } from "@/lib/simpleInvoice";

/**
 * Emisión diferida de la factura pedida ANTES de pagar.
 *
 * El comensal pide la factura en el CHECKOUT (mientras todavía tiene el
 * celular en la mano), no después del cobro. En ese momento la orden no está
 * pagada, así que sólo guardamos la intención:
 *
 *   - factura personalizada  → fila `InvoiceRequest` (nombre, documento, …)
 *   - factura genérica       → `Order.simpleInvoiceEmail`
 *
 * Esta función es el otro extremo del riel: se llama desde TODOS los caminos
 * donde una orden pasa a pagada (efectivo, datáfono, tarjeta, PSE, webhook,
 * cortesía, abono de reserva) y emite la factura recién ahí.
 *
 * Contrato:
 *  - NUNCA lanza. Un fallo de correo/emisión no puede tumbar un cobro que ya
 *    quedó registrado — se traga y se loguea.
 *  - Idempotente: si la orden ya tiene `SimpleInvoice` no re-emite ni
 *    re-envía. `SimpleInvoice.orderId` es único, así que dos rieles
 *    simultáneos terminan con una sola factura (el perdedor cae al catch).
 *  - Debe correr FUERA de cualquier transacción: hace su propio insert y
 *    dispara correo.
 */
export async function issueRequestedInvoiceOnPaid(opts: {
  tenantId: string;
  orderId: string;
}): Promise<void> {
  try {
    const order = await db.order.findUnique({
      where: { id: opts.orderId },
      select: {
        id: true,
        restaurantId: true,
        status: true,
        simpleInvoiceEmail: true,
        simpleInvoice: { select: { id: true } },
      },
    });
    if (!order || order.restaurantId !== opts.tenantId) return;
    // Todavía no está pagada (cobro parcial, cuenta compartida a medias):
    // la solicitud queda guardada y el próximo riel que la cierre la emite.
    if (order.status !== "paid") return;
    // Ya emitida — el correo lo mandó quien la emitió. Nada que hacer.
    if (order.simpleInvoice) return;

    // La personalizada manda sobre la genérica: si el comensal cargó sus
    // datos, la factura sale a su nombre aunque antes hubiera dejado un
    // correo suelto.
    const request = await db.invoiceRequest.findFirst({
      where: { orderId: order.id, status: "pending" },
      orderBy: { createdAt: "desc" },
    });
    const email = request?.email ?? order.simpleInvoiceEmail ?? null;
    // Nadie pidió factura en esta cuenta.
    if (!request && !email) return;

    const inv = await issueSimpleInvoice({
      tenantId: opts.tenantId,
      orderId: order.id,
      email,
      customer: request
        ? {
            name: request.customerName,
            docType: request.docType,
            docNumber: request.docNumber,
            address: request.address,
            city: request.city,
            department: request.department,
          }
        : null,
    });
    if (!inv.ok || inv.alreadyIssued || !inv.email) return;

    // Correo best-effort: la factura ya existe y su link es válido aunque el
    // envío demore o falle. `sendSimpleInvoiceEmail` no lanza.
    void sendSimpleInvoiceEmail({
      invoiceId: inv.invoiceId,
      snapshot: inv.snapshot,
      invoiceNumber: inv.invoiceNumber,
      invoiceUrl: inv.invoiceUrl,
      email: inv.email,
      locale: inv.locale,
    });
  } catch (err) {
    console.error("[invoice-on-paid] no se pudo emitir la factura pedida", {
      orderId: opts.orderId,
      err,
    });
  }
}
