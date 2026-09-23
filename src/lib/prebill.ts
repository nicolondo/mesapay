/**
 * PRECUENTA — lógica pura, sin DB ni i18n.
 *
 * Es el papel que el mesero lleva a la mesa ANTES de cobrar: el detalle
 * del consumo y lo que falta pagar. No es una factura y no numera nada:
 * la factura (y la electrónica a la DIAN) nace recién cuando la cuenta
 * queda pagada (`issueSimpleInvoice`). Por eso se arma desde la cuenta
 * VIVA y no desde un snapshot: si en el medio le suman un postre, la
 * próxima precuenta lo trae.
 *
 * Acá se decide QUÉ dice la precuenta —qué ítems entran, cómo se llega al
 * total, cuánto es la propina sugerida— en números. Las dos superficies
 * que la muestran (la tirilla ESC/POS de `escpos/prebill.ts` y la vista
 * imprimible del navegador) parten de este mismo objeto, así que no
 * pueden contradecirse.
 *
 * Los criterios son los MISMOS que ya usan el cobro y la factura:
 *
 *   - ítem vivo = sin cancelar y sin ronda cancelada
 *     (`syncOrderSubtotalFromLiveItems`, `issueSimpleInvoice`);
 *   - descuento del comensal re-derivado del % pactado sobre el subtotal
 *     vivo (`computeDiscountCents`), como lo hace el sync;
 *   - impuesto EMBEBIDO en los platos del menú (informativo, ya está
 *     dentro del precio) e impuesto SUMADO ENCIMA por las líneas libres
 *     (`salesTax.ts`), que sí entra al total;
 *   - lo pendiente = total cobrable − porción de comida de los pagos
 *     aprobados (`computeOrderTotals`).
 */

import { computeDiscountCents } from "./dinerDiscount";
import { formatItemSelections } from "./modifiers";
import { groupInvoiceLines, invoiceLineKey } from "./invoiceLines";
import { asSalesTaxKind } from "./checkoutTax";
import {
  isOwnTaxLine,
  lineTaxEmbeddedCents,
  lineTaxOnTopCents,
  type RestaurantTax,
} from "./salesTax";

/**
 * Propina sugerida por defecto: 10 %, la misma que preselecciona el
 * checkout del comensal (`PayClient`). Es una SUGERENCIA — la precuenta lo
 * dice en letras — y nunca se suma al total cobrable.
 */
export const DEFAULT_TIP_PCT = 10;

/** Propina de `pct` % sobre una base, redondeada al centavo. */
export function tipCentsFor(baseCents: number, pct = DEFAULT_TIP_PCT): number {
  if (!(pct > 0) || baseCents <= 0) return 0;
  return Math.round((baseCents * pct) / 100);
}

/** Lo mínimo de `OrderItem` que hace falta para decidir si entra y cuánto vale. */
export type PrebillOrderItem = {
  qty: number;
  /** null = línea libre. Es la referencia del plato al agrupar repetidos. */
  menuItemId?: string | null;
  nameSnapshot: string;
  priceCentsSnapshot: number;
  /** null ⇒ plato del menú (impuesto embebido). Con valor ⇒ línea libre. */
  taxKind: string | null;
  taxPct: number | null;
  modifierSelections?: unknown;
  notes?: string | null;
  guestName?: string | null;
  cancelledAt: Date | string | null;
  /** Ausente = no se cargó la ronda (línea libre o dato viejo): se toma viva. */
  round?: { status: string } | null;
  /** Definición viva del plato, para nombrar los modificadores. */
  menuItem?: { modifiers: unknown } | null;
};

export type PrebillOrderPayment = {
  status: string;
  amountCents: number;
  tipCents: number;
};

export type PrebillOrder = {
  shortCode: string;
  orderType: string;
  pickupName?: string | null;
  discountPct: number | null;
  discountCents: number;
  table: { number: number; label: string | null; kind: string } | null;
  items: PrebillOrderItem[];
  payments: PrebillOrderPayment[];
};

export type PrebillRestaurant = {
  name: string;
  legalName: string | null;
  taxId: string | null;
  legalAddress: string | null;
  legalCity: string | null;
  legalPhone: string | null;
  salesTaxKind: string;
  salesTaxPct: number;
};

