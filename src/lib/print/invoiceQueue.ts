/**
 * ENCOLADO de la factura del cliente para la impresora de la caja.
 *
 * Se dispara donde nace la factura imprimible: `issueSimpleInvoice()`, la
 * fuente única de la numeración y el snapshot. Y como desde el PR #422 esa
 * emisión se dispara sola cuando la cuenta queda pagada, la tirilla sale
 * por la impresora de la caja en el MISMO momento del cobro, sin que nadie
 * tenga que abrir una pestaña y darle a imprimir.
 *
 * ── Qué se imprime y cuándo (la regla, completa) ────────────────────────
 *
 *   · Comercio SIN facturación electrónica: el COMPROBANTE sale al
 *     cobrar, desde `issueSimpleInvoice` (trigger "paid"). Como siempre.
 *
 *   · Comercio CON el módulo `einvoicing`: al cobrar NO sale papel. Lo que
 *     se imprime es la FACTURA ELECTRÓNICA —rótulo, adquiriente, CUFE y
 *     QR o URL de consulta— y sale en el momento en que la DIAN la ACEPTA
 *     (trigger "dian_accepted", desde `printAcceptedDianInvoice`), sea por
 *     el intento inmediato del cobro, por el barrido de cada 5 min o por la
 *     consulta diferida del estado. Si la DIAN la rechaza o la deja
 *     pendiente no sale nada: una "factura electrónica" impresa sin CUFE
 *     aceptado no existe. UNA sola hoja por cuenta: el mismo `dedupeKey`
 *     (`invoice:<id>`) cubre los dos caminos por los que llega la
 *     aceptación.
 *
 *   · `Restaurant.invoiceAutoPrint` en false apaga los dos disparos
 *     automáticos. La reimpresión manual desde Pedidos (trigger "reprint")
 *     funciona siempre, y reimprime la factura electrónica si ya está
 *     aceptada o el comprobante si no.
 *
 *   · A qué impresora: `Restaurant.invoicePrinterId` si el dueño eligió
 *     una en Configuración (sólo esa, aunque sea de comanda, y sólo si está
 *     activa); si no, todas las activas de tipo `factura`, como siempre.
 *     El QR sale sólo en las que tienen `Printer.supportsQr`.
 *
 * Las decisiones puras viven en `routing.ts` (`invoicePrintDecision`,
 * `invoicePrinterWhere`) para poder testearlas sin DB.
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
import { isModuleEnabled } from "@/lib/modules";
import type { InvoiceSnapshot } from "@/lib/invoice";
import {
  CUSTOMER_INVOICE_JOB_KIND,
  INVOICE_PAYLOAD_VERSION,
  type InvoicePrintJobPayload,
  type ThermalInvoice,
} from "@/lib/escpos";
import { buildThermalInvoice, type InvoicePaymentLine } from "./invoiceDoc";
import {
  invoiceDedupeKey,
  invoicePrintArgs,
  invoicePrintDecision,
  invoicePrinterWhere,
  type InvoiceDianPrintData,
  type InvoicePrintArgs,
  type InvoicePrintTrigger,
} from "./routing";

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
  /** Factura electrónica ACEPTADA: CUFE + URL del QR. null = comprobante. */
  dian?: InvoiceDianPrintData | null;
  /** La impresora DESTINO imprime QR nativo (`Printer.supportsQr`). */
  supportsQr?: boolean;
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
    dian: args.dian
      ? {
          cufe: args.dian.cufe,
          verifyUrl: args.dian.qrUrl,
          qr: args.supportsQr === true,
        }
      : null,
  });
}

/**
 * Encola la factura en la(s) impresora(s) que corresponde(n) — ver el
 * encabezado y `invoicePrinterWhere`. Devuelve cuántos trabajos creó
 * (0 = el local no tiene impresora para facturas, esta factura ya se
 * había encolado, o la regla dijo que no sale papel).
 *
 * `trigger` decide si sale papel (`invoicePrintDecision`) y si lleva
 * clave de idempotencia. `reprint: true` es el atajo de `trigger:
 * "reprint"` que ya usaba la ruta de reimpresión.
 *
 * Una REIMPRESIÓN pedida a propósito va sin `dedupeKey` (en Postgres
 * varios NULL no chocan contra el unique), que es exactamente lo que hace
 * `print-jobs/[id]/retry` con las comandas: la clave de idempotencia
 * existe para que los rieles del cobro no saquen tres copias solas, no
 * para impedir que un humano pida otra copia. Sin esto, reimprimir una
 * factura que ya salió una vez daría 0 trabajos y el operador se quedaría
 * esperando papel.
 */
