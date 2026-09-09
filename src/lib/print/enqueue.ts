/**
 * ENCOLADO de comandas para las impresoras de red del local.
 *
 * Corre en el mismo punto donde hoy se emite el evento SSE
 * `ticket.printable` (transición placed → in_kitchen en
 * /api/operator/order-items/[id]). Los dos caminos CONVIVEN: el evento
 * se sigue emitiendo igual, así que la pestaña de Chrome sigue
 * funcionando, y un restaurante sin impresoras registradas se comporta
 * exactamente como antes — este módulo no hace nada y devuelve 0.
 *
 * Regla de oro: encolar NUNCA puede tumbar la transición del ítem en el
 * KDS. Un error acá se traga y se loguea; el cocinero marcó su plato y
 * eso es lo que importa.
 */

import "server-only";
import { getLocale, getTranslations } from "next-intl/server";
import { db } from "@/lib/db";
import { formatDate } from "@/lib/format";
import { isLocale, type Locale } from "@/i18n/config";
import {
  TICKET_PAYLOAD_VERSION,
  type PrintJobPayload,
  type ThermalTicket,
} from "@/lib/escpos";
import {
  printerMatches,
  ticketDedupeKey,
  type TicketStation,
} from "./routing";
import { loadRoundTicket, type RoundTicket } from "./ticketData";

/**
 * Traduce la comanda a un documento térmico listo para renderizar. Todos
 * los textos quedan RESUELTOS acá — el renderer ESC/POS es agnóstico de
 * i18n. El idioma es el de quien disparó la transición en el KDS, que es
 * exactamente el mismo criterio que ya usa la pestaña de impresión.
 */
export async function buildThermalTicket(
  ticket: RoundTicket,
  paperWidthMm: number,
  requestedLocale?: Locale,
): Promise<ThermalTicket> {
  const raw = requestedLocale ?? (await getLocale());
  const locale: Locale | undefined = isLocale(raw) ? raw : undefined;
  const t = await getTranslations({ locale: raw, namespace: "opPrint" });

  const stationLine =
    ticket.station === "kitchen"
      ? t("ticketKitchen")
      : ticket.barSubStation
        ? t("ticketBarSub", { sub: ticket.barSubStation.toUpperCase() })
        : t("ticketBar");

  const destinationLine =
    ticket.order.orderType === "pickup"
      ? t("ticketPickup", {
          name: ticket.order.pickupName ?? ticket.order.shortCode,
        })
      : t("ticketTable", { number: ticket.order.tableNumber });

  // Sólo la hora: `formatDate` trae dateStyle/timeStyle por defecto y
  // combinarlos con hour/minute hace explotar a Intl, por eso van en
  // undefined explícito.
  const time = formatDate(ticket.placedAt, {
    locale,
    dateStyle: undefined,
    timeStyle: undefined,
    hour: "2-digit",
    minute: "2-digit",
  });

  return {
    paperWidthMm,
    stationLine,
    destinationLine,
    metaLine: `${ticket.order.shortCode} · R${ticket.roundSeq} · ${time}`,
    noticeLine:
      ticket.order.servingMode === "together"
        ? t("ticketMainsTogether")
        : null,
    items: ticket.items.map((i) => ({
      qty: i.qty,
      name: i.name,
      modifiers: i.modifiers,
      notes: i.notes,
      guestName: i.guestName,
    })),
    orderNote: ticket.order.notes
      ? `${t("ticketTableNote")}: ${ticket.order.notes}`
      : null,
    footer: ticket.restaurantName,
  };
}

/**
 * Encola un trabajo por cada impresora activa que sirva a esa estación.
 * Devuelve cuántos encoló (0 = el local no tiene impresoras de red, o la
 * impresión de esa estación está apagada).
 *
 * NO valida los toggles kitchenPrintEnabled / barPrintEnabled: eso ya lo
 * hizo quien llama, en el mismo `if` que decide emitir el evento SSE.
 */
export async function enqueueRoundTicket(args: {
  restaurantId: string;
  orderId: string;
  roundId: string;
  station: TicketStation;
  barSubStation: string | null;
  locale?: Locale;
}): Promise<number> {
  const { restaurantId, orderId, roundId, station, barSubStation } = args;

  const printers = await db.printer.findMany({
    where: { restaurantId, station, active: true },
    select: { id: true, station: true, barSubStation: true, paperWidthMm: true },
  });
  const targets = printers.filter((p) =>
    printerMatches(p, station, barSubStation),
  );
  if (targets.length === 0) return 0;

  const loaded = await loadRoundTicket({
    restaurantId,
    roundId,
    station,
    barSubStation,
  });
  if (!loaded.ok) return 0;

  const dedupeKey = ticketDedupeKey(roundId, station, barSubStation);

  // Una impresora de 58mm y otra de 80mm en la misma estación necesitan
  // documentos distintos (32 vs 48 columnas), así que el payload se arma
  // por impresora. El contenido es el mismo; sólo cambia el ancho.
  const rows = await Promise.all(
    targets.map(async (printer) => {
      const ticket = await buildThermalTicket(
        loaded.ticket,
        printer.paperWidthMm ?? loaded.ticket.paperWidthMm,
        args.locale,
      );
      const payload: PrintJobPayload = { v: TICKET_PAYLOAD_VERSION, ticket };
      return {
        restaurantId,
        printerId: printer.id,
        kind: "kitchen_ticket",
        payload: payload as unknown as object,
        orderId,
        roundId,
        dedupeKey,
      };
    }),
  );

  // skipDuplicates apoyado en @@unique([printerId, dedupeKey]): el
  // segundo plato de la misma ronda no genera una segunda comanda.
  const created = await db.printJob.createMany({
    data: rows,
    skipDuplicates: true,
  });
  return created.count;
}

/**
 * Envoltorio que NUNCA lanza. Es el que se llama desde el KDS: si la
 * cola falla (DB caída, payload raro), el ítem igual pasa a in_kitchen y
 * la pestaña de Chrome sigue siendo el respaldo.
 *
 * Se AWAITEA dentro del request en vez de dispararse en background: los
 * textos del ticket salen de `getTranslations`, que lee la cookie de
 * idioma, y fuera del request esa lectura ya no existe. Son dos queries
 * y un insert — el KDS no lo nota.
 */
export async function enqueueRoundTicketSafe(
  args: Parameters<typeof enqueueRoundTicket>[0],
): Promise<void> {
  try {
    const n = await enqueueRoundTicket(args);
    if (n > 0) {
      console.log("[print-queue] encolados", {
        restaurantId: args.restaurantId,
        roundId: args.roundId,
        station: args.station,
        jobs: n,
      });
    }
  } catch (err) {
    console.error("[print-queue] falló el encolado", err);
  }
}
