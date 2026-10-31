// Qué es una VENTA y cómo se calcula cada métrica del análisis de ventas —
// LÓGICA PURA y fuente de verdad de las definiciones.
//
// En producción las sumas se hacen en PostgreSQL (`sql.ts`), nunca trayendo
// miles de filas: este módulo define las fórmulas, deriva los indicadores de
// los totales ya agregados y trae una implementación de referencia por cuenta
// (`saleFacts`) contra la que se verifica el SQL.
//
// ── Universo ───────────────────────────────────────────────────────────────
// Una venta es una cuenta (`Order`) del comercio con `status = paid`, cuyo
// `paidAt` cae en el período, agrupada por el DÍA OPERATIVO del `paidAt` con
// la hora de corte del comercio. Una cortesía de cuenta completa (`compedAt`)
// se cierra en $0: no es una cuenta vendida y su valor va a «cortesías».
//
// ── Definiciones (por cuenta) ──────────────────────────────────────────────
//  · Venta bruta  = valor de lista de las líneas vivas (no canceladas, de
//                   rondas no canceladas) + impuesto que las líneas libres
//                   suman encima = subtotal + impuesto encima. Incluye el
//                   impuesto embebido en los precios de carta.
//  · Descuentos   = descuento del comensal (`discountCents`).
//  · Impuestos    = impuesto encima + impuesto incluido en la carta. El
//                   incluido es el CONGELADO en la factura (si la hay; una
//                   factura vieja sin impuesto guardado vale cero) o, sin
//                   factura, la tarifa actual del comercio línea a línea con
//                   el redondeo de la factura. Idéntico al Resumen.
//  · Venta neta   = máx(0, total − propina − impuesto encima − incluido)
//                 = bruta − descuentos − impuestos. Idéntica al Resumen.
//  · Propinas     = `tipCents`. No son venta.
//  · Cortesías    = valor de lista de lo regalado en cuentas cobradas del
//                   período: líneas `comp` + cortesías de cuenta completa.
//                   No entran en la venta (ni bruta ni neta).
// Las notas crédito y los reembolsos NO tocan la venta de la cuenta (que es
// lo que se cobró): se muestran aparte, con la venta neta después de ellos.
import { dashboardOrderNetSalesCents } from "@/lib/reports/dashboardSales";
import { splitTaxIncludedCents } from "@/lib/dian/ubl";
import { embeddedTaxCents } from "@/lib/erp/accounting";
import type { RestaurantTax } from "@/lib/salesTax";
import {
  matchOrderNotesAndRefunds,
  refundLinkedCents,
  type OrderNoteEvent,
  type OrderRefundEvent,
} from "@/lib/erp/creditNoteLedger";

// ── Implementación de referencia por cuenta ────────────────────────────────

export type SaleLineInput = {
  priceCentsSnapshot: number;
  qty: number;
  /** null = plato de carta (impuesto embebido); si no, línea libre. */
  taxKind: string | null;
  menuItemId: string | null;
  /** Viva = no cancelada y su ronda (si tiene) no está cancelada. */
  live: boolean;
  /** Regalada (`cancellationKind = comp`) y no tumbada antes por su ronda. */
  comp: boolean;
};

export type SaleOrderInput = {
  subtotalCents: number;
  taxCents: number;
  tipCents: number;
  totalCents: number;
  discountCents: number;
  diners: number;
  compedAt: Date | null;
  compAmountCents: number | null;
  /** null = sin factura. */
  invoice: { salesTaxKind?: unknown; embeddedTaxCents?: unknown } | null;
  lines: readonly SaleLineInput[];
};

export type SaleFacts = {
  /** false = cortesía de cuenta completa (no es cuenta vendida). */
  isSale: boolean;
  grossCents: number;
  discountCents: number;
  taxCents: number;
  netCents: number;
  tipCents: number;
  compsCents: number;
  diners: number;
  /** Unidades de carta vivas (las líneas libres no son «productos»). */
  units: number;
};

/** La misma entrada que usa el Resumen: la venta neta sale de su función. */
function dashboardInput(order: SaleOrderInput) {
  return {
    totalCents: order.totalCents,
    tipCents: order.tipCents,
    taxCents: order.taxCents,
    invoice: order.invoice,
    menuItems: order.lines
      .filter((l) => l.live && l.taxKind === null && l.qty > 0)
      .map((l) => ({ priceCentsSnapshot: l.priceCentsSnapshot, qty: l.qty })),
  };
}

