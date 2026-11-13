/**
 * FACTURA ANTES DE COBRAR.
 *
 * El dueño: "cuando el cliente le pide a un mesero la factura, el mesero
 * imprime la factura para llevársela al cliente, pero para imprimir la
 * factura se necesita poner un método de pago que todavía no se sabe cuál
 * va a ser; entonces toca preguntarle al cliente primero cómo va a pagar".
 *
 * Esto emite la factura de la cuenta ABIERTA, sin método de pago:
 *
 *   1. Adquiriente: lo que ya quedó registrado en la cuenta con la misma
 *      pantalla de siempre (factura personalizada / cliente registrado =
 *      `InvoiceRequest`; si no, genérica a consumidor final). Se elige
 *      ANTES de apretar "Imprimir factura".
 *   2. `issueSimpleInvoice({ beforePayment: true })`: numera, congela la
 *      cuenta (ítems en `orderItemIds`) y la deja CERRADA a cambios
 *      (`orders/invoicedOrder.ts`).
 *   3. Con facturación electrónica: el DianDocument y la emisión YA (no al
 *      cobrar), con medio de pago "1 – Instrumento no definido"
 *      (`dian/emit.invoicePaymentMeans`). El papel sale cuando la DIAN la
 *      acepta: en esta misma llamada si responde rápido; si no, solo, en
 *      cuanto la acepte (barrido o consulta diferida).
 *   4. El papel: "Pendiente de pago" en vez de la forma de pago, y la
 *      propina sugerida con el TOTAL CON PROPINA de la precuenta
 *      (`print/invoiceDoc.pendingPaymentOf`) — esta hoja la reemplaza.
 *
 * Después se cobra con lo que sea (efectivo, datáfono, link, dividida por
 * persona, a crédito): cada riel del cobro termina en `issueInvoiceOnPaid`,
 * que encuentra ESTA factura y no emite otra ni imprime otra hoja.
 *
 * Nunca hace nada a medias que no se pueda retomar: si la DIAN no responde
 * la factura queda numerada y en cola, y el barrido la emite; si la
 * impresora no está, el staff la imprime desde el navegador.
 */
import { db } from "@/lib/db";
import { resolveEmisor, dianEnvironment } from "@/lib/dian/config";
import { dianQrUrl } from "@/lib/dian/crypto";
import { ensureDianDocument } from "@/lib/dian/emit";
import { emitDianInvoice, type EmitDianInvoiceResult } from "@/lib/dian/emitInvoice";
import { deliverInvoiceEmail } from "@/lib/invoiceDelivery";
import { formatInvoiceNumber, type InvoiceSnapshot } from "@/lib/invoice";
import { isBillableOrder, numberingExhausted } from "@/lib/invoiceOnPaid";
import { isModuleEnabled } from "@/lib/modules";
import { syncOrderSubtotalFromLiveItems } from "@/lib/orderTotals";
import { issueSimpleInvoice } from "@/lib/simpleInvoice";
import {
  SIMPLE_INVOICE_WITHOUT_EMAIL,
  isSimpleInvoiceRequested,
  simpleInvoiceEmailFrom,
} from "@/lib/simpleInvoiceRequest";
import {
  enqueueInvoicePrintDetailed,
  type InvoicePrintResult,
} from "@/lib/print/invoiceQueue";
import { invoicePrintArgs, type InvoiceDianPrintData } from "@/lib/print/routing";

/** Cómo está la factura en la DIAN, en palabras de la pantalla. */
export type PreInvoiceDianStatus =
  /** Aceptada: es factura electrónica válida (y se puede imprimir). */
  | { state: "accepted" }
  /** Enviada, la DIAN no ha contestado / la está procesando. */
  | { state: "pending" }
  /** Frenada ANTES de enviar por la configuración (`reason`). */
  | { state: "blocked"; reason: string }
  /** La DIAN la rechazó: hay que corregir y reintentar desde Facturas. */
  | { state: "rejected"; reason: string | null }
  /** Error de canal: el barrido la reintenta solo. */
  | { state: "error"; reason: string | null };

/** Por dónde salió el papel (o por qué no salió). */
export type PreInvoicePrint =
  | { queued: true; printerName: string }
  /** Sin impresora de facturas / agente sin responder ⇒ navegador. */
  | { queued: false; reason: "no_printer" | "agent_offline" | "skipped" | "duplicate" | "not_found" }
  /** Con facturación electrónica y la DIAN sin aceptarla todavía. */
  | { queued: false; reason: "waiting_dian" };