export async function enqueueInvoicePrint(
  args: InvoicePrintArgs & { reprint?: boolean; trigger?: InvoicePrintTrigger },
): Promise<number> {
  const trigger: InvoicePrintTrigger =
    args.trigger ?? (args.reprint ? "reprint" : "paid");

  const restaurant = await db.restaurant.findUnique({
    where: { id: args.restaurantId },
    select: {
      printPaperWidthMm: true,
      country: true,
      invoicePrinterId: true,
      invoiceAutoPrint: true,
      enabledModules: true,
    },
  });
  if (!restaurant) return 0;

  const decision = invoicePrintDecision({
    trigger,
    autoPrint: restaurant.invoiceAutoPrint ?? true,
    einvoicing: isModuleEnabled(restaurant.enabledModules, "einvoicing"),
  });
  if (decision !== "print") return 0;

  const printers = await db.printer.findMany({
    where: invoicePrinterWhere(
      args.restaurantId,
      restaurant.invoicePrinterId ?? null,
    ),
    select: { id: true, paperWidthMm: true, supportsQr: true },
  });
  if (printers.length === 0) return 0;

  // Cómo se pagó. `approved` nada más: un `pending` de efectivo es plata
  // que el comensal DIJO que iba a entregar, y esta tirilla se imprime
  // cuando la cuenta ya está paga.
  const payments = await db.payment.findMany({
    where: { orderId: args.orderId, status: "approved" },
    orderBy: { createdAt: "asc" },
    select: { method: true, amountCents: true, tipCents: true },
  });

  const currency = await getCurrencyForCountry(restaurant.country);
  const dedupeKey =
    trigger === "reprint" ? null : invoiceDedupeKey(args.invoiceId);

  // Una impresora de 58mm y otra de 80mm necesitan documentos distintos
  // (32 vs 48 columnas), y una con QR y otra sin él también: el corte de
  // línea y el QR se deciden al armar el payload, no al imprimir.
  const rows = await Promise.all(
    printers.map(async (printer) => {
      const invoice = await buildInvoiceDocument({
        snapshot: args.snapshot,
        invoiceNumber: args.invoiceNumber,
        paperWidthMm: printer.paperWidthMm ?? restaurant.printPaperWidthMm,
        currency,
        payments,
        locale: args.locale,
        dian: args.dian ?? null,
        supportsQr: printer.supportsQr === true,
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

/**
 * La FACTURA ELECTRÓNICA al papel, en el momento en que la DIAN la acepta.
 *
 * La llaman los dos rieles por los que puede llegar la aceptación —la
 * respuesta síncrona del emit (`dian/emitInvoice.ts`, que cubre el intento
 * inmediato del cobro y el barrido) y la consulta diferida del estado
 * (`dian/documents/[id]/status`)— con el mismo contrato que el correo:
 * NUNCA lanza, y es idempotente por el `dedupeKey` de la factura, así que
 * si los dos ven la aceptación sale UNA hoja.
 *
 * Carga la fila de la tirilla acá (y no recibe el snapshot) porque quien
 * llama sólo tiene el id: el emit ya terminó de firmar y enviar, y lo que
 * sabe de la factura es su CUFE.
 */
export async function printAcceptedDianInvoice(args: {
  simpleInvoiceId: string;
  /** Del caller: una tirilla de otro comercio no se imprime. */
  restaurantId: string;
  cufe: string;
  /** URL de consulta en el catálogo de la DIAN (dato del QR). */
  qrUrl: string;
}): Promise<void> {
  try {
    const inv = await db.simpleInvoice.findUnique({
      where: { id: args.simpleInvoiceId },
      select: {
        id: true,
        restaurantId: true,
        orderId: true,
        invoiceNumber: true,
        snapshot: true,
        order: { select: { locale: true } },
      },
    });
    if (!inv || inv.restaurantId !== args.restaurantId) return;
    const n = await enqueueInvoicePrint({
      ...invoicePrintArgs(inv, inv.order),
      dian: { cufe: args.cufe, qrUrl: args.qrUrl },
      trigger: "dian_accepted",
    });
    if (n > 0) {
      console.log("[print-queue] factura electrónica encolada", {
        restaurantId: args.restaurantId,
        invoiceId: inv.id,
        jobs: n,
      });
    }
  } catch (err) {
    console.error(
      "[print-queue] falló el encolado de la factura electrónica",
      { simpleInvoiceId: args.simpleInvoiceId, err },
    );
  }
}
