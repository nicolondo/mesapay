// Impuesto de ventas por TRAMO (tarifa) a partir de los pedidos pagados —
// lógica PURA, sin DB. Es el único lugar donde se decide cuánto impuesto
// causó un pedido: lo comparten la tarjeta de impuestos y el PYG
// (`accountingData.computeSalesTaxSummary`) y el asiento «Ventas del día»
// (`posting.ts`), que agrupa estos mismos pedidos por día de negocio. Así
// Σ días == mes al centavo y el libro dice lo mismo que la tarjeta.
//
// Reglas (ver también `computeSalesTaxSummary`):
//   · Pedido FACTURADO: lo que su factura congeló en el snapshot (tarifa
//     vigente al emitirla e impuesto/base declarados). Nunca "tarifa de
//     hoy × ventas": prender el impuesto no toca lo emitido antes.
//   · Snapshot sin tarifa (anterior a congelarla) ⇒ tramo "none", cero.
//   · Pedido SIN factura: tarifa actual del comercio sobre lo que vendió de
//     la CARTA (subtotal − líneas libres); el impuesto embebido se redondea
//     POR PEDIDO (no sobre la suma), para que el total no dependa de cómo
//     se agrupen los pedidos.
//
// Además del impuesto EMBEBIDO de la carta, las LÍNEAS LIBRES (servicios,
// alquileres, cargos sueltos) SUMAN su impuesto ENCIMA del precio, cada una
// con su tipo y tarifa (`orderFreeLineTaxSlices`). Es otro tramo: la base es
// el precio de la línea (ingreso) y el impuesto, IVA/INC generado — igual que
// lo declara la factura electrónica línea por línea.
import { frozenSalesTax, type InvoiceSnapshot } from "@/lib/invoice";
import { lineTaxOnTopCents } from "@/lib/salesTax";
import { embeddedTaxCents, type SalesTaxKind, type SalesTaxSlice } from "./accounting";

/**
 * Una línea LIBRE viva de un pedido (`OrderItem.taxKind` ≠ null): no sale
 * del menú, no lleva impuesto embebido y el suyo se suma encima del precio.
 * `amountCents` = precio unitario × cantidad.
 */
export type FreeLine = { amountCents: number; taxKind: string | null; taxPct: number | null };

/** Lo que hace falta de un pedido pagado para ubicar su impuesto. */
export type SalesTaxOrder = {
  subtotalCents: number;
  /** Snapshot de su factura, o null si la venta no tiene factura. */
  invoiceSnapshot: InvoiceSnapshot | null;
  /**
   * Líneas libres VIVAS del pedido (sin cancelar, fuera de rondas
   * canceladas), con o sin impuesto. Opcional: sin ellas el pedido se lee
   * como antes (todo el subtotal es de la carta). El motor y la tarjeta de
   * impuestos las pasan siempre.
   */
  freeLines?: readonly FreeLine[];
};

/** Régimen actual del comercio (para las ventas sin factura). */
export type CurrentSalesTax = { kind: SalesTaxKind; pct: number };

/** Normaliza la configuración del comercio: "none" ⇒ 0 %. */
export function currentSalesTaxOf(tenant: {
  salesTaxKind?: string | null;
  salesTaxPct?: number | null;
} | null): CurrentSalesTax {
  const kind = (tenant?.salesTaxKind ?? "none") as SalesTaxKind;
  return { kind, pct: kind === "none" ? 0 : tenant?.salesTaxPct ?? 0 };
}

/** Tramo (tipo, %, bruto, impuesto) de UN pedido. */
export function orderSalesTaxSlice(order: SalesTaxOrder, current: CurrentSalesTax): SalesTaxSlice {
  const snap = order.invoiceSnapshot;
  if (snap) {
    const frozen = frozenSalesTax(snap);
    const taxCents = frozen.kind === "none" ? 0 : (snap.embeddedTaxCents ?? 0);
    // Bruto del tramo: los platos del menú (base + impuesto) cuando el
    // snapshot lo congeló; para los viejos, el subtotal entero, que es lo
    // que el cálculo anterior tomaba como bruto.
    const grossCents = snap.embeddedBaseCents != null ? snap.embeddedBaseCents + taxCents : snap.subtotalCents;
    return { kind: frozen.kind, pct: frozen.pct, grossCents, taxCents, baseCents: grossCents - taxCents };
  }
  // Sin factura: sólo lo de la CARTA lleva impuesto embebido. Las líneas
  // libres no (el suyo va encima, `orderFreeLineTaxSlices`): antes se le
  // sacaba el INC del comercio también al precio de un servicio.
  const freeCents = (order.freeLines ?? []).reduce((s, l) => s + l.amountCents, 0);
  const grossCents = Math.max(0, order.subtotalCents - freeCents);
  const taxCents = current.kind === "none" ? 0 : embeddedTaxCents(grossCents, current.pct);
  return { kind: current.kind, pct: current.pct, grossCents, taxCents, baseCents: grossCents - taxCents };
}

// ── Líneas libres: impuesto ENCIMA ──────────────────────────────────────────

/** Tarifa por defecto si una factura vieja declara un tipo sin líneas que lo expliquen. */
const DEFAULT_PCT: Record<"inc" | "iva", number> = { inc: 8, iva: 19 };

/**
 * Líneas libres CON tipo de impuesto que declaró la factura. Las tirillas
 * emitidas desde que el snapshot guarda el `taxKind` de cada ítem (null en
 * los platos del menú) se leen de ahí, que es lo que viajó al XML. Las
 * anteriores (sin la clave) se leen de las líneas vivas del pedido: son las
 * mismas, el pedido ya estaba pagado.
 */
