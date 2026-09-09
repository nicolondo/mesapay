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
 *
 * La muestra depende de QUÉ imprime la impresora: una de comanda recibe
 * una comanda, una de factura recibe una tirilla. Probar la impresora de
 * la caja con una comanda no diría nada de lo que de verdad se quiere
 * saber ahí: si los montos quedan en columna y si el total entra.
 */

import "server-only";
import { getLocale, getTranslations } from "next-intl/server";
import { db } from "@/lib/db";
import { formatDate } from "@/lib/format";
import { isLocale, type Locale } from "@/i18n/config";
import type { InvoiceSnapshot } from "@/lib/invoice";
import {
  INVOICE_PAYLOAD_VERSION,
  TICKET_PAYLOAD_VERSION,
  columnsForWidth,
  type InvoicePrintJobPayload,
  type PrintJobPayload,
  type ThermalInvoice,
  type ThermalTicket,
} from "@/lib/escpos";
import { getCurrencyForCountry } from "@/lib/billing/countries";
import { buildInvoiceDocument } from "./invoiceQueue";

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
 * La tirilla de muestra de una impresora de FACTURA.
 *
 * Se arma con la identidad REAL del comercio (razón social, NIT,
 * dirección, resolución DIAN) y con una cuenta inventada pero verosímil:
 * platos con tildes y ñ, nombres largos que obligan a colgar renglones,
 * impuesto, descuento, propina y forma de pago. Es a propósito — lo que
 * hay que verificar en la caja no es que salga papel, es que los montos
 * queden en columna contra el borde derecho, que el total entre y que la
 * razón social no se parta en cinco renglones.
 *
 * Lo único que no es real es el NÚMERO: dice "PRUEBA" y no un
 * consecutivo, y el pie lo aclara. Una tirilla de prueba con pinta de
 * factura numerada es exactamente lo que no queremos que un cliente se
 * lleve en la mano.
 */