/**
 * Una línea de la precuenta. Los repetidos van AGRUPADOS (tres Bretañas
 * de tres rondas = "3x Bretaña"), con el mismo criterio que la factura
 * impresa (`groupInvoiceLines`): mismo plato, precio, impuesto,
 * modificadores y nota. Así la precuenta y la factura que llega después
 * se leen igual.
 */
export type PrebillLine = {
  qty: number;
  name: string;
  unitCents: number;
  /** qty × unitario. Sin el impuesto que una línea libre suma encima. */
  lineCents: number;
  modifiers: string[];
  notes: string | null;
  /** Del comensal que lo pidió; null si el grupo junta a varios distintos. */
  guestName: string | null;
};

/** A quién va dirigida: decide el rótulo ("Mesa 7", "Para recoger · Ana"). */
export type PrebillDestination =
  | { kind: "table"; number: number; label: string | null }
  | { kind: "manual"; label: string | null }
  | { kind: "pickup"; name: string | null };

export type PrebillData = {
  /** Razón social si está cargada; si no, el nombre comercial. */
  businessName: string;
  taxId: string | null;
  legalAddress: string | null;
  legalCity: string | null;
  legalPhone: string | null;
  shortCode: string;
  destination: PrebillDestination;
  waiterName: string | null;
  issuedAt: Date;
  lines: PrebillLine[];
  /** Σ de las líneas vivas, antes del descuento. */
  grossSubtotalCents: number;
  discountPct: number | null;
  discountCents: number;
  /** Subtotal ya con el descuento restado. */
  netSubtotalCents: number;
  /**
   * Impuesto que ya viene DENTRO del precio de los platos del menú, con su
   * base. Informativo: no se suma. null = comercio sin impuesto o cuenta
   * sin platos del menú.
   */
  embeddedTax: {
    kind: "inc" | "iva";
    pct: number;
    taxCents: number;
    baseCents: number;
  } | null;
  /** Impuesto que las líneas libres SUMAN encima, por tipo. Entra al total. */
  taxOnTop: { inc: number; iva: number };
  taxOnTopCents: number;
  /** Lo cobrable: subtotal neto + impuesto sumado encima. */
  totalCents: number;
  /** Porción de comida (sin propina) de los pagos ya aprobados. */
  paidCents: number;
  /** Lo que falta pagar. Es la base de la propina sugerida. */
  outstandingCents: number;
  suggestedTipPct: number;
  suggestedTipCents: number;
  /** Pendiente + propina sugerida: lo que el comensal vería si acepta la sugerencia. */
  totalWithTipCents: number;
};

/** Mismo criterio de "ítem vivo" que el subtotal y la factura. */
export function isLiveItem(item: PrebillOrderItem): boolean {
  if (item.cancelledAt) return false;
  if (item.round && item.round.status === "cancelled") return false;
  return true;
}

function destinationOf(order: PrebillOrder): PrebillDestination {
  if (order.orderType === "pickup") {
    return { kind: "pickup", name: order.pickupName ?? null };
  }
  const table = order.table;
  if (!table) return { kind: "manual", label: null };
  if (table.kind === "manual") return { kind: "manual", label: table.label };
  if (table.kind === "pickup" || table.number < 0) {
    return { kind: "pickup", name: order.pickupName ?? null };
  }
  return { kind: "table", number: table.number, label: table.label };
}

