// Líneas de la factura electrónica a partir de los ítems de la cuenta, con
// el DESCUENTO DEL CLIENTE adentro de cada línea — lógica PURA, sin DB.
//
// Es la única fuente del reparto base + impuesto de una venta: la usan el
// XML (`emit.orderToInvoiceLines` → `ubl.buildDianInvoiceXml`), el snapshot
// de la tirilla (`simpleInvoice.issueSimpleInvoice`, que congela el impuesto
// embebido), la precuenta (`prebill.ts`) y la revisión de impuestos de las
// facturas viejas (`reports/saleTaxSnapshot.undeclaredDiscountOf`). Si el
// reparto viviera en dos lugares, un redondeo distinto bastaría para que el
// papel y el XML dijeran centavos diferentes.
//
// ── Por qué el descuento va EN LAS LÍNEAS ──────────────────────────────────
// El descuento del comensal identificado / del cliente de facturación
// (`Order.discountCents`) es un descuento comercial NO condicionado: se da
// en la venta y el cliente paga el precio con el descuento. Ese descuento
// BAJA la base del impuesto, y el Anexo Técnico de factura electrónica
// (v1.8, Res. 000012/2021; mismas reglas en la 1.9) dice dónde va:
//
//   · FAQ01 (pág. 77): el `cac:AllowanceCharge` del DOCUMENTO es para
//     «descuentos o cargos que no afectan las bases gravables. Los
//     descuentos o cargos que afectan bases gravables se informan a nivel
//     de ítem».
//   · FBE01–FBE09 (págs. 95–96): `cac:InvoiceLine/cac:AllowanceCharge` «si
//     y solamente si el cargo o descuento afecta la base gravable del
//     ítem»; obligatorios ChargeIndicator, MultiplierFactorNumeric, Amount y
//     BaseAmount; «para el caso de los descuentos a nivel de ítem no es
//     necesario codificarlos» (no lleva AllowanceChargeReasonCode; en la
//     tabla 13.3.8, pág. 618, el 00 «Descuento no condicionado» es el de
//     línea y el 01 «condicionado» el de pie de factura).
//   · FAV06 (pág. 93): LineExtensionAmount de la línea = cantidad × precio
//     − descuentos + cargos de la línea.
//   · FAX05 (pág. 99): la base del impuesto de la línea incluye «los
//     descuentos no condicionados».
//   · FAU08 (pág. 89): AllowanceTotalAmount suma SÓLO los descuentos del
//     documento — los de línea ya están dentro de LineExtensionAmount, así
//     que el del documento sigue en 0.
//
// Antes la factura salía con el precio de lista y sin descuento: declaraba
// el bruto (base e impuesto de más) y un PayableAmount mayor que lo cobrado.
//
// ── Cómo se reparte ────────────────────────────────────────────────────────
// El descuento es un % del subtotal. Se reparte entre las líneas en
// proporción a lo que cada una aporta al subtotal, por resto mayor: la suma
// de los descuentos de línea da EXACTAMENTE el descuento de la cuenta y la
// de las líneas netas, lo cobrado. Cada línea neta se vuelve a partir en
// base + impuesto con la tarifa de la línea y el MISMO `splitTaxIncludedCents`
// de siempre (por línea, no sobre el total).
//
// Las líneas libres con impuesto SUMADO encima (un servicio "+ IVA") van al
// final de la fila: MESAPAY cobra ese impuesto sobre el precio SIN descuento
// (`orderTotals.computeOrderTotals`), así que repartirles descuento obligaría
// a declarar un impuesto distinto del cobrado y del que dice el papel. Sólo
// absorben el resto cuando las demás líneas no alcanzan (un descuento mayor
// que todos los platos de la cuenta); entonces lo que les queda cobrado se
// parte en base + impuesto con su tarifa, para que el total siga siendo lo
// cobrado (`freeLineTax`).
import { splitTaxIncludedCents, type DianLine } from "@/lib/dian/ubl";
import { isOwnTaxLine, type RestaurantTax, type SalesTaxKind } from "@/lib/salesTax";

export type OrderItemForInvoice = {
  nameSnapshot: string;
  qty: number;
  priceCentsSnapshot: number;
  cancelledAt: Date | null;
  /** null ⇒ plato del menú (impuesto embebido con la tarifa del comercio). */
  taxKind: string | null;
  taxPct: number | null;
};

/** Tipo de impuesto → código del anexo: "01" IVA, "04" impoconsumo. */
function schemeOf(kind: SalesTaxKind): "01" | "04" {
  return kind === "inc" ? "04" : "01";
}

