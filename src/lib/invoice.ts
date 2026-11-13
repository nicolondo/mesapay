// Renderers + senders para factura simple. La página pública
// `/factura/[id]` consume el mismo snapshot que aparece en el email
// para garantizar que ambos vean exactamente la misma versión.

import { displayOrderCode } from "@/lib/orderCode";
import { fmtCOP, formatDate, localeTag } from "./format";
import { getEmailTranslator } from "./emailIntl";
import { groupInvoiceLines } from "./invoiceLines";

type Translator = Awaited<ReturnType<typeof getEmailTranslator>>["t"];

/**
 * Snapshot guardado en SimpleInvoice.snapshot al momento de emitir.
 * Si el operador cambia logo / NIT / dirección después, la factura
 * ya emitida sigue mostrando el contexto histórico.
 */
export type InvoiceSnapshot = {
  // Identidad del comercio al momento de emitir
  restaurantName: string;
  logoUrl: string | null;
  legalName: string | null;
  taxId: string | null;
  legalAddress: string | null;
  // Ciudad agregada en sprint 7 — facturas anteriores no la tienen
  // en el snapshot. Opcional acá; el renderer lo trata defensivamente.
  legalCity?: string | null;
  legalPhone: string | null;
  dianResolution: string | null;
  dianResolutionFrom: number | null;
  dianResolutionTo: number | null;
  dianResolutionDate: string | null; // ISO
  invoicePrefix: string | null;
  // Estado de la orden al emitir
  shortCode: string;
  tableLabel: string;
  paidAtIso: string;
  // Items vivos al momento de emitir. UNA entrada por OrderItem, como el
  // XML de la DIAN: las representaciones para humanos agrupan los
  // repetidos al LEER (`groupInvoiceLines`, src/lib/invoiceLines.ts), el
  // snapshot no se toca.
  items: Array<{
    qty: number;
    name: string;
    priceCents: number; // unitario
    /**
     * Lo que distingue a dos líneas del mismo plato al agruparlas. Todo
     * opcional: los snapshots anteriores no lo traen y se agrupan por
     * nombre y precio, que es exactamente lo que siempre mostraron.
     * `menuItemId` null = línea libre; `taxKind` null = plato del menú.
     * `modifiers` ya legibles ("Término: Medio") y `notes` tal cual.
     */
    menuItemId?: string | null;
    taxKind?: string | null;
    taxPct?: number | null;
    modifiers?: string[];
    notes?: string | null;
  }>;
  subtotalCents: number;
  /**
   * Impuesto que las LÍNEAS LIBRES (servicios, alquileres, cargos sueltos)
   * suman ENCIMA del subtotal, y su desglose por tipo. Los platos del menú no
   * aportan acá: su impuesto va embebido en el precio, ya contado dentro del
   * subtotal.
   *
   * Opcionales porque las facturas emitidas antes de las líneas libres no los
   * tienen en el snapshot; el renderer omite la fila cuando son 0 o ausentes,
   * así una tirilla vieja se ve exactamente igual que siempre.
   */
  taxCents?: number;
  taxByKind?: { inc: number; iva: number };
  /**
   * Impuesto EMBEBIDO de los platos del menú, CONGELADO con la tarifa del
   * comercio vigente al emitir. Es lo que declara el XML a la DIAN y lo que
   * suma la contabilidad: cambiar la tarifa del comercio después no toca
   * esta factura. `embeddedBaseCents` = Σ bruto de los platos − impuesto
   * (mismo reparto por línea que el XML, ver `dian/discountedLines.ts`).
   * Con `discountInLines` los dos son NETOS del descuento del cliente
   * (como el XML); sin la marca, los del precio de lista.
   *
   * Opcionales: los snapshots anteriores a esto no los tienen y se leen
   * como "sin impuesto embebido" — que es la verdad de cómo se emitieron
   * (ver `frozenSalesTax`). `salesTaxKind: "none"` explícito también vale
   * cero, pero deja constancia de que se emitió así a propósito.
   */
  salesTaxKind?: "none" | "inc" | "iva";
  salesTaxPct?: number;
  embeddedTaxCents?: number;
  embeddedBaseCents?: number;
  // Descuento del comensal identificado. Opcional: las facturas emitidas
  // antes de esta feature no lo tienen y el renderer lo trata como 0.
  discountCents?: number;
  discountPct?: number | null;
  /**
   * El descuento del cliente va DENTRO de las líneas de la factura
   * electrónica (`cac:InvoiceLine/cac:AllowanceCharge`, ver
   * `dian/discountedLines.ts`): cada línea declara su valor neto y el
   * impuesto sobre ese neto. Con esta marca, `embeddedTaxCents` y
   * `embeddedBaseCents` son NETOS del descuento — lo mismo que el XML — y
   * el papel muestra el descuento antes de la base y el impuesto.
   *
   * Ausente con `discountCents` > 0 ⇒ factura anterior al arreglo: el XML
   * que la DIAN aceptó declaró el precio de lista (base e impuesto de más) y
   * el snapshot dice lo mismo. Esas no se reescriben: las lista la revisión
   * «Facturas que declararon el valor sin el descuento del cliente» de
   * Impuestos del período (`undeclaredDiscountOf`).
   */
  discountInLines?: {
    /** Σ de los descuentos de línea declarados, sin impuesto. */
    allowanceCents: number;
    /**
     * Sólo si alguna línea libre con impuesto ENCIMA absorbió descuento (un
     * descuento mayor que todos los platos): lo que esas líneas declaran,
     * por tarifa. Ausente en el caso normal, donde esas líneas quedan como
     * se cobraron y su impuesto es `taxByKind`.
     */
    freeLineTax?: Array<{ kind: "inc" | "iva"; pct: number; baseCents: number; taxCents: number }>;
  };
  tipCents: number;
  totalCents: number;
  // Datos del cliente cuando la factura es PERSONALIZADA (con razón social /
  // documento). null/ausente = tirilla genérica (consumidor final).
  // Dirección/ciudad/departamento: sólo en facturas viejas — la solicitud
  // ya no los pide. Los renderers omiten la línea cuando no hay.
  customer?: {
    name: string;
    docType: string; // CC | CE | NIT | PA
    docNumber: string;
    address?: string | null;
    city?: string | null;
    department?: string | null;
  } | null;
  /**
   * Factura emitida ANTES de cobrar ("Imprimir factura" desde la mesa o el
   * cobro, sin método de pago todavía). Ver `src/lib/preInvoice.ts`:
   *   · la DIAN la recibe con medio de pago "1 – Instrumento no definido";
   *   · el papel dice "Pendiente de pago" (y la propina sugerida) mientras
   *     la cuenta no esté saldada;
   *   · `paidAtIso` es el instante de EMISIÓN, no el del cobro.
   * Ausente/false = la factura de siempre, emitida al cobrar.
   */
  issuedBeforePayment?: boolean;
  /**
   * Los `OrderItem` que cubre la factura emitida antes de cobrar. La cuenta
   * queda cerrada a cambios (ver `orders/invoicedOrder.ts`), y el XML de la
   * DIAN se arma SÓLO con estos ítems: si algo se colara después, no
   * cambiaría en silencio una factura ya numerada.
   */
  orderItemIds?: string[];
};