/** Comp lines' list value; a whole-order comp without detail uses its stored amount. */
function compsOf(order: SaleOrderInput): number {
  const lines = order.lines.filter((l) => l.comp).reduce((s, l) => s + l.priceCentsSnapshot * l.qty, 0);
  if (order.compedAt && lines === 0) return order.compAmountCents ?? 0;
  return lines;
}

export function saleFacts(order: SaleOrderInput, currentTax: RestaurantTax): SaleFacts {
  const compsCents = compsOf(order);
  if (order.compedAt) {
    return {
      isSale: false, grossCents: 0, discountCents: 0, taxCents: 0, netCents: 0,
      tipCents: 0, compsCents, diners: 0, units: 0,
    };
  }
  const netCents = dashboardOrderNetSalesCents(dashboardInput(order), currentTax);
  const included = Math.max(0, order.totalCents - order.tipCents - order.taxCents - netCents);
  return {
    isSale: true,
    grossCents: order.subtotalCents + order.taxCents,
    discountCents: order.discountCents,
    taxCents: order.taxCents + included,
    netCents,
    tipCents: order.tipCents,
    compsCents,
    diners: order.diners,
    units: order.lines.filter((l) => l.live && l.menuItemId !== null).reduce((s, l) => s + l.qty, 0),
  };
}

// ── Reparto de la cuenta entre sus líneas (productos y categorías) ─────────

export type LineAllocation = {
  grossCents: number;
  discountCents: number;
  taxCents: number;
  /** Venta neta de la línea. Σ líneas = venta neta de la cuenta. */
  netCents: number;
};

/**
 * Reparte la venta neta de una cuenta entre sus líneas VIVAS, para que la
 * venta por producto y por categoría sume exactamente la venta neta total:
 *  · descuento: proporcional al valor de lista de la línea;
 *  · impuesto incluido: sólo en platos de carta — sin factura, el de la línea
 *    con la tarifa actual; con factura, el congelado repartido según el valor
 *    de lista de cada plato;
 *  · neta de la línea = (lista − descuento − impuesto) escalada para que el
 *    total de la cuenta cuadre al centavo con su venta neta.
 * Montos en centavos con decimales: se redondea al sumar, no por línea.
 */
export function allocateLines(order: SaleOrderInput, currentTax: RestaurantTax): LineAllocation[] {
  const live = order.lines.filter((l) => l.live);
  const gross = live.map((l) => l.priceCentsSnapshot * l.qty);
  const totalGross = gross.reduce((s, g) => s + g, 0);
  const menuGross = live.reduce((s, l, i) => s + (l.taxKind === null ? gross[i] : 0), 0);
  const facts = saleFacts(order, currentTax);
  const included = facts.taxCents - order.taxCents;
  const pctTimes100 = currentTax.kind !== "none" && currentTax.pct > 0 ? currentTax.pct * 100 : 0;
  const raw = live.map((l, i) => {
    const discountCents = totalGross > 0 ? (gross[i] * order.discountCents) / totalGross : 0;
    let taxCents = 0;
    if (l.taxKind === null) {
      if (order.invoice === null) {
        taxCents = l.qty > 0 ? splitTaxIncludedCents(gross[i], pctTimes100).taxCents : 0;
      } else if (menuGross > 0) {
        taxCents = (included * gross[i]) / menuGross;
      }
    }
    return { grossCents: gross[i], discountCents, taxCents, net: gross[i] - discountCents - taxCents };
  });
  const rawNet = raw.reduce((s, r) => s + r.net, 0);
  return raw.map((r) => ({
    grossCents: r.grossCents,
    discountCents: r.discountCents,
    taxCents: r.taxCents,
    netCents: rawNet > 0 ? (facts.netCents * r.net) / rawNet : 0,
  }));
}

// ── Totales agregados → indicadores ────────────────────────────────────────

/** Lo que devuelve el SQL (o `sumSaleFacts`) para un período. */
export type SalesTotals = {
  /** Cuentas vendidas: pagadas y que no son cortesía de cuenta completa. */
  orders: number;
  diners: number;
  units: number;
  grossCents: number;
  discountCents: number;
  taxCents: number;
  netCents: number;
  /** null = no aplica (filtro por producto/categoría: la propina es de la cuenta). */
  tipCents: number | null;
  compsCents: number;
};

