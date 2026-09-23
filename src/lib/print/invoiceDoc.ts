/**
 * Del snapshot de la factura al documento térmico.
 *
 * Es la traducción entre lo que se EMITIÓ (`SimpleInvoice.snapshot`, el
 * mismo objeto que ven el correo y la página `/factura/[id]`) y lo que se
 * IMPRIME (`ThermalInvoice`, puro texto ya resuelto). Acá se decide qué
 * lleva la tirilla; el renderer de `escpos/invoice.ts` sólo la dibuja.
 *
 * Es SÍNCRONO y recibe el traductor por parámetro en vez de resolverlo
 * adentro. Suena rebuscado y no lo es: así se puede testear qué filas
 * salen —el descuento que aparece sólo si es > 0, el impuesto que en una
 * cuenta de puro menú NO va porque ya está embebido en el precio, la
 * factura nominativa vs. la de consumidor final— sin catálogos, sin DB y
 * sin request. La versión que sí resuelve idioma y moneda vive en
 * `invoiceQueue.ts`, que es la que toca la base.
 *
 * Las etiquetas salen del namespace `emailInvoice` a propósito: es el
 * mismo documento que le llega al cliente por correo, y si el papel y el
 * mail se nombran distinto ("Comprobante" acá, "Factura" allá) el que
 * queda mal parado frente al cliente es el comercio.
 *
 * Con `dian` (la factura ya ACEPTADA por la DIAN) el mismo snapshot se
 * vuelve la FACTURA ELECTRÓNICA: cambia el rótulo, el adquiriente sin
 * datos pasa a decir "Consumidor final" y se agrega el bloque fiscal con
 * el CUFE y el QR (o la URL de consulta). Todo lo demás —ítems, totales,
 * impuesto discriminado, forma de pago, resolución— es idéntico: es la
 * misma venta.
 */

import { displayOrderCode } from "@/lib/orderCode";
import { groupInvoiceLines } from "@/lib/invoiceLines";
import {
  formatInvoiceNumber,
  taxLabelsFrom,
  taxRows,
  type InvoiceSnapshot,
} from "@/lib/invoice";
import type {
  ThermalInvoice,
  ThermalInvoiceFiscal,
  ThermalInvoiceRow,
} from "@/lib/escpos";

/** Lo mínimo que necesita el documento de cada pago cobrado. */
export type InvoicePaymentLine = {
  method: string;
  /** Porción de comida/impuesto: `Payment.amountCents` NO incluye propina. */
  amountCents: number;
  tipCents: number;
};

/**
 * `PaymentMethod` (enum de Prisma) → clave del catálogo. Se agrupa por lo
 * que el CLIENTE reconoce, no por el riel técnico: quien paga con Apple
 * Pay y quien paga con Google Pay leen lo mismo, y a nadie le dice nada
 * que su tarjeta haya entrado por Wompi o por Kushki.
 */
const PAYMENT_METHOD_KEY: Record<string, string> = {
  demo_cash: "methodCash",
  demo_card: "methodCard",
  wompi_card: "methodCard",
  kushki_card: "methodCard",
  kushki_apple_pay: "methodWallet",
  kushki_google_pay: "methodWallet",
  kushki_card_terminal: "methodCardTerminal",
  external_terminal: "methodExternalTerminal",
  wompi_pse: "methodPse",
  kushki_pse: "methodPse",
  wompi_nequi: "methodNequi",
  reservation_deposit: "methodDeposit",
  voucher: "methodVoucher",
  customer_credit: "methodCustomerCredit",
};

/** Traductor mínimo — `createTranslator` de next-intl encaja tal cual. */
export type InvoiceTranslator = (
  key: string,
  values?: Record<string, string | number>,
) => string;

/**
 * Lo que vuelve al documento una factura ELECTRÓNICA. `qr` es de la
 * IMPRESORA destino (`Printer.supportsQr`), no de la factura: la misma
 * factura sale con QR en una térmica y con la URL en texto en otra.
 */
export type InvoiceDianDocData = {
  cufe: string;
  /** URL de consulta en el catálogo de la DIAN. */
  verifyUrl: string;
  qr: boolean;
};

/**
 * Suma los pagos por método, en orden de aparición. Una cuenta partida
 * entre tres tarjetas no gasta tres renglones: dice "Tarjeta $90.000",
 * que es lo que el cliente puede verificar contra su bolsillo.
 *
 * El importe de cada pago es `amountCents + tipCents`: la propina viaja
 * aparte en la fila del pago pero salió del mismo bolsillo, y sin sumarla
 * los pagos no cerrarían contra el TOTAL de la tirilla.
 */
export function paymentRowsFor(
  payments: InvoicePaymentLine[],
  t: InvoiceTranslator,
  money: (cents: number) => string,
): ThermalInvoiceRow[] {
  const order: string[] = [];
  const byKey = new Map<string, number>();
  for (const p of payments) {
    const key = PAYMENT_METHOD_KEY[p.method] ?? "methodOther";
    if (!byKey.has(key)) order.push(key);
    byKey.set(key, (byKey.get(key) ?? 0) + p.amountCents + p.tipCents);
  }
  return order.map((key) => ({
    label: t(key),
    amount: money(byKey.get(key) ?? 0),
  }));
}