/** ¿La factura se emitió antes de cobrar la cuenta? */
export function isIssuedBeforePayment(
  snapshot: Pick<InvoiceSnapshot, "issuedBeforePayment"> | null | undefined,
): boolean {
  return snapshot?.issuedBeforePayment === true;
}

/**
 * Los tres renglones con los que cierra TODA representación de la factura
 * (tirilla de la caja, `/factura/[id]` y su impresión, correos y datáfono):
 *
 *   Total factura        ← `invoiceTotalCents`: la VENTA, lo que declara
 *                           el XML (`PayableAmount`). Nunca lleva propina.
 *   Propina voluntaria   ← `tipCents`, sólo si hay.
 *   TOTAL A PAGAR        ← `totalToPayCents` = factura + propina, el
 *                           renglón destacado.
 *
 * El dueño: «el total a pagar, en negrita y en fuente más grande, [tiene
 * que ser] el valor total con la propina» (la factura mostraba sólo la
 * venta y el cliente había pagado más, con la propina).
 *
 * De dónde sale la propina:
 *
 *   · Factura emitida AL COBRAR: la del snapshot. Se emite cuando la cuenta
 *     ya quedó saldada, y entonces `Order.tipCents` (= Σ propinas de los
 *     pagos aprobados, `recomputeOrderTotalsInTx`) ya es la final; el
 *     `totalCents` del snapshot es `Order.totalCents`, que la INCLUYE, así
 *     que la venta es `totalCents − tipCents`.
 *   · Factura emitida ANTES de cobrar (#577): el snapshot no tiene propina
 *     (se decide al pagar) y `totalCents` es la venta sola. La propina es
 *     la REAL de la orden (`order.tipCents`): la de los pagos aprobados
 *     hasta ahora, que con la cuenta saldada es la que dejó el cliente. Sin
 *     la orden (o sin pagos), 0: «Total a pagar» = «Total factura», y la
 *     propina sugerida va aparte, sin sumarse (ver `pendingPaymentOf`).
 *
 * Pura y sin `Intl`: la comparten todas las superficies, cada una con su
 * formato de moneda.
 */
export type InvoicePayable = {
  invoiceTotalCents: number;
  tipCents: number;
  totalToPayCents: number;
};

export function invoicePayableOf(
  snapshot: Pick<InvoiceSnapshot, "totalCents" | "tipCents" | "issuedBeforePayment">,
  /** La orden HOY. Sólo se lee en la factura emitida antes de cobrar. */
  order?: { tipCents?: number | null } | null,
): InvoicePayable {
  if (isIssuedBeforePayment(snapshot)) {
    const invoiceTotalCents = Math.max(0, snapshot.totalCents);
    const tipCents = Math.max(0, order?.tipCents ?? 0);
    return { invoiceTotalCents, tipCents, totalToPayCents: invoiceTotalCents + tipCents };
  }
  const tipCents = Math.max(0, snapshot.tipCents ?? 0);
  const invoiceTotalCents = Math.max(0, snapshot.totalCents - tipCents);
  return { invoiceTotalCents, tipCents, totalToPayCents: invoiceTotalCents + tipCents };
}

/** Etiquetas ya traducidas de `payableRows`. */
export type PayableRowLabels = {
  invoiceTotal: string;
  tip: string;
  totalToPay: string;
};

/**
 * Etiquetas de los renglones finales del catálogo `emailInvoice`. El
 * comprobante (sin factura electrónica aceptada) dice «Total comprobante»
 * en vez de «Total factura»: el rótulo del documento manda.
 */
export function payableLabelsFrom(
  t: (key: string, values?: Record<string, string | number>) => string,
  opts: { einvoice: boolean },
): PayableRowLabels {
  return {
    invoiceTotal: opts.einvoice ? t("invoiceTotal") : t("receiptTotal"),
    tip: t("tipVoluntary"),
    totalToPay: t("totalToPay"),
  };
}

/** Un renglón final. `strong` = el TOTAL A PAGAR (negrita, más grande). */
export type PayableRow = { label: string; cents: number; strong?: true };

/**
 * Los renglones finales en orden: total de la factura, propina (sólo si
 * hay) y TOTAL A PAGAR, el único `strong`. Ver `invoicePayableOf`.
 */