export const EMPTY_TOTALS: SalesTotals = {
  orders: 0, diners: 0, units: 0, grossCents: 0, discountCents: 0,
  taxCents: 0, netCents: 0, tipCents: 0, compsCents: 0,
};

export function sumSaleFacts(facts: readonly SaleFacts[]): SalesTotals {
  return facts.reduce<SalesTotals>((t, f) => ({
    orders: t.orders + (f.isSale ? 1 : 0),
    diners: t.diners + f.diners,
    units: t.units + f.units,
    grossCents: t.grossCents + f.grossCents,
    discountCents: t.discountCents + f.discountCents,
    taxCents: t.taxCents + f.taxCents,
    netCents: t.netCents + f.netCents,
    tipCents: (t.tipCents ?? 0) + f.tipCents,
    compsCents: t.compsCents + f.compsCents,
  }), { ...EMPTY_TOTALS });
}

export type ReturnsSummary = {
  creditNotes: { count: number; baseCents: number; taxCents: number; totalCents: number };
  refunds: {
    count: number;
    totalCents: number;
    /** Parte de los reembolsos que NO cubre una nota crédito. */
    unlinkedCents: number;
  };
  /**
   * Lo que restan de la venta neta: base de las notas + reembolsos sin nota
   * sin su impuesto (estimado con la tarifa actual, como el asiento
   * «Devoluciones del mes» de la contabilidad).
   */
  baseCents: number;
};

export type DurationSummary = {
  /** Mediana en minutos de la primera ronda al pago; null si no hay datos suficientes. */
  medianMinutes: number | null;
  /** Cuentas de salón con duración medible (entre 1 minuto y 12 horas). */
  measured: number;
  /** Cuentas de salón del período. */
  eligible: number;
};

/** Con menos de esto (o menos de 60 % medible) la duración no se muestra. */
export const DURATION_MIN_SAMPLE = 5;
export const DURATION_MIN_COVERAGE = 0.6;

export function reliableDuration(d: DurationSummary | null): number | null {
  if (!d || d.medianMinutes === null) return null;
  if (d.measured < DURATION_MIN_SAMPLE || d.eligible === 0) return null;
  if (d.measured / d.eligible < DURATION_MIN_COVERAGE) return null;
  return d.medianMinutes;
}

export type Kpis = {
  netCents: number;
  grossCents: number;
  taxCents: number;
  tipCents: number | null;
  discountCents: number;
  compsCents: number;
  discountsAndCompsCents: number;
  /** null = no aplica con filtro por producto/categoría. */
  returnsCents: number | null;
  netAfterReturnsCents: number | null;
  orders: number;
  diners: number;
  /** Venta neta / cuentas. null sin cuentas. */
  avgTicketCents: number | null;
  /** Venta neta / comensales. */
  avgPerDinerCents: number | null;
  /** Unidades de carta / cuentas. */
  unitsPerOrder: number | null;
  medianTableMinutes: number | null;
};

export type KpiKey = keyof Kpis;

export function deriveKpis(
  t: SalesTotals,
  returns: ReturnsSummary | null,
  duration: DurationSummary | null,
): Kpis {
  const ratio = (num: number, den: number) => (den > 0 ? num / den : null);
  const avgTicket = ratio(t.netCents, t.orders);
  const perDiner = ratio(t.netCents, t.diners);
  return {
    netCents: t.netCents,
    grossCents: t.grossCents,
    taxCents: t.taxCents,
    tipCents: t.tipCents,
    discountCents: t.discountCents,
    compsCents: t.compsCents,
    discountsAndCompsCents: t.discountCents + t.compsCents,
    returnsCents: returns ? returns.baseCents : null,
    netAfterReturnsCents: returns ? t.netCents - returns.baseCents : null,
    orders: t.orders,
    diners: t.diners,
    avgTicketCents: avgTicket === null ? null : Math.round(avgTicket),
    avgPerDinerCents: perDiner === null ? null : Math.round(perDiner),
    unitsPerOrder: ratio(t.units, t.orders),
    medianTableMinutes: reliableDuration(duration),
  };
}

/**
 * Variación relativa contra la comparación. null cuando no se puede decir
 * nada honesto: sin comparación, sin dato o con base cero.
 */