/** Misma regla que salesTax.isOwnTaxLine, sobre el item de la orden. */
function ownTaxItem(it: OrderItemForInvoice): boolean {
  return isOwnTaxLine({ amountCents: 0, taxKind: it.taxKind, taxPct: it.taxPct });
}

/**
 * Una línea con su precio de lista, ANTES del descuento.
 *   · `chargedCents`: lo que se cobra por la línea sin descuento (base +
 *     impuesto: el precio de carta en un plato; precio + impuesto sumado en
 *     una línea libre).
 *   · `weightCents`: lo que la línea aporta al subtotal de la cuenta, que es
 *     sobre lo que se calculó el %: el precio de carta en un plato, el
 *     precio SIN impuesto en una línea libre.
 *   · `taxOnTop`: línea libre con impuesto sumado encima (ver arriba).
 */
type PricedLine = {
  line: DianLine;
  own: boolean;
  taxOnTop: boolean;
  pct: number;
  chargedCents: number;
  weightCents: number;
};

/**
 * Una línea UBL a partir de un item (null si está cancelado, sin cantidad
 * o en $0), SIN descuento. Respeta los DOS regímenes que conviven en una
 * cuenta (ver src/lib/salesTax.ts):
 *
 *   · Plato de carta (taxKind null) → el impuesto va DENTRO del precio,
 *     con la tarifa del comercio: se reparte base + impuesto.
 *   · Línea libre (taxKind propio) → el impuesto se SUMA ENCIMA: la base
 *     es el precio tal cual y el impuesto se calcula sobre él.
 *
 * Un ítem en $0 (cortesía de la carta, modificador que deja el precio en
 * cero, línea libre sin valor) no es una venta: no va a la factura. Ver
 * `billableDianLines` en ubl.ts (regla FAW01 de la DIAN).
 */
function pricedLineFor(
  it: OrderItemForInvoice,
  restaurantTax: RestaurantTax,
): PricedLine | null {
  if (it.cancelledAt || it.qty <= 0) return null;
  const grossLine = it.priceCentsSnapshot * it.qty;
  if (grossLine <= 0) return null;
  const own = ownTaxItem(it);
  const kind = (own ? it.taxKind : restaurantTax.kind) as SalesTaxKind;
  const pct = own ? (it.taxPct ?? 0) : restaurantTax.pct;
  const effectivePct = kind === "none" ? 0 : pct;

  let lineTotalCents: number;
  let unitPriceCents: number;
  let taxCents: number;
  if (own) {
    // Impuesto encima: la base es el precio de la línea.
    lineTotalCents = grossLine;
    unitPriceCents = it.priceCentsSnapshot;
    taxCents =
      effectivePct > 0 && grossLine > 0
        ? Math.round((grossLine * effectivePct) / 100)
        : 0;
  } else {
    // Impuesto embebido: base = bruto − impuesto (suman exacto).
    const split = splitTaxIncludedCents(grossLine, effectivePct * 100);
    lineTotalCents = split.baseCents;
    taxCents = split.taxCents;
    unitPriceCents = splitTaxIncludedCents(
      it.priceCentsSnapshot,
      effectivePct * 100,
    ).baseCents;
  }

  return {
    own,
    taxOnTop: own && effectivePct > 0,
    pct: effectivePct,
    chargedCents: lineTotalCents + taxCents,
    // Lo que entra al subtotal: el precio de carta o, en una línea libre,
    // su precio sin el impuesto sumado (`orderTaxTotals.subtotalCents`).
    weightCents: grossLine,
    line: {
      description: it.nameSnapshot,
      quantity: it.qty,
      unitPriceCents,
      lineTotalCents,
      taxCents,
      taxPct: effectivePct.toFixed(2),
      taxSchemeId: schemeOf(kind),
    },
  };
}

/**
 * Reparte `total` centavos en proporción a `weights` por RESTO MAYOR: la
 * suma da exactamente `total` (topado a Σ weights) y ninguna parte supera su
 * peso. Empates: mayor resto, después mayor peso, después el primero.
 * Aritmética entera (BigInt): un subtotal × un descuento grandes no caben en
 * un double sin perder centavos.
 */
