/**
 * El error de una cuenta que YA TIENE FACTURA y alguien intenta cambiarla
 * (agregar o quitar platos, descuentos, cortesías…). Vive aparte y sin
 * dependencias de servidor, como `PendingPaymentInFlightError`, para que
 * `secureApi` lo reconozca sin cargar la DB.
 *
 * La regla completa está en `invoicedOrder.ts`.
 */

/** Código del 409. El front lo traduce (`orderInvoiced*` en los catálogos). */
export const ORDER_INVOICED = "order_invoiced";

/** Lo que la pantalla necesita para decir qué factura cierra la cuenta. */
export type InvoicedOrderInfo = {
  invoiceId: string;
  /** Número con prefijo ("FESM-42"). */
  documentNumber: string;
};

/**
 * Se lanza DENTRO de la transacción (la revierte entera) y `secureApi` lo
 * convierte en `409 { error: "order_invoiced", invoice }`.
 */
export class OrderInvoicedError extends Error {
  readonly invoice: InvoicedOrderInfo;
  constructor(invoice: InvoicedOrderInfo) {
    super(ORDER_INVOICED);
    this.name = "OrderInvoicedError";
    this.invoice = invoice;
  }
}