export type PreInvoiceResult =
  | {
      ok: true;
      invoiceId: string;
      /** Número con prefijo ("FESM-42"). */
      documentNumber: string;
      /** Ya tenía factura: se devuelve esa (idempotente). */
      alreadyIssued: boolean;
      einvoicing: boolean;
      /** null = comercio sin facturación electrónica. */
      dian: PreInvoiceDianStatus | null;
      print: PreInvoicePrint;
    }
  | {
      ok: false;
      error:
        | "not_found"
        /** Pagada o cancelada: lo que corresponde es la factura del cobro. */
        | "order_closed"
        /** Cortesía o cuenta en $0: no es una venta. */
        | "not_billable"
        /** Se acabó la numeración de la resolución. */
        | "numbering_exhausted";
    };

/** Estado DIAN para la pantalla a partir del documento guardado. */
export function dianStatusOf(doc: {
  state: string;
  lastError: string | null;
}): PreInvoiceDianStatus {
  switch (doc.state) {
    case "accepted":
      return { state: "accepted" };
    case "rejected":
      return { state: "rejected", reason: doc.lastError };
    case "error":
      return { state: "error", reason: doc.lastError };
    case "to_send":
      // `to_send` con motivo = frenada por configuración; sin motivo = en
      // cola (recién creada o esperando al barrido).
      return doc.lastError
        ? { state: "blocked", reason: doc.lastError }
        : { state: "pending" };
    default:
      // `sent` (reclamada, en vuelo) y `pending` (la DIAN la procesa).
      return { state: "pending" };
  }
}

/** Estado DIAN a partir de lo que devolvió el intento de emisión. */
function dianStatusFromEmit(r: EmitDianInvoiceResult): PreInvoiceDianStatus | null {
  switch (r.outcome) {
    case "accepted":
      return { state: "accepted" };
    case "pending":
      return { state: "pending" };
    case "rejected":
      return { state: "rejected", reason: r.errors[0] ?? null };
    case "error":
      return { state: "error", reason: r.errors[0] ?? null };
    case "blocked":
      return { state: "blocked", reason: r.reason };
    default:
      // already_emitted / not_found: se lee el documento.
      return null;
  }
}

/** CUFE + URL del QR de la factura si la DIAN ya la aceptó. */
async function acceptedDianPrintData(
  restaurantId: string,
  simpleInvoiceId: string,
): Promise<InvoiceDianPrintData | null> {
  const doc = await db.dianDocument.findUnique({
    where: { simpleInvoiceId },
    select: { state: true, cufe: true },
  });
  if (!doc || doc.state !== "accepted" || !doc.cufe) return null;
  const environment = await dianEnvironment(restaurantId);
  return {
    cufe: doc.cufe,
    qrUrl: dianQrUrl(doc.cufe, environment === "produccion" ? "1" : "2"),
  };
}

function printOf(r: InvoicePrintResult): PreInvoicePrint {
  if (r.queued) return { queued: true, printerName: r.printerNames.join(" · ") };
  return { queued: false, reason: r.reason };
}

/**
 * Manda a la impresora de facturas la factura emitida antes de cobrar:
 * el comprobante (sin `einvoicing`) o la factura electrónica ACEPTADA.
 * Con `einvoicing` y la DIAN sin aceptarla no imprime nada — un papel sin
 * CUFE no es la factura electrónica (para eso está la precuenta).
 *
 * Por el AGENTE y sólo si responde (`requireReachable`): si no, el staff
 * la imprime desde el navegador ya, en vez de que salga media hora después.
 * Lleva la clave de la factura: la aceptación tardía no saca otra hoja.
 */