export function payableRows(payable: InvoicePayable, labels: PayableRowLabels): PayableRow[] {
  return [
    { label: labels.invoiceTotal, cents: payable.invoiceTotalCents },
    ...(payable.tipCents > 0 ? [{ label: labels.tip, cents: payable.tipCents }] : []),
    { label: labels.totalToPay, cents: payable.totalToPayCents, strong: true as const },
  ];
}

/**
 * Tarifa CONGELADA en la factura: la que el comercio tenía al emitirla.
 *
 * Es lo que lee la emisión a la DIAN (`dian/emitInvoice`) en vez de
 * `Restaurant.salesTaxKind/Pct`: así el XML y la tirilla salen de la misma
 * cifra, y reintentar una emisión días después —o cambiar la tarifa del
 * comercio— no cambia lo que se declara. Snapshot sin los campos ⇒ "none",
 * NUNCA la tarifa actual del comercio: esas facturas se emitieron sin
 * impuesto embebido y resucitar la tarifa de hoy sería volver a la
 * retroactividad que esto elimina.
 */
export function frozenSalesTax(
  snapshot: Pick<InvoiceSnapshot, "salesTaxKind" | "salesTaxPct">,
): { kind: "none" | "inc" | "iva"; pct: number } {
  const kind = snapshot.salesTaxKind ?? "none";
  if (kind === "none") return { kind: "none", pct: 0 };
  return { kind, pct: snapshot.salesTaxPct ?? 0 };
}

/**
 * Impuesto embebido que la factura declara, o null si no lleva (comercio en
 * "none" al emitir, cuenta sin platos del menú, o snapshot anterior a que
 * se congelara). Con null las superficies no muestran nada: byte a byte
 * como antes.
 */
export function embeddedTaxOf(
  snapshot: InvoiceSnapshot,
): { kind: "inc" | "iva"; pct: number; taxCents: number; baseCents: number } | null {
  const { kind, pct } = frozenSalesTax(snapshot);
  const taxCents = snapshot.embeddedTaxCents ?? 0;
  if (kind === "none" || taxCents <= 0) return null;
  return { kind, pct, taxCents, baseCents: snapshot.embeddedBaseCents ?? 0 };
}

/** ¿La factura declara el descuento del cliente dentro de sus líneas? */
export function declaresDiscountInLines(
  snapshot: Pick<InvoiceSnapshot, "discountInLines"> | null | undefined,
): boolean {
  return snapshot?.discountInLines != null;
}

/** Etiquetas ya traducidas para `taxRows` (ver ahí por qué no el translator). */
export type TaxRowLabels = {
  /** Impuesto que las líneas libres SUMAN encima, por tipo. */
  inc: string;
  iva: string;
  /** Fila genérica para snapshots viejos con total pero sin desglose. */
  other: string;
  /** Base gravable de los platos del menú (bruto − impuesto embebido). */
  base: string;
  /** Impuesto EMBEBIDO en los platos, con su tarifa: "Incl. impoconsumo 8%". */
  incIncluded: (pct: number) => string;
  ivaIncluded: (pct: number) => string;
};

/**
 * Filas de impuesto que la tirilla muestra debajo del subtotal.
 *
 * Dos cosas distintas, en este orden:
 *
 *   1. El impuesto EMBEBIDO en los platos del menú, congelado en el
 *      snapshot (`embeddedTaxOf`): base gravable + "Incl. impoconsumo 8%".
 *      Es informativo —ya está DENTRO del subtotal, no se suma al total—
 *      y es la fila que exige discriminar el impuesto en la factura: el
 *      XML aceptado por la DIAN lo declara, y el papel que ve el cliente
 *      tiene que decir lo mismo. Sin impuesto embebido, ninguna fila.
 *
 *   2. El impuesto que las líneas libres SUMAN encima (`taxByKind`), que
 *      sí entra al total. Se desglosa por tipo porque el punto de las
 *      líneas libres es justamente poder facturar un servicio con IVA en
 *      un restaurante que cobra impoconsumo.
 */
export function taxRows(
  snapshot: InvoiceSnapshot,
  // Etiquetas ya traducidas en vez del translator: la tirilla impresa
  // (`/factura/[id]`, server component de next-intl) y el correo usan
  // traductores de tipos distintos, y así las dos comparten esta lógica.
  labels: TaxRowLabels,
): Array<{ label: string; cents: number }> {
  const rows: Array<{ label: string; cents: number }> = [];
  const embedded = embeddedTaxOf(snapshot);
  if (embedded) {
    rows.push({ label: labels.base, cents: embedded.baseCents });
    rows.push({
      label:
        embedded.kind === "inc"
          ? labels.incIncluded(embedded.pct)
          : labels.ivaIncluded(embedded.pct),
      cents: embedded.taxCents,
    });
  }
  const inc = snapshot.taxByKind?.inc ?? 0;
  const iva = snapshot.taxByKind?.iva ?? 0;
  if (inc > 0) rows.push({ label: labels.inc, cents: inc });
  if (iva > 0) rows.push({ label: labels.iva, cents: iva });
  // Fallback: facturas viejas guardaron el total sin desglose. Se muestra lo
  // que falte como una fila genérica para que subtotal + impuesto + propina
  // siga sumando exactamente el total cobrado.
  const listed = inc + iva;
  const rest = (snapshot.taxCents ?? 0) - listed;
  if (rest > 0) rows.push({ label: labels.other, cents: rest });
  return rows;
}

/**
 * Etiquetas de impuesto del catálogo `emailInvoice`, para `taxRows`.
 * Exportada porque la tirilla térmica, el datáfono y `/factura/[id]` arman
 * las mismas seis etiquetas desde el mismo namespace.
 */
export function taxLabelsFrom(
  t: (key: string, values?: Record<string, string | number>) => string,
): TaxRowLabels {
  return {
    inc: t("taxInc"),
    iva: t("taxIva"),
    other: t("tax"),
    base: t("taxBase"),
    incIncluded: (pct) => t("taxIncIncluded", { pct }),
    ivaIncluded: (pct) => t("taxIvaIncluded", { pct }),
  };
}

