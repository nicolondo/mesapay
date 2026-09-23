/**
 * Reglas puras del encolado — separadas de `enqueue.ts` porque ese
 * módulo es `server-only` (toca DB e i18n) y estas decisiones son las
 * que hay que poder testear sin levantar nada.
 */

import type { InvoiceSnapshot } from "@/lib/invoice";

/** Las dos estaciones que imprimen comanda. `counter` no prepara nada. */
export type TicketStation = "kitchen" | "bar";

/**
 * Clave de idempotencia del encolado. El KDS marca los platos UNO POR
 * UNO, así que la misma ronda dispara la transición varias veces; sin
 * esto la cocina recibiría una copia de la comanda por cada plato.
 * Se apoya en @@unique([printerId, dedupeKey]) + skipDuplicates.
 */
export function ticketDedupeKey(
  roundId: string,
  station: TicketStation,
  barSubStation: string | null,
): string {
  return `${roundId}:${station}:${barSubStation ?? ""}`;
}

/**
 * Clave de idempotencia de la FACTURA. La emisión ya es idempotente
 * (`issueSimpleInvoice` devuelve `alreadyIssued` y no re-numera), pero se
 * la llama desde varios rieles —el cobro en efectivo, el webhook de la
 * tarjeta, el comensal pidiéndola desde su celular— y cualquiera de ellos
 * puede correr dos veces. Una tirilla duplicada saliendo en la caja es
 * plata que parece cobrada dos veces.
 *
 * Va sobre el id de la FACTURA y no de la orden: son 1:1, pero es la
 * factura la que se imprime, y si mañana una orden pudiera tener dos
 * (nota crédito) esta clave ya distingue.
 */
export function invoiceDedupeKey(invoiceId: string): string {
  return `invoice:${invoiceId}`;
}

/** Lo que necesita `enqueueInvoicePrint` para armar la tirilla. */
export type InvoicePrintArgs = {
  restaurantId: string;
  orderId: string;
  invoiceId: string;
  invoiceNumber: number;
  snapshot: InvoiceSnapshot;
  /** Idioma de la ORDEN (ver invoiceQueue.ts), no del que aprieta el botón. */
  locale: string | null;
};

/**
 * Arma los argumentos del encolado a partir de la fila de la factura y el
 * idioma de la orden. Es UN solo lugar a propósito: la emisión (las dos
 * ramas de `issueSimpleInvoice`) y la reimpresión desde el panel tienen
 * que mandar exactamente lo mismo a la impresora — si mañana la tirilla
 * necesita un campo más, se agrega acá y sale igual por los dos caminos.
 */
export function invoicePrintArgs(
  invoice: {
    id: string;
    restaurantId: string;
    orderId: string;
    invoiceNumber: number;
    snapshot: unknown;
  },
  order: { locale: string | null },
): InvoicePrintArgs {
  return {
    restaurantId: invoice.restaurantId,
    orderId: invoice.orderId,
    invoiceId: invoice.id,
    invoiceNumber: invoice.invoiceNumber,
    snapshot: invoice.snapshot as InvoiceSnapshot,
    locale: order.locale,
  };
}

/**
 * ¿Esta impresora tiene que imprimir esta comanda? Misma semántica que
 * el filtro de /operator/print/bar?sub=…: una impresora SIN sub-estación
 * es "de toda la barra" y recibe todo lo del bar; con sub-estación sólo
 * recibe la suya.
 *
 * Lo primero que se mira es el TIPO. La query del encolado ya filtra por
 * `kind: comanda`, pero esto es cinturón y tirantes a propósito: una
 * comanda saliendo por la impresora de la caja —o peor, la factura del
 * cliente por la de la parrilla— es un error que se ve desde el salón, y
 * no queremos que la única defensa sea acordarse de poner el `where`.
 */
export function printerMatches(
  printer: {
    kind: string;
    station: TicketStation | string | null;
    barSubStation: string | null;
  },
  station: TicketStation,
  barSubStation: string | null,
): boolean {
  if (printer.kind !== "comanda") return false;
  if (printer.station !== station) return false;
  if (printer.barSubStation === null) return true;
  return printer.barSubStation === barSubStation;
}

/** ¿Esta impresora saca la tirilla del cliente? */
export function isInvoicePrinter(printer: { kind: string }): boolean {
  return printer.kind === "factura";
}