export function allocateCents(total: number, weights: readonly number[]): number[] {
  const sum = weights.reduce((s, w) => s + Math.max(0, w), 0);
  if (!(total > 0) || sum <= 0) return weights.map(() => 0);
  const capped = BigInt(Math.min(Math.round(total), sum));
  const big = BigInt(sum);
  const quotas = weights.map((w, i) => {
    const n = capped * BigInt(Math.max(0, w));
    return { i, q: n / big, r: n % big, w: Math.max(0, w) };
  });
  const out = quotas.map((x) => Number(x.q));
  let left = Number(capped) - out.reduce((s, x) => s + x, 0);
  const order = [...quotas].sort((a, b) =>
    a.r === b.r ? b.w - a.w || a.i - b.i : a.r > b.r ? -1 : 1,
  );
  for (const x of order) {
    if (left <= 0) break;
    if (x.r === BigInt(0)) continue;
    out[x.i] += 1;
    left -= 1;
  }
  return out;
}

export type EmbeddedMenuTax = {
  /** Σ del impuesto embebido de los platos del menú (0 si el comercio está en "none"). */
  taxCents: number;
  /** Σ de las bases (bruto − impuesto) de esos mismos platos. */
  baseCents: number;
  /** Σ del bruto de los platos del menú: base + impuesto. */
  grossCents: number;
};

/** Impuesto que declaran, por tarifa, las líneas libres con impuesto encima que absorbieron descuento. */
export type FreeLineTax = { kind: "inc" | "iva"; pct: number; baseCents: number; taxCents: number };

export type SaleLines = {
  /**
   * Líneas UBL NETAS del descuento, en el orden de los ítems y sin las que
   * quedan en $0. `allowanceCents` (sólo si > 0) es el descuento de la
   * línea sin impuesto: lo que va en su cac:AllowanceCharge.
   */
  lines: DianLine[];
  /** Impuesto embebido NETO de los platos de carta: lo que congela el snapshot. */
  embedded: EmbeddedMenuTax;
  /** Descuento repartido (el pedido, topado a lo que la cuenta tiene para descontar). */
  discountCents: number;
  /** Σ de los descuentos de línea sin impuesto (Σ `allowanceCents`). */
  allowanceCents: number;
  /**
   * Sólo cuando alguna línea libre con impuesto encima absorbió descuento:
   * lo que declaran TODAS esas líneas, por tarifa (base e impuesto netos).
   * null en el caso normal, donde esas líneas quedan tal como se cobraron.
   */
  freeLineTax: FreeLineTax[] | null;
};

/**
 * Las líneas de la factura de una cuenta con su descuento adentro (ver la
 * cabecera). Con `discountCents` 0 son exactamente las de siempre.
 */
export function saleLines(
  items: readonly OrderItemForInvoice[],
  restaurantTax: RestaurantTax,
  discountCents = 0,
): SaleLines {
  const priced: PricedLine[] = [];
  for (const it of items) {
    const p = pricedLineFor(it, restaurantTax);
    if (p) priced.push(p);
  }

  // Primero las líneas cuyo precio ya es lo cobrado (platos, líneas libres
  // sin impuesto); el resto, si queda, a las de impuesto encima.
  const first = priced.map((p, i) => ({ p, i })).filter((x) => !x.p.taxOnTop);
  const last = priced.map((p, i) => ({ p, i })).filter((x) => x.p.taxOnTop);
  const shares = priced.map(() => 0);
  const firstCap = first.reduce((s, x) => s + x.p.weightCents, 0);
  const wanted = Math.max(0, Math.round(discountCents));
  const firstShares = allocateCents(Math.min(wanted, firstCap), first.map((x) => x.p.weightCents));
  first.forEach((x, k) => (shares[x.i] = firstShares[k]));
  const rest = wanted - firstShares.reduce((s, v) => s + v, 0);
  const lastShares = allocateCents(rest, last.map((x) => x.p.weightCents));
  last.forEach((x, k) => (shares[x.i] = lastShares[k]));

  const lines: DianLine[] = [];
  const embedded = { taxCents: 0, baseCents: 0, grossCents: 0 };
  let allowanceCents = 0;
  let touchedOnTop = false;
  const onTop: { line: DianLine; kind: "inc" | "iva"; pct: number }[] = [];
  priced.forEach((p, i) => {
    const share = shares[i];
    let line = p.line;
    if (share > 0) {
      // Lo que queda cobrado por la línea, partido con SU tarifa. Una línea
      // libre sin impuesto se parte con 0 %: base = lo cobrado.
      const net = splitTaxIncludedCents(p.chargedCents - share, p.pct * 100);
      const allowance = p.line.lineTotalCents - net.baseCents;
      line = {
        ...p.line,
        lineTotalCents: net.baseCents,
        taxCents: net.taxCents,
        ...(allowance > 0 ? { allowanceCents: allowance } : {}),
      };
      if (allowance > 0) allowanceCents += allowance;
      if (p.taxOnTop) touchedOnTop = true;
    }
    if (!p.own) {
      embedded.taxCents += line.taxCents;
      embedded.baseCents += line.lineTotalCents;
    }
    if (p.taxOnTop) {
      onTop.push({ line, kind: line.taxSchemeId === "04" ? "inc" : "iva", pct: p.pct });
    }
    // Una línea que el descuento dejó en cero ya no es una venta.
    if (line.lineTotalCents + line.taxCents > 0) lines.push(line);
  });
  embedded.grossCents = embedded.baseCents + embedded.taxCents;

  let freeLineTax: FreeLineTax[] | null = null;
  if (touchedOnTop) {
    const byKey = new Map<string, FreeLineTax>();
    for (const o of onTop) {
      const key = `${o.kind}:${o.pct}`;
      const acc = byKey.get(key) ?? { kind: o.kind, pct: o.pct, baseCents: 0, taxCents: 0 };
      acc.baseCents += o.line.lineTotalCents;
      acc.taxCents += o.line.taxCents;
      byKey.set(key, acc);
    }
    freeLineTax = [...byKey.values()];
  }

  return {
    lines,
    embedded,
    discountCents: shares.reduce((s, v) => s + v, 0),
    allowanceCents,
    freeLineTax,
  };
}