export async function buildTestInvoice(args: {
  restaurant: {
    name: string;
    legalName: string | null;
    taxId: string | null;
    legalAddress: string | null;
    legalCity: string | null;
    legalPhone: string | null;
    dianResolution: string | null;
    dianResolutionNumber: string | null;
    dianResolutionFrom: number | null;
    dianResolutionTo: number | null;
    dianResolutionDate: Date | null;
    invoicePrefix: string | null;
  };
  host: string;
  port: number;
  paperWidthMm: number;
  currency: string;
  now: Date;
  locale: string;
}): Promise<ThermalInvoice> {
  const t = await getTranslations({
    locale: args.locale,
    namespace: "opPrinters",
  });
  const r = args.restaurant;

  // Los importes son "centavos" como en toda la app. Elegidos para que en
  // COP den cifras de una cuenta creíble (~$100.000) y para que subtotal
  // + impuesto − descuento + propina cierre exacto contra el total: si no
  // cerrara, quien mira la prueba dudaría del sistema y no de la prueba.
  const items = [
    { qty: 2, name: t("testInvoiceItem1"), priceCents: 2_450_000 },
    { qty: 1, name: t("testInvoiceItem2"), priceCents: 1_800_000 },
    { qty: 3, name: t("testInvoiceItem3"), priceCents: 900_000 },
  ];
  const subtotalCents = items.reduce((s, i) => s + i.qty * i.priceCents, 0);
  const taxCents = 752_000;
  const discountCents = 940_000;
  const tipCents = 846_000;
  const totalCents = subtotalCents + taxCents - discountCents + tipCents;

  const snapshot: InvoiceSnapshot = {
    restaurantName: r.name,
    logoUrl: null,
    legalName: r.legalName,
    taxId: r.taxId,
    legalAddress: r.legalAddress,
    legalCity: r.legalCity,
    legalPhone: r.legalPhone,
    dianResolution: r.dianResolutionNumber ?? r.dianResolution,
    dianResolutionFrom: r.dianResolutionFrom,
    dianResolutionTo: r.dianResolutionTo,
    dianResolutionDate: r.dianResolutionDate?.toISOString() ?? null,
    invoicePrefix: r.invoicePrefix,
    shortCode: t("testInvoiceCode"),
    tableLabel: t("testInvoiceTable"),
    paidAtIso: args.now.toISOString(),
    items: items.map((i) => ({
      qty: i.qty,
      name: i.name,
      priceCents: i.priceCents,
    })),
    subtotalCents,
    taxCents,
    taxByKind: { inc: taxCents, iva: 0 },
    discountCents,
    discountPct: 10,
    tipCents,
    totalCents,
    // Una factura nominativa ejercita el bloque del cliente, que es el
    // que más veces se parte mal (nombres largos, direcciones).
    customer: {
      name: t("testInvoiceCustomer"),
      docType: "NIT",
      docNumber: "900.123.456-7",
      address: t("testInvoiceCustomerAddress"),
      city: r.legalCity ?? "",
      department: "",
    },
  };

  const doc = await buildInvoiceDocument({
    snapshot,
    invoiceNumber: 0,
    paperWidthMm: args.paperWidthMm,
    currency: args.currency,
    payments: [
      {
        method: "demo_cash",
        amountCents: totalCents - tipCents,
        tipCents,
      },
    ],
    locale: args.locale,
  });

  return {
    ...doc,
    // Sin consecutivo: esto no es una factura, es una prueba.
    documentNumber: t("testInvoiceNumber"),
    footerLines: [
      ...doc.footerLines,
      t("testInvoiceFooter"),
      // La misma chapa técnica que lleva la comanda de prueba: contra qué
      // IP salió y con cuántas columnas. Es lo que contesta "probé la
      // impresora, ¿cuál de las dos fue?" sin volver a la pantalla.
      `${args.host}:${args.port} · ${args.paperWidthMm}mm · ${columnsForWidth(args.paperWidthMm)} col`,
    ],
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
      kind: true,
      station: true,
      barSubStation: true,
      paperWidthMm: true,
    },
  });
  if (!printer) return null;

  const restaurant = await db.restaurant.findUnique({
    where: { id: args.restaurantId },
    select: {
      name: true,
      printPaperWidthMm: true,
      country: true,
      legalName: true,
      taxId: true,
      legalAddress: true,
      legalCity: true,
      legalPhone: true,
      dianResolution: true,
      dianResolutionNumber: true,
      dianResolutionFrom: true,
      dianResolutionTo: true,
      dianResolutionDate: true,
      invoicePrefix: true,
    },
  });
  if (!restaurant) return null;

  const locale = args.locale ?? (await getLocale());
  const paperWidthMm = printer.paperWidthMm ?? restaurant.printPaperWidthMm;

  let payload: PrintJobPayload | InvoicePrintJobPayload;
  if (printer.kind === "factura") {
    const invoice = await buildTestInvoice({
      restaurant,
      host: printer.host,
      port: printer.port,
      paperWidthMm,
      currency: await getCurrencyForCountry(restaurant.country),
      now: new Date(),
      locale,
    });
    payload = { v: INVOICE_PAYLOAD_VERSION, invoice };
  } else {
    const t = await getTranslations({ locale, namespace: "opPrinters" });
    const stationLine = printer.barSubStation
      ? t("stationBarSub", { sub: printer.barSubStation.toUpperCase() })
      : printer.station
        ? t(`station_${printer.station}`)
        : t("stationNone");
    const ticket = await buildTestTicket({
      printerLabel: printer.label,
      host: printer.host,
      port: printer.port,
      stationLine,
      paperWidthMm,
      restaurantName: restaurant.name,
      now: new Date(),
      locale: isLocale(locale) ? locale : undefined,
    });
    payload = { v: TICKET_PAYLOAD_VERSION, ticket };
  }

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
