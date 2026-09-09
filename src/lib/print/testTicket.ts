/**
 * La tirilla de PRUEBA que se encola desde Configuración → Impresoras.
 *
 * Por qué existe: hasta ahora la única forma de probar una impresora era
 * el botón dentro de la pestaña de Chrome del PC de la cocina. O sea que
 * para saber si la térmica de la cocina responde había que estar parado
 * en la cocina. Con la cola, la prueba sale del servidor: el dueño la
 * dispara desde su casa y el agente la escribe en la impresora real.
 *
 * Es un `PrintJob` como cualquier otro (misma cola, mismos reintentos,
 * mismo acuse), sólo que con `kind: "printer_test"` y sin `dedupeKey` —
 * apretar el botón dos veces DEBE imprimir dos veces.
 */

import "server-only";
import { getLocale, getTranslations } from "next-intl/server";
import { db } from "@/lib/db";
import { formatDate } from "@/lib/format";
import { isLocale, type Locale } from "@/i18n/config";
import {
  TICKET_PAYLOAD_VERSION,
  columnsForWidth,
  type PrintJobPayload,
  type ThermalTicket,
} from "@/lib/escpos";

export const PRINTER_TEST_JOB_KIND = "printer_test";

/**
 * Documento de prueba. Ejercita a propósito lo mismo que una comanda de
 * verdad — encabezado a doble tamaño, un ítem con modificador y nota,
 * pie y corte — porque "sale papel" no es la pregunta: la pregunta es si
 * el ancho está bien puesto y si las tildes y la ñ salen legibles
 * (CP850). Un texto con acentos en los tres idiomas responde las dos.
 */
export async function buildTestTicket(args: {
  printerLabel: string;
  host: string;
  port: number;
  stationLine: string;
  paperWidthMm: number;
  restaurantName: string;
  now: Date;
  locale?: Locale;
}): Promise<ThermalTicket> {
  const raw = args.locale ?? (await getLocale());
  const locale: Locale | undefined = isLocale(raw) ? raw : undefined;
  const t = await getTranslations({ locale: raw, namespace: "opPrinters" });

  const time = formatDate(args.now, {
    locale,
    dateStyle: undefined,
    timeStyle: undefined,
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });

  return {
    paperWidthMm: args.paperWidthMm,
    stationLine: t("testTicketTitle"),
    destinationLine: args.printerLabel,
    metaLine: `${args.host}:${args.port} · ${args.paperWidthMm}mm · ${columnsForWidth(args.paperWidthMm)} col · ${time}`,
    noticeLine: args.stationLine,
    items: [
      {
        qty: 1,
        name: t("testTicketItem"),
        modifiers: [t("testTicketModifier")],
        notes: t("testTicketNote"),
        guestName: null,
      },
    ],
    orderNote: t("testTicketBody"),
    footer: args.restaurantName,
  };
}

/**
 * Encola la prueba para UNA impresora. Devuelve el id del trabajo, o
 * null si la impresora no es del restaurante (o no existe): el llamador
 * traduce eso a 404 sin filtrar si existe en otro comercio.
 */
export async function enqueuePrinterTest(args: {
  restaurantId: string;
  printerId: string;
  locale?: Locale;
}): Promise<string | null> {
  const printer = await db.printer.findFirst({
    where: { id: args.printerId, restaurantId: args.restaurantId },
    select: {
      id: true,
      label: true,
      host: true,
      port: true,
      station: true,
      barSubStation: true,
      paperWidthMm: true,
    },
  });
  if (!printer) return null;

  const restaurant = await db.restaurant.findUnique({
    where: { id: args.restaurantId },
    select: { name: true, printPaperWidthMm: true },
  });
  if (!restaurant) return null;

  const locale = args.locale ?? (await getLocale());
  const t = await getTranslations({ locale, namespace: "opPrinters" });
  const stationLine = printer.barSubStation
    ? t("stationBarSub", { sub: printer.barSubStation.toUpperCase() })
    : t(`station_${printer.station}`);

  const ticket = await buildTestTicket({
    printerLabel: printer.label,
    host: printer.host,
    port: printer.port,
    stationLine,
    paperWidthMm: printer.paperWidthMm ?? restaurant.printPaperWidthMm,
    restaurantName: restaurant.name,
    now: new Date(),
    locale: isLocale(locale) ? locale : undefined,
  });
  const payload: PrintJobPayload = { v: TICKET_PAYLOAD_VERSION, ticket };

  const job = await db.printJob.create({
    data: {
      restaurantId: args.restaurantId,
      printerId: printer.id,
      kind: PRINTER_TEST_JOB_KIND,
      payload: payload as unknown as object,
      // Sin dedupeKey: apretar "probar" dos veces imprime dos veces. Es
      // exactamente lo que quiere quien está esperando ver salir papel.
      dedupeKey: null,
    },
    select: { id: true },
  });
  return job.id;
}