function invoiceFreeLines(snap: InvoiceSnapshot, fallback: readonly FreeLine[]): readonly FreeLine[] {
  const items = snap.items ?? [];
  if (items.some((i) => i.taxKind !== undefined)) {
    return items
      .filter((i) => i.taxKind != null)
      .map((i) => ({ amountCents: i.priceCents * i.qty, taxKind: i.taxKind ?? null, taxPct: i.taxPct ?? null }));
  }
  return (snap.taxCents ?? 0) > 0 ? fallback : [];
}

/** Tramos de un conjunto de líneas libres: base = precio, impuesto = encima, redondeado por línea. */
function freeLinesToSlices(lines: readonly FreeLine[]): SalesTaxSlice[] {
  const slices: SalesTaxSlice[] = [];
  for (const l of lines) {
    if ((l.taxKind !== "inc" && l.taxKind !== "iva") || l.amountCents <= 0) continue;
    // Mismo redondeo por línea que el XML (`dian/emit.invoiceLineFor`) y
    // que `Order.taxCents` (`orderTaxTotals`).
    const taxCents = lineTaxOnTopCents(l);
    slices.push({
      kind: l.taxKind,
      pct: l.taxPct ?? 0,
      grossCents: l.amountCents + taxCents,
      taxCents,
      baseCents: l.amountCents,
    });
  }
  return sumSalesTaxSlices(slices);
}

/**
 * Lo que la factura DECLARÓ por tipo (`taxByKind`) manda: si las líneas no
 * suman exactamente eso (snapshot viejo leído de las líneas vivas y algo
 * cambió), la diferencia va al tramo más grande de ese tipo, o a uno con la
 * tarifa estándar si no hay ninguno. En una factura normal no toca nada.
 */
function matchDeclared(slices: SalesTaxSlice[], snap: InvoiceSnapshot): SalesTaxSlice[] {
  const declared = snap.taxByKind;
  if (!declared) return slices;
  const out = slices.map((s) => ({ ...s }));
  for (const kind of ["inc", "iva"] as const) {
    const want = declared[kind] ?? 0;
    const mine = out.filter((s) => s.kind === kind);
    const diff = want - mine.reduce((s, x) => s + x.taxCents, 0);
    if (diff === 0) continue;
    const target = [...mine].sort((a, b) => b.taxCents - a.taxCents)[0];
    if (target) {
      target.taxCents += diff;
      target.grossCents += diff;
    } else if (want > 0) {
      out.push({ kind, pct: DEFAULT_PCT[kind], grossCents: want, taxCents: want, baseCents: 0 });
    }
  }
  return out;
}

/**
 * Tramos del impuesto que las LÍNEAS LIBRES de un pedido suman ENCIMA, por
 * (tipo, %). Facturado: lo que declaró la factura (sus ítems y `taxByKind`).
 * Sin factura: las líneas libres vivas del pedido, con su tipo y tarifa.
 * Vacío en una cuenta sólo de carta. Base = precio de la línea (va al
 * ingreso), impuesto = lo sumado (va al IVA/INC generado).
 */
export function orderFreeLineTaxSlices(order: SalesTaxOrder): SalesTaxSlice[] {
  const snap = order.invoiceSnapshot;
  const fallback = order.freeLines ?? [];
  if (!snap) return freeLinesToSlices(fallback);
  return matchDeclared(freeLinesToSlices(invoiceFreeLines(snap, fallback)), snap);
}

/** Tramos de las líneas libres de un conjunto de pedidos, sumados por tarifa. */
export function freeLineTaxSlicesFor(orders: readonly SalesTaxOrder[]): SalesTaxSlice[] {
  return sumSalesTaxSlices(orders.flatMap((o) => orderFreeLineTaxSlices(o)));
}

/** Suma tramos por (tipo, %). Conserva los tramos "none" (sirven para el bruto). */
export function sumSalesTaxSlices(slices: readonly SalesTaxSlice[]): SalesTaxSlice[] {
  const byKey = new Map<string, SalesTaxSlice>();
  for (const s of slices) {
    const key = `${s.kind}:${s.pct}`;
    const acc = byKey.get(key) ?? { kind: s.kind, pct: s.pct, grossCents: 0, taxCents: 0, baseCents: 0 };
    acc.grossCents += s.grossCents;
    acc.taxCents += s.taxCents;
    acc.baseCents = acc.grossCents - acc.taxCents;
    byKey.set(key, acc);
  }
  return [...byKey.values()];
}

/** Tramos de un conjunto de pedidos, sumados por tarifa. */
export function salesTaxSlicesFor(
  orders: readonly SalesTaxOrder[],
  current: CurrentSalesTax,
): SalesTaxSlice[] {
  return sumSalesTaxSlices(orders.map((o) => orderSalesTaxSlice(o, current)));
}

/**
 * `byRate` como lo exponen la tarjeta y el asiento: sólo los tramos que
 * causaron impuesto, el que más causó primero.
 */
export function salesTaxByRate(slices: readonly SalesTaxSlice[]): SalesTaxSlice[] {
  return slices
    .filter((s) => s.kind !== "none" && s.taxCents > 0)
    .sort((a, b) => b.taxCents - a.taxCents);
}

/**
 * Etiqueta del período: el tramo que más causó o, sin impuesto causado, la
 * configuración actual (así "none" sigue significando "sin impuesto
 * configurado"). Las devoluciones sin nota usan este régimen.
 */
export function salesTaxLabel(
  byRate: readonly SalesTaxSlice[],
  current: CurrentSalesTax,
): CurrentSalesTax {
  const top = byRate[0];
  return top ? { kind: top.kind, pct: top.pct } : current;
}
