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
 */

import { formatInvoiceNumber, taxRows, type InvoiceSnapshot } from "@/lib/invoice";
import type {
  ThermalInvoice,
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
};

/** Traductor mínimo — `createTranslator` de next-intl encaja tal cual. */
export type InvoiceTranslator = (
  key: string,
  values?: Record<string, string | number>,
) => string;

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
}): ThermalInvoice {
  const { snapshot: s, money, t } = args;

  const businessLines = [
    s.taxId ? t("taxId", { id: s.taxId }) : null,
    s.legalAddress ?? null,
    s.legalCity ?? null,
    s.legalPhone ? t("phone", { phone: s.legalPhone }) : null,
  ].filter((l): l is string => !!l && l.trim().length > 0);

  // Factura nominativa: los datos del cliente sólo existen cuando pidió
  // la factura a su nombre. Sin ellos es una tirilla a consumidor final y
  // el bloque entero desaparece — no se imprime "Cliente: —".
  const customerLines: string[] = [];
  if (s.customer) {
    customerLines.push(`${t("customerLabel")}: ${s.customer.name}`);
    customerLines.push(`${s.customer.docType} ${s.customer.docNumber}`);
    const where = [s.customer.address, s.customer.city]
      .filter((p) => p && p.trim().length > 0)
      .join(", ");
    if (where) customerLines.push(where);
  }

  const totals: ThermalInvoiceRow[] = [
    { label: t("subtotal"), amount: money(s.subtotalCents) },
  ];
  // Impuesto que suman ENCIMA las líneas libres. En una cuenta de puro
  // menú no hay filas: ahí va embebido en el precio y ya está contado en
  // el subtotal, así que una fila aparte parecería un cobro doble.
  for (const row of taxRows(s, {
    inc: t("taxInc"),
    iva: t("taxIva"),
    other: t("tax"),
  })) {
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
    t("thanks"),
  ].filter((l): l is string => !!l);

  return {
    paperWidthMm: args.paperWidthMm,
    businessName: s.legalName?.trim() || s.restaurantName,
    businessLines,
    documentLabel: t("receiptLabel"),
    documentNumber: formatInvoiceNumber(s, args.invoiceNumber),
    metaRows: [
      { label: t("date"), value: args.paidAtLabel },
      { label: s.tableLabel, value: s.shortCode },
    ],
    customerLines,
    items: s.items.map((i) => ({
      qty: i.qty,
      name: i.name,
      amount: money(i.qty * i.priceCents),
    })),
    totals,
    paymentTitle: paymentRows.length > 0 ? t("paymentTitle") : null,
    paymentRows,
    footerLines,
  };
}