/** `TaxRowLabels` + la fila del descuento, para `summaryRows`. */
export type SummaryRowLabels = TaxRowLabels & {
  discount: string;
  discountPct: (pct: number) => string;
};

/** Etiquetas de `summaryRows` del catálogo `emailInvoice` (mismas claves en las cuatro superficies). */
export function summaryLabelsFrom(
  t: (key: string, values?: Record<string, string | number>) => string,
): SummaryRowLabels {
  return {
    ...taxLabelsFrom(t),
    discount: t("discountRow"),
    discountPct: (pct) => t("discountRowPct", { pct }),
  };
}

/** Una fila entre el subtotal y la propina. `negative` = se resta (el descuento). */
export type SummaryRow = { label: string; cents: number; negative?: boolean };

/**
 * Las filas que la factura muestra entre el SUBTOTAL y la PROPINA, en
 * orden: el descuento del cliente y las de impuesto (`taxRows`). Es la
 * única definición para las cuatro superficies (tirilla térmica,
 * `/factura/[id]`, datáfono y correo), así no pueden ordenarse distinto.
 *
 *   · Factura con el descuento EN LAS LÍNEAS (`declaresDiscountInLines`):
 *     primero el descuento y después la base gravable y el impuesto, que
 *     ya son NETOS — es el orden en que se calculan y lo que declara el
 *     XML (Subtotal − Descuento = lo que se cobró; de eso sale la base).
 *   · Factura anterior (o sin descuento): las filas de impuesto y después
 *     el descuento, byte a byte como siempre se imprimieron: su base y su
 *     impuesto son los del precio de lista, que es lo que declararon.
 */
export function summaryRows(
  snapshot: InvoiceSnapshot,
  labels: SummaryRowLabels,
): SummaryRow[] {
  const taxes: SummaryRow[] = taxRows(snapshot, labels);
  const discountCents = snapshot.discountCents ?? 0;
  if (discountCents <= 0) return taxes;
  const discount: SummaryRow = {
    label: snapshot.discountPct ? labels.discountPct(snapshot.discountPct) : labels.discount,
    cents: discountCents,
    negative: true,
  };
  return declaresDiscountInLines(snapshot) ? [discount, ...taxes] : [...taxes, discount];
}

/**
 * Número legal del documento: PREFIJO + CONSECUTIVO pegados, sin
 * separador y sin relleno — "FESM6482".
 *
 * Es el único formato que la DIAN acepta en `cbc:ID`. Antes se armaba
 * como `${prefijo}-${consecutivo padeado al ancho del rango}`
 * ("FESM-06482") y eso provocaba DOS rechazos a la vez, con el
 * consecutivo ya quemado:
 *
 *   · FAD05a — "Número de factura contiene caracteres adicionales como
 *     espacios o guiones": el guión, literal.
 *   · FAD05b — "Número de factura es inferior al número inicial del
 *     rango autorizado": la DIAN le quita el prefijo declarado (FESM) y
 *     lo que queda ("-06482") no lo puede leer como un consecutivo
 *     dentro de 1..10000.
 *
 * El zero-pad era cosmético (convención de tirillas POS) y no tenía
 * ningún consumidor que dependiera del ancho. Se va: el número que sale
 * impreso en la tirilla, el que imprime el datáfono y el que viaja al
 * XML son EL MISMO — un cliente con una tirilla que dice FESM-06482 y un
 * portal de la DIAN que dice FESM6482 es un problema de soporte.
 *
 * Mismo formato que ya usaba el set de pruebas de habilitación
 * (`dian/test-set/route.ts`: `${resolution.prefix}${num}`).
 */
export function formatInvoiceNumber(snapshot: InvoiceSnapshot, n: number): string {
  const numStr = String(n);
  if (snapshot.invoicePrefix) return `${snapshot.invoicePrefix}${numStr}`;
  return numStr;
}

/**
 * Lo que cuelga debajo de un ítem en las representaciones para humanos:
 * sus modificadores ("- Término: Medio") y la nota entre comillas — el
 * mismo formato que la precuenta. Con los repetidos agrupados, es lo que
 * distingue dos líneas del mismo plato. Un snapshot viejo no trae nada.
 */
/**
 * Modificadores y nota del ítem en UN solo renglón, separados por " · "
 * ("Término: 1/2 · Guarniciones: Ensalada fresca · \"sin cebolla\""), sin
 * el guion de `itemDetailLines`. Es el formato COMPACTO de lo que va al
 * papel —la vista `/factura/[id]`, la precuenta y el ESC/POS—, donde cada
 * modificador en su renglón era la mitad del largo de una cuenta grande.
 * Vacío si el ítem no tiene ninguno de los dos.
 */
export function itemDetailText(item: {
  modifiers?: readonly string[] | null;
  notes?: string | null;
}): string {
  const parts = (item.modifiers ?? [])
    .map((m) => m.trim())
    .filter((m) => m.length > 0);
  const note = item.notes?.trim();
  if (note) parts.push(`"${note}"`);
  return parts.join(" · ");
}

export function itemDetailLines(item: {
  modifiers?: readonly string[] | null;
  notes?: string | null;
}): string[] {
  const out = (item.modifiers ?? [])
    .map((m) => m.trim())
    .filter((m) => m.length > 0)
    .map((m) => `- ${m}`);
  const note = item.notes?.trim();
  if (note) out.push(`"${note}"`);
  return out;
}

/**
 * Email HTML completo — frame MESAPAY (Instrument Serif + paleta
 * bone/ink) con la tirilla POS embebida en el body usando solo
 * tablas + estilos inline (Outlook + Gmail seguros). El link a
 * /factura/[id] queda al final como CTA para imprimir bien.
 *
 * Las dimensiones están en píxeles fijos porque los email clients
 * no soportan dvh, vw, fr, grid ni flexbox de forma consistente.
 * Receipt-block ~360px ancho (mimics 80mm). Outer 600px.
 */