export async function printPreIssuedInvoice(args: {
  restaurantId: string;
  invoiceId: string;
  einvoicing: boolean;
}): Promise<PreInvoicePrint> {
  const inv = await db.simpleInvoice.findUnique({
    where: { id: args.invoiceId },
    select: {
      id: true,
      restaurantId: true,
      orderId: true,
      invoiceNumber: true,
      snapshot: true,
      order: { select: { locale: true } },
    },
  });
  if (!inv || inv.restaurantId !== args.restaurantId) {
    return { queued: false, reason: "not_found" };
  }
  let dian: InvoiceDianPrintData | null = null;
  if (args.einvoicing) {
    dian = await acceptedDianPrintData(args.restaurantId, inv.id);
    if (!dian) return { queued: false, reason: "waiting_dian" };
  }
  try {
    const r = await enqueueInvoicePrintDetailed({
      ...invoicePrintArgs(inv, inv.order),
      ...(dian && { dian }),
      trigger: "pre_issue",
      requireReachable: true,
    });
    return printOf(r);
  } catch (err) {
    // La factura existe y su link es válido: que la cola falle no es un
    // error de la cuenta. Se imprime desde el navegador.
    console.error("[pre-invoice] falló el encolado", { invoiceId: inv.id, err });
    return { queued: false, reason: "no_printer" };
  }
}

/**
 * Emite la factura de una cuenta abierta (ver el encabezado). Idempotente:
 * si la cuenta ya tiene factura la devuelve, reintenta la emisión a la
 * DIAN si quedó pendiente de envío, y vuelve a decir cómo está.
 *
 * `restaurantId` es el del staff que la pide: una cuenta de otro comercio
 * es `not_found`.
 */
