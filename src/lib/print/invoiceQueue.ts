/**
 * ENCOLADO de la tirilla del cliente para las impresoras de FACTURA.
 *
 * Se dispara donde nace la factura imprimible: `issueSimpleInvoice()`, la
 * fuente única de la numeración y el snapshot. Y como desde el PR #422 esa
 * emisión se dispara sola cuando la cuenta queda pagada, la tirilla sale
 * por la impresora de la caja en el MISMO momento del cobro, sin que nadie
 * tenga que abrir una pestaña y darle a imprimir.
 *
 * Reglas, en el mismo espíritu que `enqueue.ts`:
 *
 *  - Un comercio sin impresoras de factura registradas no cambia en nada:
 *    esto no hace nada y devuelve 0.
 *  - Encolar NUNCA puede tumbar la emisión. La factura ya existe, ya tiene
 *    número y su link ya es válido; que la térmica de la caja esté
 *    desenchufada no puede volver eso un error. Se traga y se loguea.
 *  - Idempotente por `dedupeKey` sobre el id de la factura. `issueSimpleInvoice`
 *    es idempotente y varios rieles la llaman (el cobro, el webhook de la
 *    tarjeta, el comensal desde su celular): sin esto la caja escupiría la
 *    misma tirilla tres veces.
 *
 * ── El idioma ───────────────────────────────────────────────────────────
 * El de la ORDEN (`Order.locale`), no el de quien cobra. La tirilla se le
 * entrega al comensal en la mano, y es el mismo papel que le llega por
 * correo — que ya sale en `Order.locale`. Que el mail y el papel de la
 * misma factura estén en idiomas distintos sería difícil de explicar.
 * Además el correo se manda desde webhooks, donde no hay cookie que leer:
 * por eso el traductor es `getEmailTranslator` y no `getTranslations`.
 */

// Sin `import "server-only"`, a diferencia de `enqueue.ts`: este módulo
// cuelga de `simpleInvoice.ts`, que ya está en el árbol de imports de las
// rutas de cobro y de sus tests. `server-only` es un alias que Next
// resuelve en el build y que no existe como paquete, así que marcarlo
// rompería `npm test` de rutas que no tienen nada que ver con imprimir.
// La barrera real es la misma que la de `simpleInvoice.ts`: importa `db`,
// y eso ya lo vuelve inutilizable desde un componente de cliente.
import { db } from "@/lib/db";
import { getEmailTranslator } from "@/lib/emailIntl";
import { formatDate, formatMoney } from "@/lib/format";
import { getCurrencyForCountry } from "@/lib/billing/countries";
import type { InvoiceSnapshot } from "@/lib/invoice";
import {
  CUSTOMER_INVOICE_JOB_KIND,
  INVOICE_PAYLOAD_VERSION,
  type InvoicePrintJobPayload,
  type ThermalInvoice,
} from "@/lib/escpos";
import { buildThermalInvoice, type InvoicePaymentLine } from "./invoiceDoc";
import { invoiceDedupeKey } from "./routing";

/**
 * Arma el documento resolviendo idioma, moneda y fechas. Separado del
 * encolado para poder reusarlo en la tirilla de muestra del botón de
 * prueba, que no tiene ni orden ni pagos.
 */
export async function buildInvoiceDocument(args: {
  snapshot: InvoiceSnapshot;
  invoiceNumber: number;
  paperWidthMm: number;
  currency: string;
  payments: InvoicePaymentLine[];
  locale: string | null;
}): Promise<ThermalInvoice> {
  const { t, locale } = await getEmailTranslator(args.locale, "emailInvoice");
  const money = (cents: number) =>
    formatMoney(cents, { currency: args.currency, locale });
  const paidAt = new Date(args.snapshot.paidAtIso);
  const dianDate = args.snapshot.dianResolutionDate
    ? new Date(args.snapshot.dianResolutionDate)
    : null;

  return buildThermalInvoice({
    snapshot: args.snapshot,
    invoiceNumber: args.invoiceNumber,
    paperWidthMm: args.paperWidthMm,
    paidAtLabel: formatDate(paidAt, {
      locale,
      dateStyle: "short",
      timeStyle: "short",
    }),
    dianResolutionDateLabel: dianDate
      ? formatDate(dianDate, { locale, dateStyle: "short", timeStyle: undefined })
      : null,
    payments: args.payments,
    money,
    // `createTranslator` acepta valores más ricos que los que se le pasan
    // acá (elementos de React, fechas). El documento térmico es texto y
    // nada más, de ahí el tipo angosto.
    t: (key, values) => t(key, values) as string,
  });
}