/**
 * Mapea los items vivos de una orden a líneas UBL (pura), con el descuento
 * del cliente adentro (ver `saleLines`). Sin descuento, las líneas de
 * siempre: cada una con su régimen (embebido o encima), items cancelados y
 * en $0 fuera, enteros exactos.
 */
export function orderToInvoiceLines(
  items: readonly OrderItemForInvoice[],
  restaurantTax: RestaurantTax,
  discountCents = 0,
): DianLine[] {
  return saleLines(items, restaurantTax, discountCents).lines;
}

/**
 * Impuesto EMBEBIDO de los platos del menú de una orden, con la tarifa
 * recibida y NETO del descuento del cliente — lo que la tirilla congela en
 * el snapshot al emitirse.
 *
 * Es la suma, línea por línea, de los MISMOS `taxCents`/`lineTotalCents`
 * que `orderToInvoiceLines` pone en el XML, no una fórmula sobre el
 * subtotal: partir el subtotal entero redondea distinto que partir cada
 * línea y el papel quedaría a un centavo del XML. Las líneas libres no
 * entran: su impuesto va ENCIMA y ya viaja en `taxCents`/`taxByKind` del
 * snapshot.
 */
export function embeddedMenuTax(
  items: readonly OrderItemForInvoice[],
  restaurantTax: RestaurantTax,
  discountCents = 0,
): EmbeddedMenuTax {
  return saleLines(items, restaurantTax, discountCents).embedded;
}

/** Lo que el snapshot guarda del descuento repartido (`InvoiceSnapshot.discountInLines`). */
export type DiscountInLines = {
  allowanceCents: number;
  freeLineTax?: FreeLineTax[];
};

/**
 * La marca `discountInLines` del snapshot para unas líneas ya repartidas, o
 * undefined si la cuenta no tiene descuento (la factura de siempre).
 */
export function discountInLinesOf(sale: SaleLines): DiscountInLines | undefined {
  if (sale.discountCents <= 0) return undefined;
  return {
    allowanceCents: sale.allowanceCents,
    ...(sale.freeLineTax ? { freeLineTax: sale.freeLineTax } : {}),
  };
}

/** Lo que hace falta de un snapshot para pasarlo a «descuento en las líneas». */
type DiscountSnapshot = {
  discountCents?: number;
  embeddedTaxCents?: number;
  embeddedBaseCents?: number;
  discountInLines?: DiscountInLines;
};

/**
 * Snapshot de una factura con descuento que todavía NO lo declara en las
 * líneas (emitida antes del arreglo) y que la DIAN no ha aceptado: al
 * (re)enviarla, el XML sale con el descuento adentro, así que el snapshot
 * pasa a decir lo mismo — impuesto embebido neto y la marca. Devuelve null
 * si no hay nada que cambiar (sin descuento, o ya con la marca).
 */
export function withDiscountInLines<S extends DiscountSnapshot>(
  snapshot: S,
  sale: SaleLines,
): S | null {
  if ((snapshot.discountCents ?? 0) <= 0 || snapshot.discountInLines) return null;
  const marker = discountInLinesOf(sale);
  if (!marker) return null;
  return {
    ...snapshot,
    embeddedTaxCents: sale.embedded.taxCents,
    embeddedBaseCents: sale.embedded.baseCents,
    discountInLines: marker,
  };
}