export function buildPrebillData(
  order: PrebillOrder,
  restaurant: PrebillRestaurant,
  opts: {
    now: Date;
    waiterName?: string | null;
    tipPct?: number;
  },
): PrebillData {
  const live = order.items.filter(isLiveItem);

  // Los repetidos AGRUPADOS (ver `PrebillLine`). Sólo cambia cómo se
  // MUESTRA: los totales de abajo se siguen sumando ítem por ítem, y la
  // suma de las líneas agrupadas es la misma al centavo.
  const rawLines = live.map((i) => ({
    qty: i.qty,
    name: i.nameSnapshot,
    priceCents: i.priceCentsSnapshot,
    menuItemId: i.menuItemId ?? null,
    taxKind: i.taxKind,
    taxPct: i.taxPct,
    modifiers: formatItemSelections(i.modifierSelections, i.menuItem?.modifiers),
    notes: i.notes?.trim() ? i.notes.trim() : null,
    guestName: i.guestName?.trim() ? i.guestName.trim() : null,
  }));
  // El comensal no es parte de "qué se pidió": dos Bretañas de dos
  // comensales se agrupan igual. Pero el grupo sólo conserva el nombre si
  // es el de TODOS; si mezcla, null — no se le atribuye a uno lo del otro.
  const guestsByKey = new Map<string, Set<string | null>>();
  for (const l of rawLines) {
    const key = invoiceLineKey(l);
    const guests = guestsByKey.get(key) ?? new Set<string | null>();
    guests.add(l.guestName);
    guestsByKey.set(key, guests);
  }
  const lines: PrebillLine[] = groupInvoiceLines(rawLines).map((g) => ({
    qty: g.qty,
    name: g.name,
    unitCents: g.priceCents,
    lineCents: g.totalCents,
    modifiers: g.modifiers,
    notes: g.notes,
    guestName: guestsByKey.get(invoiceLineKey(g))?.size === 1 ? g.guestName : null,
  }));

  const tax: RestaurantTax = {
    kind: asSalesTaxKind(restaurant.salesTaxKind),
    pct: restaurant.salesTaxPct,
  };

  let grossSubtotalCents = 0;
  let embeddedTaxCents = 0;
  let embeddedBaseCents = 0;
  const taxOnTop = { inc: 0, iva: 0 };
  for (const i of live) {
    const line = {
      amountCents: i.priceCentsSnapshot * i.qty,
      taxKind: i.taxKind,
      taxPct: i.taxPct,
    };
    grossSubtotalCents += line.amountCents;
    if (isOwnTaxLine(line)) {
      const onTop = lineTaxOnTopCents(line);
      if (line.taxKind === "inc") taxOnTop.inc += onTop;
      else if (line.taxKind === "iva") taxOnTop.iva += onTop;
    } else {
      // Sobre el bruto de cada plato y sin descontar el descuento del
      // comensal: es el mismo reparto que congela la factura.
      const embedded = lineTaxEmbeddedCents(line, tax);
      embeddedTaxCents += embedded;
      embeddedBaseCents += line.amountCents - embedded;
    }
  }
  const taxOnTopCents = taxOnTop.inc + taxOnTop.iva;

  // El % pactado manda (se re-deriva sobre el subtotal vivo, como el
  // sync). Sin %, el monto persistido, que nunca puede superar el subtotal.
  const discountCents = order.discountPct
    ? computeDiscountCents(grossSubtotalCents, order.discountPct)
    : Math.max(0, Math.min(order.discountCents, grossSubtotalCents));
  const netSubtotalCents = Math.max(0, grossSubtotalCents - discountCents);
  const totalCents = netSubtotalCents + taxOnTopCents;

  // Sólo lo APROBADO: un efectivo `pending` es plata que el comensal dijo
  // que iba a entregar, y la precuenta muestra lo que de verdad falta.
  let paidCents = 0;
  for (const p of order.payments) {
    if (p.status !== "approved") continue;
    paidCents += Math.max(0, p.amountCents - p.tipCents);
  }
  const outstandingCents = Math.max(0, totalCents - paidCents);

  const suggestedTipPct = opts.tipPct ?? DEFAULT_TIP_PCT;
  const suggestedTipCents = tipCentsFor(outstandingCents, suggestedTipPct);

  return {
    businessName: restaurant.legalName?.trim() || restaurant.name,
    taxId: restaurant.taxId,
    legalAddress: restaurant.legalAddress,
    legalCity: restaurant.legalCity,
    legalPhone: restaurant.legalPhone,
    shortCode: order.shortCode,
    destination: destinationOf(order),
    waiterName: opts.waiterName?.trim() ? opts.waiterName.trim() : null,
    issuedAt: opts.now,
    lines,
    grossSubtotalCents,
    discountPct: order.discountPct ?? null,
    discountCents,
    netSubtotalCents,
    embeddedTax:
      tax.kind !== "none" && embeddedTaxCents > 0
        ? {
            kind: tax.kind,
            pct: tax.pct,
            taxCents: embeddedTaxCents,
            baseCents: embeddedBaseCents,
          }
        : null,
    taxOnTop,
    taxOnTopCents,
    totalCents,
    paidCents,
    outstandingCents,
    suggestedTipPct,
    suggestedTipCents,
    totalWithTipCents: outstandingCents + suggestedTipCents,
  };
}