export function buildThermalInvoice(args: {
  snapshot: InvoiceSnapshot;
  invoiceNumber: number;
  paperWidthMm: number;
  /** Fecha del pago YA formateada en el idioma y la zona del comercio. */
  paidAtLabel: string;
  /** Fecha de la resolución DIAN ya formateada, si el comercio la cargó. */
  dianResolutionDateLabel: string | null;
  payments: InvoicePaymentLine[];
  money: (cents: number) => string;
  t: InvoiceTranslator;
  /** Factura electrónica ACEPTADA. null/ausente = el comprobante. */
  dian?: InvoiceDianDocData | null;
}): ThermalInvoice {
  const { snapshot: s, money, t } = args;
  const dian = args.dian ?? null;

  const businessLines = [
    s.taxId ? t("taxId", { id: s.taxId }) : null,
    s.legalAddress ?? null,
    s.legalCity ?? null,
    s.legalPhone ? t("phone", { phone: s.legalPhone }) : null,
  ].filter((l): l is string => !!l && l.trim().length > 0);

  // Factura nominativa: los datos del cliente sólo existen cuando pidió
  // la factura a su nombre. Sin ellos es una tirilla a consumidor final y
  // el bloque entero desaparece — no se imprime "Cliente: —"... salvo en
  // la factura ELECTRÓNICA, donde el adquiriente es parte del documento
  // y "Consumidor final" es lo que dice el XML que viajó a la DIAN.
  const customerLines: string[] = [];
  if (s.customer) {
    customerLines.push(`${t("customerLabel")}: ${s.customer.name}`);
    customerLines.push(`${s.customer.docType} ${s.customer.docNumber}`);
    const where = [s.customer.address, s.customer.city]
      .filter((p): p is string => !!p && p.trim().length > 0)
      .join(", ");
    if (where) customerLines.push(where);
  } else if (dian) {
    customerLines.push(`${t("customerLabel")}: ${t("finalConsumer")}`);
  }

  const totals: ThermalInvoiceRow[] = [
    { label: t("subtotal"), amount: money(s.subtotalCents) },
  ];
  // Primero el impuesto EMBEBIDO en los platos (base gravable + "Incl.
  // impoconsumo 8%": informativo, ya está dentro del subtotal) tal como
  // quedó congelado en la factura, y después el que suman ENCIMA las
  // líneas libres. Sin impuesto embebido ni líneas libres no hay filas.
  for (const row of taxRows(s, taxLabelsFrom(t))) {
    totals.push({ label: row.label, amount: money(row.cents) });
  }
  const discountCents = s.discountCents ?? 0;
  if (discountCents > 0) {
    totals.push({
      label: s.discountPct
        ? t("discountRowPct", { pct: s.discountPct })
        : t("discountRow"),
      amount: "-" + money(discountCents),
    });
  }
  if (s.tipCents > 0) {
    totals.push({ label: t("tip"), amount: money(s.tipCents) });
  }
  totals.push({
    label: t("total"),
    amount: money(s.totalCents),
    strong: true,
  });

  const paymentRows = paymentRowsFor(args.payments, t, money);

  const footerLines = [
    s.dianResolution ? t("dianResolution", { res: s.dianResolution }) : null,
    s.dianResolutionFrom != null && s.dianResolutionTo != null
      ? t("dianNumbering", { from: s.dianResolutionFrom, to: s.dianResolutionTo })
      : null,
    args.dianResolutionDateLabel
      ? t("dianDate", { date: args.dianResolutionDateLabel })
      : null,
    t("tipNoticeTitle"),
    t("tipNoticeBody"),
    t("thanks"),
  ].filter((l): l is string => !!l);

  // El bloque fiscal sólo existe con la factura aceptada. El CUFE va
  // entero (el cliente lo teclea en el portal si el QR no le sirve) y la
  // URL en texto sólo cuando NO hay QR: es la misma información dos
  // veces, y en 58mm son tres renglones de sopa de letras.
  const fiscal: ThermalInvoiceFiscal | null = dian
    ? {
        cufeLabel: t("dianCufeLabel"),
        cufe: dian.cufe,
        verifyUrl: dian.verifyUrl,
        qr: dian.qr,
        verifyLabel: t("einvoiceVerify"),
        noticeLines: [t("einvoiceRepresentation")],
      }
    : null;

  return {
    paperWidthMm: args.paperWidthMm,
    businessName: s.legalName?.trim() || s.restaurantName,
    businessLines,
    documentLabel: dian ? t("einvoiceLabel") : t("receiptLabel"),
    documentNumber: formatInvoiceNumber(s, args.invoiceNumber),
    metaRows: [
      { label: t("date"), value: args.paidAtLabel },
      { label: s.tableLabel, value: displayOrderCode(s.shortCode) },
    ],
    customerLines,
    // Los repetidos AGRUPADOS ("2x Bretaña"): el papel es para una
    // persona. El XML de la DIAN sigue con una línea por ítem, y la suma
    // de los importes agrupados es la misma al centavo.
    items: groupInvoiceLines(s.items).map((i) => ({
      qty: i.qty,
      name: i.name,
      amount: money(i.totalCents),
      ...(i.modifiers && i.modifiers.length > 0 && { modifiers: i.modifiers }),
      ...(i.notes && { notes: i.notes }),
    })),
    totals,
    paymentTitle: paymentRows.length > 0 ? t("paymentTitle") : null,
    paymentRows,
    footerLines,
    fiscal,
  };
}