export async function renderInvoiceEmail(args: {
  snapshot: InvoiceSnapshot;
  invoiceNumber: number;
  invoiceUrl: string;
  /** Idioma del comensal (Order.locale). null ⇒ default (es). */
  locale?: string | null;
  /**
   * Datos DIAN de la factura electrónica ACEPTADA. Opcionales: si no se
   * pasan (default), el email se renderea exactamente como hoy (módulo
   * apagado o documento aún no aceptado). Cuando se pasan, el correo gana
   * un bloque fiscal con el CUFE y un enlace "Verifica tu factura en la
   * DIAN" al catálogo. Decisión: NO inlineamos el QR como data-URL —
   * Gmail bloquea data-URIs en <img> y el correo se vería roto; el enlace
   * al portal DIAN + CUFE en texto es más robusto entre clientes.
   */
  cufe?: string;
  dianQrUrl?: string;
  /**
   * La orden HOY, sólo para la factura emitida ANTES de cobrar: su propina
   * REAL (para el TOTAL A PAGAR, ver `invoicePayableOf`) y si ya se saldó
   * (si no, el resumen dice "Total a pagar" y no "Total pagado").
   */
  order?: { tipCents: number; paid: boolean } | null;
}): Promise<{ subject: string; html: string; text: string }> {
  const { snapshot, invoiceNumber, invoiceUrl, cufe, dianQrUrl } = args;
  const { t, locale } = await getEmailTranslator(args.locale, "emailInvoice");
  const tag = localeTag(locale);
  const numberStr = formatInvoiceNumber(snapshot, invoiceNumber);
  const merchantName =
    snapshot.legalName?.trim() || snapshot.restaurantName;
  const brandName = snapshot.restaurantName;
  const subject = t("subject", { brand: brandName, number: numberStr });
  const paidAt = new Date(snapshot.paidAtIso);
  const dianDate = snapshot.dianResolutionDate
    ? new Date(snapshot.dianResolutionDate)
    : null;
  // Formato compacto sin "p. m." — los locales con am/pm meten espacios
  // dentro del time que rompen línea en viewports angostos del
  // correo. 24h + middle-dot queda limpio y MESAPAY-style.
  const fechaStr = formatDate(paidAt, {
    locale,
    dateStyle: undefined,
    timeStyle: undefined,
    day: "2-digit",
    month: "2-digit",
    year: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).replace(", ", " · ");
  const dianDateStr = dianDate
    ? dianDate.toLocaleDateString(tag)
    : null;
  // Total comprobante, propina voluntaria y TOTAL A PAGAR (factura +
  // propina cobrada). Este correo es el COMPROBANTE: con facturación
  // electrónica no sale (ver `invoiceDelivery.ts`).
  const payable = invoicePayableOf(snapshot, args.order);
  const finalRows = payableRows(payable, payableLabelsFrom(t, { einvoice: false }));
  const unpaid = isIssuedBeforePayment(snapshot) && args.order?.paid !== true;

  // Texto plano fallback — clientes sin HTML support, screen readers.
  const text = [
    `${merchantName}`,
    snapshot.taxId ? t("taxId", { id: snapshot.taxId }) : "",
    snapshot.legalAddress ?? "",
    snapshot.legalCity ?? "",
    snapshot.legalPhone ? t("phone", { phone: snapshot.legalPhone }) : "",
    "",
    `${t("receiptLabel")} ${numberStr}`,
    `${t("date")}: ${fechaStr}`,
    `${snapshot.tableLabel}  ${displayOrderCode(snapshot.shortCode)}`,
    "",
    // Repetidos AGRUPADOS, igual que en el papel (ver invoiceLines.ts).
    ...groupInvoiceLines(snapshot.items).flatMap((i) => [
      `${i.qty}× ${i.name}  ${fmtCOP(i.totalCents)}`,
      ...itemDetailLines(i).map((d) => `   ${d}`),
    ]),
    "",
    `${t("subtotal")}: ${fmtCOP(snapshot.subtotalCents)}`,
    // Descuento y filas de impuesto, en el orden de la factura (antes el
    // correo no mostraba el descuento y el total no cuadraba a la vista).
    ...summaryRows(snapshot, summaryLabelsFrom(t)).map(
      (r) => `${r.label}: ${r.negative ? "-" : ""}${fmtCOP(r.cents)}`,
    ),
    ...finalRows.map((r) => `${r.label}: ${fmtCOP(r.cents)}`),
    "",
    snapshot.dianResolution
      ? t("dianResolution", { res: snapshot.dianResolution })
      : "",
    snapshot.dianResolutionFrom != null && snapshot.dianResolutionTo != null
      ? t("dianNumbering", {
          from: snapshot.dianResolutionFrom,
          to: snapshot.dianResolutionTo,
        })
      : "",
    dianDateStr ? t("dianDate", { date: dianDateStr }) : "",
    "",
    // Bloque fiscal DIAN (solo si la factura electrónica fue aceptada).
    cufe ? t("dianFiscalTitle") : "",
    cufe ? `${t("dianCufeLabel")}: ${cufe}` : "",
    cufe && dianQrUrl ? `${t("dianVerifyCta")}: ${dianQrUrl}` : "",
    "",
    t("printText"),
    invoiceUrl,
    "",
    t("tipNoticeTitle"),
    t("tipNoticeBody"),
    t("thanks"),
  ]
    .filter((l) => l !== "")
    .join("\n");

  const html = renderHtml({
    t,
    locale,
    snapshot,
    finalRows,
    summary: {
      label: unpaid ? t("totalToPay") : t("totalPaid"),
      cents: payable.totalToPayCents,
    },
    numberStr,
    merchantName,
    brandName,
    fechaStr,
    dianDateStr,
    invoiceUrl,
    cufe,
    dianQrUrl,
  });

  return { subject, html, text };
}

function renderHtml(args: {
  t: Translator;
  locale: string;
  snapshot: InvoiceSnapshot;
  /** Total comprobante, propina voluntaria y TOTAL A PAGAR (`payableRows`). */
  finalRows: PayableRow[];
  /** El monto grande del resumen de arriba: el TOTAL A PAGAR. */
  summary: { label: string; cents: number };
  numberStr: string;
  merchantName: string;
  brandName: string;
  fechaStr: string;
  dianDateStr: string | null;
  invoiceUrl: string;
  cufe?: string;
  dianQrUrl?: string;
}): string {
  const { t, locale, snapshot, finalRows, summary, numberStr, merchantName, brandName, fechaStr, dianDateStr, invoiceUrl, cufe, dianQrUrl } = args;

  // Items como filas de tabla — más resistente que divs en Outlook. Los
  // repetidos AGRUPADOS ("2× Bretaña"), con los modificadores y la nota
  // debajo del nombre, igual que en el papel (ver invoiceLines.ts).
  const itemRows = groupInvoiceLines(snapshot.items)
    .map((i) => {
      const details = itemDetailLines(i)
        .map(
          (d) =>
            `<div style="font-size:11px;color:#3A332B;padding-top:1px;">${escapeHtml(d)}</div>`,
        )
        .join("");
      return `
        <tr>
          <td style="padding:4px 0;font-family:'SF Mono','Menlo','Consolas',monospace;font-size:12px;color:#000;width:32px;text-align:left;vertical-align:top;">${i.qty}×</td>
          <td style="padding:4px 6px;font-family:'SF Mono','Menlo','Consolas',monospace;font-size:12px;color:#000;vertical-align:top;">${escapeHtml(i.name)}${details}</td>
          <td style="padding:4px 0;font-family:'SF Mono','Menlo','Consolas',monospace;font-size:12px;color:#000;text-align:right;vertical-align:top;white-space:nowrap;">${fmtCOP(i.totalCents)}</td>
        </tr>`;
    })
    .join("");

  // Línea punteada — span lleno con borde inferior. Más confiable
  // que <hr> en Outlook (que lo renderea con padding raro).
  const dashed = `<div style="border-bottom:1px dashed #000;height:1px;margin:10px 0;line-height:0;font-size:0;">&nbsp;</div>`;

  // Bloque fiscal DIAN dentro de la tirilla del email — solo si la
  // factura electrónica fue aceptada (cufe presente). Sin QR inline
  // (Gmail lo bloquea): CUFE en texto + enlace al catálogo DIAN.
  const dianFiscalBlock = cufe
    ? `
                  ${dashed}
                  <div style="text-align:center;font-family:'SF Mono','Menlo',monospace;color:#000;">
                    <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.04em;margin-bottom:6px;">${escapeHtml(t("dianFiscalTitle"))}</div>
                    <div style="font-size:9px;text-transform:uppercase;letter-spacing:0.08em;opacity:0.7;">${escapeHtml(t("dianCufeLabel"))}</div>
                    <div style="font-size:9px;line-height:1.4;word-break:break-all;margin:2px 0 8px 0;">${escapeHtml(cufe)}</div>
                    ${
                      dianQrUrl
                        ? `<a href="${escapeHtml(dianQrUrl)}" style="font-family:-apple-system,BlinkMacSystemFont,'Helvetica Neue',Arial,sans-serif;font-size:11px;color:#1A1613;text-decoration:underline;">${escapeHtml(t("dianVerifyCta"))}</a>`
                        : ""
                    }
                  </div>`
    : "";

  const logoSrc =
    snapshot.logoUrl && snapshot.logoUrl.trim()
      ? snapshot.logoUrl.startsWith("http")
        ? snapshot.logoUrl
        : `https://mesapay.co${snapshot.logoUrl}`
      : "https://mesapay.co/icons/icon-192.png";

  // Paleta MESAPAY (mismos tokens que globals.css):
  //   bone     #F5F1EA  → fondo exterior del email
  //   paper    #FBF8F3  → card que envuelve TODO el contenido,
  //                       incluida la tirilla (sin sub-recuadro
  //                       blanco — se ve como una sola superficie
  //                       limpia, no anidada).
  //   ink      #1A1613  → tipografía y CTA
  //   hairline #E5DED1  → separadores muy finos donde hace falta
  //
  // `color-scheme: light only` + `supported-color-schemes: light only`
  // bloquean la inversión auto que hace Gmail/Outlook en dark mode.
  return `<!doctype html>
<html lang="${locale}">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<meta name="color-scheme" content="light only" />
<meta name="supported-color-schemes" content="light only" />
<title>${escapeHtml(t("docTitle", { number: numberStr, brand: brandName }))}</title>
<style>
  :root { color-scheme: light only; supported-color-schemes: light only; }
  /* La tirilla hereda el bg del card para que no se vea anidada;
     este selector específico lo refuerza contra clientes que
     ignoran inline bg en tablas. */
  .mp-receipt { background:#FBF8F3 !important; }
</style>
</head>
<body style="margin:0;padding:0;background:#F5F1EA;font-family:-apple-system,BlinkMacSystemFont,'Helvetica Neue',Arial,sans-serif;color:#1A1613;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#F5F1EA;padding:32px 12px;">
  <tr>
    <td align="center">
      <!-- Outer card -->
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%;background:#FBF8F3;border:1px solid #E5DED1;border-radius:18px;overflow:hidden;">

        <!-- Header MESAPAY style -->
        <tr>
          <td style="padding:32px 36px 4px 36px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td style="font-family:'SF Mono','Menlo',monospace;font-size:10px;letter-spacing:0.18em;text-transform:uppercase;color:#8B7B65;">
                  ${escapeHtml(t("receiptLabel"))} · ${escapeHtml(numberStr)}
                </td>
                <td align="right" style="font-family:'SF Mono','Menlo',monospace;font-size:10px;letter-spacing:0.14em;text-transform:uppercase;color:#B8A98D;">
                  MESAPAY
                </td>
              </tr>
            </table>
            <h1 style="font-family:'Instrument Serif','Times New Roman',Georgia,serif;font-size:32px;line-height:1.1;margin:14px 0 6px 0;color:#1A1613;font-weight:400;letter-spacing:-0.015em;">
              ${escapeHtml(brandName)}
            </h1>
            <p style="font-size:14px;line-height:1.5;color:#3A332B;margin:0 0 4px 0;">
              ${escapeHtml(t("emailIntro"))}
            </p>
          </td>
        </tr>

        <!-- Resumen visual: total destacado.
             Columnas alineadas TOP, ambas con misma estructura
             (label uppercase mono + valor serif/mono). Evita el
             cramping que pasaba antes con 3 líneas apiladas a la
             derecha contra el total a la izquierda. -->
        <tr>
          <td style="padding:18px 36px 6px 36px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-top:1px solid #E5DED1;border-bottom:1px solid #E5DED1;">
              <tr>
                <td valign="top" style="padding:18px 0;">
                  <div style="font-family:'SF Mono','Menlo',monospace;font-size:10px;letter-spacing:0.14em;text-transform:uppercase;color:#8B7B65;margin:0 0 6px 0;">${escapeHtml(summary.label)}</div>
                  <div style="font-family:'Instrument Serif','Times New Roman',Georgia,serif;font-size:36px;color:#1A1613;line-height:1;white-space:nowrap;">${fmtCOP(summary.cents)}</div>
                  <div style="font-family:'SF Mono','Menlo',monospace;font-size:11px;color:#8B7B65;margin-top:8px;white-space:nowrap;">${escapeHtml(fechaStr)}</div>
                </td>
                <td valign="top" align="right" style="padding:18px 0;">
                  <div style="font-family:'SF Mono','Menlo',monospace;font-size:10px;letter-spacing:0.14em;text-transform:uppercase;color:#8B7B65;margin:0 0 6px 0;">${escapeHtml(t("table"))}</div>
                  <div style="font-family:'Instrument Serif','Times New Roman',Georgia,serif;font-size:22px;color:#1A1613;line-height:1.1;">${escapeHtml(snapshot.tableLabel)}</div>
                  <div style="font-family:'SF Mono','Menlo',monospace;font-size:11px;color:#8B7B65;margin-top:8px;white-space:nowrap;">${escapeHtml(displayOrderCode(snapshot.shortCode))}</div>
                </td>
              </tr>
            </table>
          </td>
        </tr>

        <!-- Tirilla POS embebida -->
        <tr>
          <td style="padding:22px 36px 8px 36px;">
            <div style="font-family:'SF Mono','Menlo',monospace;font-size:10px;letter-spacing:0.14em;text-transform:uppercase;color:#8B7B65;margin:0 0 10px 0;">
              ${escapeHtml(t("yourReceipt"))}
            </div>
            <table class="mp-receipt" role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" bgcolor="#FBF8F3" style="width:100%;max-width:380px;background:#FBF8F3;">
              <tr>
                <td style="padding:18px 16px;">
                  <!-- Logo + razón social -->
                  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                    <tr>
                      <td align="center" style="padding:0 0 8px 0;">
                        <img src="${escapeHtml(logoSrc)}" width="56" height="56" alt="${escapeHtml(brandName)}" style="display:block;margin:0 auto;max-width:56px;max-height:56px;object-fit:contain;" />
                      </td>
                    </tr>
                    <tr>
                      <td align="center" style="padding:0 0 2px 0;font-family:'SF Mono','Menlo',monospace;font-size:14px;font-weight:700;color:#000;text-transform:uppercase;line-height:1.3;">
                        ${escapeHtml(merchantName)}
                      </td>
                    </tr>
                    ${
                      snapshot.taxId
                        ? `<tr><td align="center" style="padding:1px 0;font-family:'SF Mono','Menlo',monospace;font-size:11px;color:#000;">${escapeHtml(t("taxId", { id: snapshot.taxId }))}</td></tr>`
                        : ""
                    }
                    ${
                      snapshot.legalAddress
                        ? `<tr><td align="center" style="padding:1px 0;font-family:'SF Mono','Menlo',monospace;font-size:11px;color:#000;">${escapeHtml(snapshot.legalAddress)}</td></tr>`
                        : ""
                    }
                    ${
                      snapshot.legalCity
                        ? `<tr><td align="center" style="padding:1px 0;font-family:'SF Mono','Menlo',monospace;font-size:11px;color:#000;">${escapeHtml(snapshot.legalCity)}</td></tr>`
                        : ""
                    }
                    ${
                      snapshot.legalPhone
                        ? `<tr><td align="center" style="padding:1px 0;font-family:'SF Mono','Menlo',monospace;font-size:11px;color:#000;">${escapeHtml(t("phone", { phone: snapshot.legalPhone }))}</td></tr>`
                        : ""
                    }
                  </table>

                  ${dashed}

                  <!-- Comprobante meta -->
                  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                    <tr>
                      <td style="font-family:'SF Mono','Menlo',monospace;font-size:12px;color:#000;padding:2px 0;">${escapeHtml(t("receiptLabel"))}</td>
                      <td align="right" style="font-family:'SF Mono','Menlo',monospace;font-size:12px;color:#000;padding:2px 0;font-weight:700;">${escapeHtml(numberStr)}</td>
                    </tr>
                    <tr>
                      <td style="font-family:'SF Mono','Menlo',monospace;font-size:12px;color:#000;padding:2px 0;">${escapeHtml(t("date"))}</td>
                      <td align="right" style="font-family:'SF Mono','Menlo',monospace;font-size:12px;color:#000;padding:2px 0;">${escapeHtml(fechaStr)}</td>
                    </tr>
                    <tr>
                      <td style="font-family:'SF Mono','Menlo',monospace;font-size:12px;color:#000;padding:2px 0;">${escapeHtml(snapshot.tableLabel)}</td>
                      <td align="right" style="font-family:'SF Mono','Menlo',monospace;font-size:12px;color:#000;padding:2px 0;">${escapeHtml(displayOrderCode(snapshot.shortCode))}</td>
                    </tr>
                  </table>

                  ${dashed}

                  <!-- Items -->
                  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                    ${itemRows}
                  </table>

                  ${dashed}

                  <!-- Totales -->
                  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                    <tr>
                      <td style="font-family:'SF Mono','Menlo',monospace;font-size:12px;color:#000;padding:2px 0;">${escapeHtml(t("subtotal"))}</td>
                      <td align="right" style="font-family:'SF Mono','Menlo',monospace;font-size:12px;color:#000;padding:2px 0;">${fmtCOP(snapshot.subtotalCents)}</td>
                    </tr>
                    ${summaryRows(snapshot, summaryLabelsFrom(t))
                      .map(
                        (r) =>
                          `<tr><td style="font-family:'SF Mono','Menlo',monospace;font-size:12px;color:#000;padding:2px 0;">${escapeHtml(r.label)}</td><td align="right" style="font-family:'SF Mono','Menlo',monospace;font-size:12px;color:#000;padding:2px 0;">${r.negative ? "-" : ""}${fmtCOP(r.cents)}</td></tr>`,
                      )
                      .join("")}
                    ${finalRows
                      .map((r) =>
                        r.strong
                          ? // El TOTAL A PAGAR: negrita y más grande que el resto.
                            `<tr><td style="font-family:'SF Mono','Menlo',monospace;font-size:16px;font-weight:700;color:#000;padding:8px 0 2px 0;border-top:1px solid #000;">${escapeHtml(r.label)}</td><td align="right" style="font-family:'SF Mono','Menlo',monospace;font-size:16px;font-weight:700;color:#000;padding:8px 0 2px 0;border-top:1px solid #000;white-space:nowrap;">${fmtCOP(r.cents)}</td></tr>`
                          : `<tr><td style="font-family:'SF Mono','Menlo',monospace;font-size:12px;color:#000;padding:2px 0;">${escapeHtml(r.label)}</td><td align="right" style="font-family:'SF Mono','Menlo',monospace;font-size:12px;color:#000;padding:2px 0;">${fmtCOP(r.cents)}</td></tr>`,
                      )
                      .join("")}
                  </table>
                  ${dianFiscalBlock}

                  ${dashed}

                  <div style="font-family:'SF Mono','Menlo',monospace;font-size:11px;color:#000;line-height:1.5;text-align:left;margin-bottom:12px;">
                    <strong style="display:block;text-align:center;margin-bottom:6px;">${escapeHtml(t("tipNoticeTitle"))}</strong>
                    ${escapeHtml(t("tipNoticeBody"))}
                  </div>

                  <!-- Footer DIAN -->
                  <div style="text-align:center;font-family:'SF Mono','Menlo',monospace;font-size:10px;color:#000;line-height:1.5;">
                    ${snapshot.dianResolution ? `${escapeHtml(t("dianResolution", { res: snapshot.dianResolution }))}<br />` : ""}
                    ${
                      snapshot.dianResolutionFrom != null && snapshot.dianResolutionTo != null
                        ? `${escapeHtml(t("dianNumbering", { from: snapshot.dianResolutionFrom, to: snapshot.dianResolutionTo }))}<br />`
                        : ""
                    }
                    ${dianDateStr ? `${escapeHtml(t("dianDate", { date: dianDateStr }))}<br />` : ""}
                  </div>
                  <div style="text-align:center;font-family:'SF Mono','Menlo',monospace;font-size:11px;color:#000;margin-top:10px;">
                    ${escapeHtml(t("thanks"))}
                  </div>
                </td>
              </tr>
            </table>
          </td>
        </tr>

        <!-- CTA imprimir -->
        <tr>
          <td align="center" style="padding:22px 36px 8px 36px;">
            <p style="font-size:13px;color:#3A332B;line-height:1.5;margin:0 0 14px 0;">
              ${escapeHtml(t("printLead"))}
            </p>
            <a href="${escapeHtml(invoiceUrl)}" style="display:inline-block;background:#1A1613;color:#F5F1EA;text-decoration:none;padding:14px 28px;border-radius:999px;font-weight:500;font-size:14px;font-family:-apple-system,BlinkMacSystemFont,'Helvetica Neue',Arial,sans-serif;letter-spacing:0.01em;">
              ${escapeHtml(t("printCta"))}
            </a>
          </td>
        </tr>

        <!-- Footer -->
        <tr>
          <td style="padding:24px 36px 28px 36px;border-top:1px solid #E5DED1;margin-top:12px;">
            <p style="font-size:12px;color:#8B7B65;line-height:1.5;margin:0;text-align:center;">
              ${t("footerHelp", { brand: `<strong style="color:#1A1613;">${escapeHtml(brandName)}</strong>` })}
            </p>
          </td>
        </tr>
      </table>

      <!-- Brand footer -->
      <div style="font-family:'SF Mono','Menlo',monospace;font-size:10px;letter-spacing:0.18em;text-transform:uppercase;color:#B8A98D;margin-top:16px;">
        ${escapeHtml(t("sentBy"))}
      </div>
    </td>
  </tr>
</table>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