export async function preIssueInvoice(args: {
  restaurantId: string;
  orderId: string;
  now?: Date;
}): Promise<PreInvoiceResult> {
  const order = await db.order.findUnique({
    where: { id: args.orderId },
    select: {
      id: true,
      restaurantId: true,
      status: true,
      compedAt: true,
      simpleInvoiceEmail: true,
      simpleInvoice: { select: { id: true } },
      restaurant: { select: { enabledModules: true } },
    },
  });
  if (!order || order.restaurantId !== args.restaurantId) {
    return { ok: false, error: "not_found" };
  }
  const einvoicing = isModuleEnabled(order.restaurant.enabledModules, "einvoicing");
  const alreadyIssued = !!order.simpleInvoice;

  if (!alreadyIssued) {
    if (order.status === "paid" || order.status === "cancelled") {
      return { ok: false, error: "order_closed" };
    }
    // Lo cobrable sale de los ítems VIVOS, como en el cobro y la
    // precuenta: si quedó un subtotal viejo, se sana antes de congelarlo.
    const synced = await syncOrderSubtotalFromLiveItems(order.id);
    if (!isBillableOrder({ compedAt: order.compedAt, subtotalCents: synced.subtotalCents })) {
      return { ok: false, error: "not_billable" };
    }
    if (einvoicing) {
      // Sin número válido no hay factura: lo dice la pantalla. NO se deja
      // el placeholder de `numbering_exhausted` (ése es del cobro): la
      // cuenta sigue abierta y se factura al cobrar cuando haya rango.
      const emisor = await resolveEmisor(args.restaurantId);
      if (numberingExhausted(emisor)) return { ok: false, error: "numbering_exhausted" };
    }
  }

  // El adquiriente: el que ya quedó registrado en la cuenta (mismo
  // criterio que `issueInvoiceOnPaid`): personalizada si hay solicitud,
  // genérica (con o sin correo) si no.
  const request = await db.invoiceRequest.findFirst({
    where: { orderId: order.id, status: "pending" },
    orderBy: { createdAt: "desc" },
  });
  const email = request?.email ?? simpleInvoiceEmailFrom(order.simpleInvoiceEmail);
  if (!alreadyIssued && !request && !isSimpleInvoiceRequested(order.simpleInvoiceEmail)) {
    // Constancia de que pidieron la genérica (sin correo): la pantalla de
    // "listo" la muestra pedida, y sin facturación electrónica el cobro
    // la reconoce como pedida.
    await db.order.updateMany({
      where: { id: order.id, simpleInvoiceEmail: null },
      data: { simpleInvoiceEmail: SIMPLE_INVOICE_WITHOUT_EMAIL },
    });
  }

  const inv = await issueSimpleInvoice({
    tenantId: args.restaurantId,
    orderId: order.id,
    email,
    beforePayment: true,
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
  if (!inv.ok) {
    return {
      ok: false,
      error: inv.error === "not_found" ? "not_found" : "order_closed",
    };
  }
  const documentNumber = formatInvoiceNumber(inv.snapshot as InvoiceSnapshot, inv.invoiceNumber);

  // Correo: el comprobante sin facturación electrónica (si dejaron correo);
  // con ella, la factura electrónica sale sola al aceptarla la DIAN.
  if (!inv.alreadyIssued) {
    void deliverInvoiceEmail({
      tenant: { id: args.restaurantId, enabledModules: order.restaurant.enabledModules },
      invoice: {
        invoiceId: inv.invoiceId,
        invoiceNumber: inv.invoiceNumber,
        invoiceUrl: inv.invoiceUrl,
        snapshot: inv.snapshot,
        email: inv.email,
        // Los adicionales de la personalizada, si el correo que sale es el suyo.
        cc: request && inv.email === request.email ? request.ccEmails : [],
        locale: inv.locale,
      },
      firstIssuance: true,
    });
  }

  let dian: PreInvoiceDianStatus | null = null;
  if (einvoicing) {
    const doc = await ensureDianDocument({
      simpleInvoiceId: inv.invoiceId,
      restaurantId: args.restaurantId,
      orderId: order.id,
    });
    // La emisión va YA, esperándola: el mesero está parado al lado de la
    // impresora. Sólo lo que está para enviar (recién creado, o un bloqueo
    // que el operador ya pudo haber arreglado); lo que está en manos de la
    // DIAN o del barrido no se toca. El papel NO lo saca la emisión: lo
    // saca `printPreIssuedInvoice` abajo, que dice por dónde salió.
    if (doc.state === "to_send") {
      try {
        const r = await emitDianInvoice({
          simpleInvoiceId: inv.invoiceId,
          restaurantId: args.restaurantId,
          now: args.now,
          printOnAccept: false,
        });
        dian = dianStatusFromEmit(r);
      } catch (err) {
        console.error("[pre-invoice] la emisión inmediata falló", { orderId: order.id, err });
      }
    }
    if (!dian) {
      const fresh = await db.dianDocument.findUnique({
        where: { simpleInvoiceId: inv.invoiceId },
        select: { state: true, lastError: true },
      });
      dian = fresh ? dianStatusOf(fresh) : { state: "pending" };
    }
  }

  // Papel: sólo la primera vez (o, ya emitida, si la DIAN recién la acepta
  // ahora). Una segunda llamada sobre una factura que ya salió no saca otra
  // copia sola: la clave `invoice:<id>` lo impide y "Reimprimir" existe
  // para eso.
  const print: PreInvoicePrint =
    !einvoicing || dian?.state === "accepted"
      ? await printPreIssuedInvoice({
          restaurantId: args.restaurantId,
          invoiceId: inv.invoiceId,
          einvoicing,
        })
      : { queued: false, reason: "waiting_dian" };

  return {
    ok: true,
    invoiceId: inv.invoiceId,
    documentNumber,
    alreadyIssued: inv.alreadyIssued,
    einvoicing,
    dian,
    print,
  };
}

/**
 * Estado de la factura emitida antes de cobrar, para que la pantalla
 * pregunte "¿ya la aceptó la DIAN?" sin volver a emitir nada.
 */
export async function preInvoiceStatus(args: {
  restaurantId: string;
  orderId: string;
}): Promise<
  | {
      ok: true;
      invoiceId: string;
      documentNumber: string;
      einvoicing: boolean;
      dian: PreInvoiceDianStatus | null;
      paid: boolean;
    }
  | { ok: false; error: "not_found" | "no_invoice" }
> {
  const order = await db.order.findUnique({
    where: { id: args.orderId },
    select: {
      restaurantId: true,
      status: true,
      restaurant: { select: { enabledModules: true } },
      simpleInvoice: {
        select: {
          id: true,
          invoiceNumber: true,
          snapshot: true,
          dianDocument: { select: { state: true, lastError: true } },
        },
      },
    },
  });
  if (!order || order.restaurantId !== args.restaurantId) {
    return { ok: false, error: "not_found" };
  }
  const inv = order.simpleInvoice;
  if (!inv) return { ok: false, error: "no_invoice" };
  const einvoicing = isModuleEnabled(order.restaurant.enabledModules, "einvoicing");
  return {
    ok: true,
    invoiceId: inv.id,
    documentNumber: formatInvoiceNumber(inv.snapshot as unknown as InvoiceSnapshot, inv.invoiceNumber),
    einvoicing,
    dian: einvoicing
      ? inv.dianDocument
        ? dianStatusOf(inv.dianDocument)
        : { state: "pending" }
      : null,
    paid: order.status === "paid",
  };
}