/**
 * Encola la tirilla en CADA impresora de factura activa del comercio.
 * Devuelve cuántos trabajos creó (0 = el local no tiene impresora de
 * facturas, o esta factura ya se había encolado).
 */
export async function enqueueInvoicePrint(args: {
  restaurantId: string;
  orderId: string;
  invoiceId: string;
  invoiceNumber: number;
  snapshot: InvoiceSnapshot;
  locale: string | null;
}): Promise<number> {
  const printers = await db.printer.findMany({
    where: { restaurantId: args.restaurantId, kind: "factura", active: true },
    select: { id: true, paperWidthMm: true },
  });
  if (printers.length === 0) return 0;

  const restaurant = await db.restaurant.findUnique({
    where: { id: args.restaurantId },
    select: { printPaperWidthMm: true, country: true },
  });
  if (!restaurant) return 0;

  // Cómo se pagó. `approved` nada más: un `pending` de efectivo es plata
  // que el comensal DIJO que iba a entregar, y esta tirilla se imprime
  // cuando la cuenta ya está paga.
  const payments = await db.payment.findMany({
    where: { orderId: args.orderId, status: "approved" },
    orderBy: { createdAt: "asc" },
    select: { method: true, amountCents: true, tipCents: true },
  });

  const currency = await getCurrencyForCountry(restaurant.country);
  const dedupeKey = invoiceDedupeKey(args.invoiceId);

  // Una impresora de 58mm y otra de 80mm necesitan documentos distintos
  // (32 vs 48 columnas): el corte de línea se decide al armar el payload,
  // no al imprimir.
  const rows = await Promise.all(
    printers.map(async (printer) => {
      const invoice = await buildInvoiceDocument({
        snapshot: args.snapshot,
        invoiceNumber: args.invoiceNumber,
        paperWidthMm: printer.paperWidthMm ?? restaurant.printPaperWidthMm,
        currency,
        payments,
        locale: args.locale,
      });
      const payload: InvoicePrintJobPayload = {
        v: INVOICE_PAYLOAD_VERSION,
        invoice,
      };
      return {
        restaurantId: args.restaurantId,
        printerId: printer.id,
        kind: CUSTOMER_INVOICE_JOB_KIND,
        payload: payload as unknown as object,
        orderId: args.orderId,
        dedupeKey,
      };
    }),
  );

  // skipDuplicates apoyado en @@unique([printerId, dedupeKey]): volver a
  // emitir la misma factura no vuelve a imprimirla.
  const created = await db.printJob.createMany({
    data: rows,
    skipDuplicates: true,
  });
  return created.count;
}

/**
 * Envoltorio que NUNCA lanza. Es el que se llama desde
 * `issueSimpleInvoice`: si la cola falla, la factura igual quedó emitida
 * y el cliente igual la recibe por correo y por el link.
 */
export async function enqueueInvoicePrintSafe(
  args: Parameters<typeof enqueueInvoicePrint>[0],
): Promise<void> {
  try {
    const n = await enqueueInvoicePrint(args);
    if (n > 0) {
      console.log("[print-queue] factura encolada", {
        restaurantId: args.restaurantId,
        invoiceId: args.invoiceId,
        jobs: n,
      });
    }
  } catch (err) {
    console.error("[print-queue] falló el encolado de la factura", err);
  }
}