export function variation(current: number | null | undefined, previous: number | null | undefined): number | null {
  if (current === null || current === undefined || previous === null || previous === undefined) return null;
  if (previous === 0) return null;
  return (current - previous) / Math.abs(previous);
}

/** Si subir es bueno, malo o ninguna de las dos (para el color del delta). */
export type Polarity = "up" | "down" | "neutral";

export const KPI_POLARITY: Record<KpiKey, Polarity> = {
  netCents: "up",
  grossCents: "up",
  taxCents: "neutral",
  tipCents: "up",
  discountCents: "down",
  compsCents: "down",
  discountsAndCompsCents: "down",
  returnsCents: "down",
  netAfterReturnsCents: "up",
  orders: "up",
  diners: "up",
  avgTicketCents: "up",
  avgPerDinerCents: "up",
  unitsPerOrder: "up",
  medianTableMinutes: "neutral",
};

/** "good" | "bad" | "neutral" según el signo de la variación y la polaridad. */
export function deltaTone(delta: number | null, polarity: Polarity): "good" | "bad" | "neutral" {
  if (delta === null || delta === 0 || polarity === "neutral") return "neutral";
  const up = delta > 0;
  return up === (polarity === "up") ? "good" : "bad";
}

/** Participación sobre el total (0–1); null con total cero. */
export function share(part: number, total: number): number | null {
  return total > 0 ? part / total : null;
}

// ── Notas crédito y reembolsos ─────────────────────────────────────────────

export type CreditNoteRow = {
  id: string;
  orderId: string;
  at: Date;
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
  /** Parte que canceló cartera de crédito (null = aún no contabilizada). */
  receivableCents: number | null;
  /** ¿Cae en el período? (las demás sólo sirven para el cruce). */
  inRange: boolean;
};

export type RefundRow = {
  id: string;
  orderId: string | null;
  at: Date;
  amountCents: number;
  inRange: boolean;
};

/**
 * Notas crédito ACEPTADAS y reembolsos del período, sin contar dos veces el
 * reembolso que ya cubre una nota: se cruzan con la misma regla cronológica
 * de la contabilidad (`matchOrderNotesAndRefunds`), con TODA la historia de
 * cada cuenta involucrada (por eso llegan filas fuera del rango).
 */
export function summarizeReturns(
  notes: readonly CreditNoteRow[],
  refunds: readonly RefundRow[],
  currentTax: RestaurantTax,
): ReturnsSummary {
  const inNotes = notes.filter((n) => n.inRange);
  const inRefunds = refunds.filter((r) => r.inRange);
  const byOrder = new Map<string, { notes: OrderNoteEvent[]; refunds: OrderRefundEvent[] }>();
  const bucket = (orderId: string) => {
    const b = byOrder.get(orderId) ?? { notes: [], refunds: [] };
    byOrder.set(orderId, b);
    return b;
  };
  for (const n of notes) {
    bucket(n.orderId).notes.push({ id: n.id, at: n.at, availableCents: n.totalCents - (n.receivableCents ?? 0) });
  }
  for (const r of refunds) {
    if (r.orderId) bucket(r.orderId).refunds.push({ id: r.id, at: r.at, amountCents: r.amountCents });
  }
  const matches = new Map([...byOrder].map(([orderId, b]) => [orderId, matchOrderNotesAndRefunds(b.notes, b.refunds)]));
  const unlinkedCents = inRefunds.reduce((s, r) => {
    const match = r.orderId ? matches.get(r.orderId) : undefined;
    return s + r.amountCents - (match ? refundLinkedCents(match, r.id) : 0);
  }, 0);
  const creditNotes = {
    count: inNotes.length,
    baseCents: inNotes.reduce((s, n) => s + n.subtotalCents, 0),
    taxCents: inNotes.reduce((s, n) => s + n.taxCents, 0),
    totalCents: inNotes.reduce((s, n) => s + n.totalCents, 0),
  };
  const refundTax = currentTax.kind === "none" ? 0 : embeddedTaxCents(unlinkedCents, currentTax.pct);
  return {
    creditNotes,
    refunds: {
      count: inRefunds.length,
      totalCents: inRefunds.reduce((s, r) => s + r.amountCents, 0),
      unlinkedCents,
    },
    baseCents: creditNotes.baseCents + unlinkedCents - refundTax,
  };
}
