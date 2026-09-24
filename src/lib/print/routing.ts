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
 *
 * Es la MISMA clave para el comprobante que sale al cobrar y para la
 * factura electrónica que sale cuando la DIAN acepta: una cuenta, una
 * hoja. Con `einvoicing` el cobro no encola (ver `invoicePrintDecision`),
 * así que la clave queda libre para la aceptación — y si la aceptación
 * llega dos veces (el emit y la consulta diferida), la segunda choca.
 */
export function invoiceDedupeKey(invoiceId: string): string {
  return `invoice:${invoiceId}`;
}

/**
 * Qué disparó la impresión de la factura. Decide DOS cosas: si sale
 * papel (`invoicePrintDecision`) y si lleva clave de idempotencia (la
 * reimpresión no la lleva: un humano pidiendo otra copia no es un
 * duplicado).
 *
 *   · "paid": el cobro, desde `issueSimpleInvoice`.
 *   · "dian_accepted": la DIAN aceptó la factura electrónica — el intento
 *     inmediato del cobro, el barrido o la consulta diferida.
 *   · "reprint": alguien apretó "Reimprimir" en Pedidos.
 */
export type InvoicePrintTrigger = "paid" | "dian_accepted" | "reprint";

/** Lo que vuelve a la tirilla una FACTURA ELECTRÓNICA: CUFE + QR. */
export type InvoiceDianPrintData = {
  cufe: string;
  /** URL de consulta en el catálogo de la DIAN — es el dato del QR. */
  qrUrl: string;
};

/** Lo que necesita `enqueueInvoicePrint` para armar la tirilla. */
export type InvoicePrintArgs = {
  restaurantId: string;
  orderId: string;
  invoiceId: string;
  invoiceNumber: number;
  snapshot: InvoiceSnapshot;
  /** Idioma de la ORDEN (ver invoiceQueue.ts), no del que aprieta el botón. */
  locale: string | null;
  /**
   * Con valor, el documento es la FACTURA ELECTRÓNICA (rótulo, CUFE, QR
   * o URL de consulta, "representación impresa"). Sin valor, el
   * comprobante de siempre. Sólo se pasa cuando la DIAN ya la ACEPTÓ.
   */
  dian?: InvoiceDianPrintData | null;
};

/**
 * Arma los argumentos del encolado a partir de la fila de la factura y el
 * idioma de la orden. Es UN solo lugar a propósito: la emisión (las dos
 * ramas de `issueSimpleInvoice`), la aceptación de la DIAN y la
 * reimpresión desde el panel tienen que mandar exactamente lo mismo a la
 * impresora — si mañana la tirilla necesita un campo más, se agrega acá
 * y sale igual por los tres caminos.
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

export type InvoicePrintDecision =
  | "print"
  /** `Restaurant.invoiceAutoPrint` apagado: sólo la reimpresión manual. */
  | "skip_auto_off"
  /**
   * Comercio con facturación electrónica: al cobrar NO sale papel; la
   * factura electrónica se imprime cuando la DIAN la acepta.
   */
  | "skip_waits_dian";

/**
 * ¿Sale papel? La regla entera, en un solo lugar (la explicación larga
 * está en `invoiceQueue.ts`):
 *
 *   · Reimprimir a propósito imprime SIEMPRE, con o sin automático.
 *   · Con `invoiceAutoPrint` apagado, ningún disparo automático imprime.
 *   · Con `einvoicing`, el cobro no imprime: espera la aceptación de la
 *     DIAN ("dian_accepted"), que es la única que trae CUFE y QR.
 *   · Sin `einvoicing`, el cobro imprime el comprobante como siempre.
 */
export function invoicePrintDecision(args: {
  trigger: InvoicePrintTrigger;
  /** `Restaurant.invoiceAutoPrint`. */
  autoPrint: boolean;
  /** Módulo `einvoicing` activo en el comercio. */
  einvoicing: boolean;
}): InvoicePrintDecision {
  if (args.trigger === "reprint") return "print";
  if (!args.autoPrint) return "skip_auto_off";
  if (args.trigger === "paid" && args.einvoicing) return "skip_waits_dian";
  return "print";
}

/**
 * A qué impresoras va la factura — el `where` del encolado:
 *
 *   · Con `Restaurant.invoicePrinterId`, SÓLO esa impresora, y sólo si
 *     está activa. Aunque sea de tipo `comanda`: un local con una sola
 *     térmica en la caja la usa para todo, y esa elección la hizo el
 *     dueño a propósito en Configuración. Si la apagó, no sale papel
 *     (no se cae a "todas"): apagarla fue una decisión, y una factura
 *     saliendo por la parrilla sin que nadie lo haya pedido es peor que
 *     una factura que no sale y la pantalla de impresoras avisa.
 *   · Sin elección, todas las activas de tipo `factura`, como siempre.
 */
export function invoicePrinterWhere(
  restaurantId: string,
  invoicePrinterId: string | null,
): { restaurantId: string; active: true; id?: string; kind?: "factura" } {
  if (invoicePrinterId) return { restaurantId, active: true, id: invoicePrinterId };
  return { restaurantId, active: true, kind: "factura" };
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
