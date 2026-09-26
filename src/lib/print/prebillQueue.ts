/**
 * ENCOLADO de la PRECUENTA hacia la impresora de FACTURAS del local (la
 * elegida en Configuración, o las de tipo factura).
 *
 * Se dispara a pedido, desde el detalle de la mesa ("Imprimir
 * precuenta"): el mesero la lleva al comensal para que revise el consumo
 * antes de pagar. Sale por la misma impresora que después va a sacar la
 * factura — la de la caja — porque es el mismo papel y la misma persona
 * la arranca.
 *
 * Reglas, en el mismo espíritu que `invoiceQueue.ts`:
 *
 *  - Un comercio SIN impresora de facturas activa no encola nada y lo
 *    dice: `{ queued: false, reason }`. Quien llama (la ruta) abre entonces
 *    la vista imprimible del navegador, que es el respaldo de siempre.
 *  - Si hay impresora pero su agente no responde, también se avisa en vez
 *    de dejar un trabajo colgado que saldría media hora después, cuando
 *    la mesa ya pagó y se fue.
 *  - Sin `dedupeKey`: reimprimir una precuenta a propósito (el comensal
 *    pidió otro postre) es lo esperado. Que dos toques seguidos saquen dos
 *    papeles lo evita la UI, no la cola.
 *
 * ── El idioma ───────────────────────────────────────────────────────────
 * El de la ORDEN (`Order.locale`), como la tirilla de la factura: es el
 * papel que se le entrega al comensal, y la factura que le llega después
 * (por correo y por la caja) sale en ese mismo idioma.
 */

import { db } from "@/lib/db";
import { getEmailTranslator } from "@/lib/emailIntl";
import { formatDate, formatMoney } from "@/lib/format";
import type { PrebillData } from "@/lib/prebill";
import {
  PREBILL_JOB_KIND,
  PREBILL_PAYLOAD_VERSION,
  buildPrebillTicket,
  type PrebillPrintJobPayload,
  type ThermalPrebill,
} from "@/lib/escpos";
import { loadPrebill } from "./prebillData";
import { invoicePrinterWhere, isInvoicePrinter, printerReachable } from "./routing";

export type EnqueuePrebillResult =
  | { queued: true; printerName: string; jobs: number }
  | {
      queued: false;
      reason:
        | "not_found"
        | "order_closed"
        | "no_items"
        | "no_printer"
        | "agent_offline";
    };

/**
 * Arma el documento resolviendo idioma, moneda y fecha. Separado del
 * encolado para que la vista imprimible del navegador use EXACTAMENTE el
 * mismo documento (mismas filas, mismas etiquetas) que el papel.
 */
export async function buildPrebillDocument(args: {
  data: PrebillData;
  paperWidthMm: number;
  currency: string;
  locale: string | null;
}): Promise<ThermalPrebill> {
  const { t, locale } = await getEmailTranslator(args.locale, "emailInvoice");
  const money = (cents: number) =>
    formatMoney(cents, { currency: args.currency, locale });
  return buildPrebillTicket({
    data: args.data,
    paperWidthMm: args.paperWidthMm,
    dateLabel: formatDate(args.data.issuedAt, {
      locale,
      dateStyle: "short",
      timeStyle: "short",
    }),
    money,
    // `createTranslator` acepta valores más ricos que los que se le pasan
    // acá. El documento térmico es texto y nada más, de ahí el tipo angosto.
    t: (key, values) => t(key, values) as string,
  });
}

/**
 * Encola la precuenta en la impresora de facturas (ver arriba) cuyo agente
 * responde. Devuelve si quedó encolada y en qué impresora(s); si no, por
 * qué — nunca lanza por "no hay impresora".
 */
export async function enqueuePrebillTicket(args: {
  restaurantId: string;
  orderId: string;
  /** Quién la pidió: sólo para el log (el PrintJob no lo persiste). */
  requestedByUserId: string;
}): Promise<EnqueuePrebillResult> {
  const { restaurantId, orderId } = args;

  // Por la MISMA impresora que la factura: la elegida en Configuración
  // (`Restaurant.invoicePrinterId`, aunque sea de comanda — un local con
  // una sola térmica en la caja la usa para todo) o, sin elección, todas
  // las activas de tipo `factura`. Antes miraba sólo el tipo, y un local
  // que eligió su impresora "Caja" (de comanda) para las facturas veía
  // salir la factura por el agente y la precuenta por el navegador.
  const restaurant = await db.restaurant.findUnique({
    where: { id: restaurantId },
    select: { invoicePrinterId: true },
  });
  const chosenId = restaurant?.invoicePrinterId ?? null;
  const printers = await db.printer.findMany({
    where: invoicePrinterWhere(restaurantId, chosenId),
    select: {
      id: true,
      kind: true,
      label: true,
      paperWidthMm: true,
      agent: { select: { lastSeenAt: true, revokedAt: true, deletedAt: true } },
    },
  });
  // Cinturón y tirantes: sin elección, `isInvoicePrinter` además del
  // where — la precuenta no sale por la impresora de la parrilla ni por
  // accidente. Con elección, sólo la elegida.
  const targets = printers.filter((p) =>
    chosenId ? p.id === chosenId : isInvoicePrinter(p),
  );
  if (targets.length === 0) {
    console.warn("[print-queue] precuenta sin impresora de facturas", {
      restaurantId,
      orderId,
    });
    return { queued: false, reason: "no_printer" };
  }

  const now = new Date();
  const reachable = targets.filter((p) => printerReachable(p.agent, now));
  if (reachable.length === 0) {
    console.warn("[print-queue] precuenta: el agente de impresión no responde", {
      restaurantId,
      orderId,
      printers: targets.map((p) => p.id),
    });
    return { queued: false, reason: "agent_offline" };
  }

  const loaded = await loadPrebill({ restaurantId, orderId, now });
  if (!loaded.ok) return { queued: false, reason: loaded.reason };

  // Una impresora de 58mm y otra de 80mm necesitan documentos distintos
  // (32 vs 48 columnas): el corte de línea se decide al armar el payload.
  const rows = await Promise.all(
    reachable.map(async (printer) => {
      const prebill = await buildPrebillDocument({
        data: loaded.data,
        paperWidthMm: printer.paperWidthMm ?? loaded.paperWidthMm,
        currency: loaded.currency,
        locale: loaded.locale,
      });
      const payload: PrebillPrintJobPayload = {
        v: PREBILL_PAYLOAD_VERSION,
        prebill,
      };
      return {
        restaurantId,
        printerId: printer.id,
        kind: PREBILL_JOB_KIND,
        payload: payload as unknown as object,
        orderId,
        // Sin clave de idempotencia: reimprimir a propósito está permitido.
        dedupeKey: null,
      };
    }),
  );

  const created = await db.printJob.createMany({ data: rows });
  const printerName = reachable.map((p) => p.label).join(" · ");
  console.log("[print-queue] precuenta encolada", {
    restaurantId,
    orderId,
    requestedByUserId: args.requestedByUserId,
    jobs: created.count,
    printerName,
  });
  return { queued: true, printerName, jobs: created.count };
}
