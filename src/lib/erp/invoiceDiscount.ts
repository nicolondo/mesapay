// Descuentos del proveedor en la factura importada — LÓGICA PURA, sin DB.
//
// La IA solo TRANSCRIBE lo impreso (precio de lista, % y valor del descuento
// de cada línea, "Total descuentos" del pie). Aquí se decide, con aritmética
// determinista, cómo prellenar la revisión:
//
//  - Si la factura imprime lista + descuento y cuadra con el importe leído,
//    la línea se muestra así (lista, descuento) llegando EXACTAMENTE al mismo
//    neto. Si solo imprime el neto, se deja neto y sin descuento.
//  - El riesgo principal es descontar dos veces: un precio neto que ya trae el
//    descuento NO se vuelve a descontar. Ante la duda (ninguna hipótesis
//    cuadra con los totales impresos) se deja lo leído y se avisa.
//  - El "Total descuentos" del pie suele ser la suma de los de las líneas. Solo
//    lo que sobra se trata como descuento del total, y solo si el total
//    impreso lo confirma.
//  - IVA: en Colombia el descuento comercial impreso reduce la base. Si el IVA
//    impreso se calculó antes del descuento, el impreso gana y se marca.

import type { InvoiceTaxDocument, InvoiceTaxLine } from "./invoiceTaxBasis";
import { resolveReviewInvoice, reviewLineAmounts, type InvoiceReviewLine } from "./invoiceReviewLine";
import { discountAmountCents } from "./purchaseDiscount";
import { lineTaxCents } from "./purchaseTax";

export type InvoiceDiscountLine = InvoiceTaxLine & {
  /** Precio unitario impreso ANTES del descuento, sin impuestos. */
  listUnitPriceCents?: number | null;
  /** % de descuento impreso en la línea (0–100, admite decimales). */
  lineDiscountPct?: number | null;
  /** Valor TOTAL del descuento impreso en la línea. */
  lineDiscountCents?: number | null;
};

export type InvoiceDiscountDocument = Omit<InvoiceTaxDocument, "lines"> & {
  lines: InvoiceDiscountLine[];
};

export type InvoiceDiscountPrefill = {
  lines: InvoiceReviewLine[];
  /** Descuento sobre el total, como lo digita el operador. */
  orderDiscRaw: string;
  orderDiscIsPct: boolean;
  orderDiscountFromInvoice: boolean;
  /** Descuento impreso que no se pudo ubicar con los totales: NO se aplicó. */
  unplacedDiscountCents: number | null;
  /** El IVA impreso se calculó antes del descuento; se conservó el impreso. */
  taxBeforeDiscount: boolean;
};

const MAX_CENTS = 2_000_000_000;
const LINE_TOLERANCE = 100; // $1 por línea: redondeo del proveedor.
const documentTolerance = (lines: number) => 100 + 50 * lines;
const near = (a: number, b: number, tolerance: number) => Math.abs(a - b) <= tolerance;
const positiveCents = (value: number | null | undefined): value is number =>
  value != null && Number.isSafeInteger(value) && value > 0 && value <= MAX_CENTS;
const validCents = (value: number | null | undefined): value is number =>
  value != null && Number.isSafeInteger(value) && value >= 0 && value <= MAX_CENTS;
/** Mismo formato de pesos que `initialInvoicePrice` (MoneyInput). */
const pesos = (cents: number) => String(cents / 100);

function printedPct(line: InvoiceDiscountLine): number | null {
  const pct = line.lineDiscountPct;
  return pct != null && Number.isFinite(pct) && pct > 0 && pct < 100 ? pct : null;
}

function wholeLine(unitCents: number | null | undefined, quantity: number): number | null {
  if (!positiveCents(unitCents) || !Number.isFinite(quantity) || quantity <= 0) return null;
  const total = Math.round(unitCents * quantity);
  return positiveCents(total) ? total : null;
}

/** Un IVA impreso en pesos enteros admite el redondeo del proveedor. */
function taxNear(printed: number, computed: number): boolean {
  return near(printed, computed, printed % 100 === 0 ? 50 : 1);
}

function typedCents(value: string): number | null {
  if (!/^\d+(?:[.,]\d{0,2})?$/.test(value.trim())) return null;
  const cents = Math.round(Number(value.replace(",", ".")) * 100);
  return Number.isSafeInteger(cents) ? cents : null;
}

/**
 * La línea con su precio de lista y su descuento. `listCents` es el importe
 * antes de impuestos de toda la línea; `offCents` el descuento que lleva al
 * neto. Se muestra el % impreso solo si reproduce exactamente ese valor.
 * `keepTax`: el importe leído ya traía el descuento, así que su IVA (impreso
 * o derivado) se conserva tal cual — el total de la línea no cambia.
 */
function withListAndDiscount(
  line: InvoiceReviewLine,
  amounts: { taxCents: number },
  listCents: number,
  offCents: number,
  pct: number | null,
  keepTax: boolean,
): InvoiceReviewLine {
  const usePct = pct != null && discountAmountCents(listCents, { pct }) === offCents;
  const taxAmount = keepTax && (line.taxAmount.trim() !== "" || line.taxBasis !== "net")
    ? pesos(amounts.taxCents) : line.taxAmount;
  const printedTax = line.taxAmount.trim() === "" ? null : typedCents(line.taxAmount);
  const pctTax = line.taxPct ?? 0;
  // A printed VAT matching the undiscounted base, and not the discounted one,
  // was computed before the discount. It still wins; the review flags it.
  const taxBeforeDiscount = !keepTax && printedTax != null && pctTax > 0
    && taxNear(printedTax, lineTaxCents(listCents, pctTax))
    && !taxNear(printedTax, lineTaxCents(listCents - offCents, pctTax));
  return {
    ...line,
    cost: pesos(listCents),
    amountKind: "line",
    taxBasis: "net",
    taxBasisManual: false,
    taxAmount,
    discRaw: usePct ? String(pct) : pesos(offCents),
    discIsPct: usePct,
    amountLabel: null,
    discountFromInvoice: true,
    discountUnmatched: false,
    taxBeforeDiscount,
  };
}

type LineOutcome =
  | { kind: "none" }
  | { kind: "definite"; line: InvoiceReviewLine; discountCents: number }
  | { kind: "ambiguous"; keep: InvoiceReviewLine; apply: InvoiceReviewLine; discountCents: number }
  | { kind: "unmatched"; line: InvoiceReviewLine; discountCents: number | null };

function lineOutcome(ext: InvoiceDiscountLine, line: InvoiceReviewLine): LineOutcome {
  const pct = printedPct(ext);
  const value = positiveCents(ext.lineDiscountCents) ? ext.lineDiscountCents : null;
  if (pct == null && value == null) return { kind: "none" };
  const unmatched = (discountCents: number | null): LineOutcome =>
    ({ kind: "unmatched", line: { ...line, discountUnmatched: true }, discountCents });
  const amounts = reviewLineAmounts(line);
  if (!amounts) return unmatched(value);
  const net = amounts.netCents;
  const discountOf = (list: number) => value ?? Math.round((list * pct!) / 100);

  // 1) Precio de lista impreso: decide por sí solo.
  const list = wholeLine(ext.listUnitPriceCents, ext.quantity);
  if (list != null) {
    const off = discountOf(list);
    // The amount read already contains the discount: show it, same net.
    if (off < list && near(net, list - off, LINE_TOLERANCE) && list - net > 0) {
      return { kind: "definite", line: withListAndDiscount(line, amounts, list, list - net, pct, true), discountCents: list - net };
    }
    // The amount read IS the list price: the printed discount must be applied.
    if (off > LINE_TOLERANCE && off < list && near(net, list, LINE_TOLERANCE)) {
      return { kind: "definite", line: withListAndDiscount(line, amounts, list, off, pct, false), discountCents: off };
    }
    return unmatched(off);
  }

  // 2) Sin precio de lista: el unitario impreso puede ser el de lista.
  const unit = wholeLine(ext.unitPriceCents, ext.quantity);
  if (unit != null) {
    const off = discountOf(unit);
    // A printed line total after the discount next to a pre-discount unit price.
    if (line.amountKind === "line" && off > LINE_TOLERANCE && off < unit && near(net, unit - off, LINE_TOLERANCE)) {
      return { kind: "definite", line: withListAndDiscount(line, amounts, unit, unit - net, pct, true), discountCents: unit - net };
    }
    // Same amount before and after: only the printed total can tell which.
    if (off > LINE_TOLERANCE && off < unit && near(net, unit, LINE_TOLERANCE)) {
      return { kind: "ambiguous", keep: line, apply: withListAndDiscount(line, amounts, unit, off, pct, false), discountCents: off };
    }
    return unmatched(off);
  }
  return unmatched(value);
}

/**
 * Prellena descuentos de línea y del total a partir de lo transcrito. Recibe
 * las líneas de revisión ya armadas (insumo, cantidad, importe, impuestos) y
 * devuelve las mismas líneas con su descuento, más el descuento del total.
 * Extracciones viejas (sin los campos de descuento) solo pueden recibir el
 * descuento del total, y únicamente si el total impreso lo confirma.
 */
export function prefillInvoiceDiscounts(
  invoice: InvoiceDiscountDocument,
  lines: InvoiceReviewLine[],
  extras: { incCents: number; retentionsCents: number },
): InvoiceDiscountPrefill {
  const result: InvoiceDiscountPrefill = {
    lines, orderDiscRaw: "", orderDiscIsPct: false, orderDiscountFromInvoice: false,
    unplacedDiscountCents: null, taxBeforeDiscount: false,
  };
  const outcomes: LineOutcome[] = lines.map((line) => {
    const ext = line.sourceLineIndex == null ? undefined : invoice.lines[line.sourceLineIndex];
    return ext ? lineOutcome(ext, line) : { kind: "none" };
  });
  let current = outcomes.map((o, i) =>
    o.kind === "definite" || o.kind === "unmatched" ? o.line : o.kind === "ambiguous" ? o.keep : lines[i]!);
  const printedTotal = validCents(invoice.invoiceTotalCents) ? invoice.invoiceTotalCents : null;
  const tolerance = documentTolerance(lines.length);
  const payable = (reviewLines: InvoiceReviewLine[], orderCents = 0) => {
    const resolved = resolveReviewInvoice(reviewLines, { cents: orderCents });
    return resolved.complete ? resolved.totalCents + extras.incCents - extras.retentionsCents : null;
  };
  const matchesTotal = (total: number | null) =>
    printedTotal != null && total != null && near(total, printedTotal, tolerance);

  if (outcomes.some((o) => o.kind === "ambiguous")) {
    const applied = outcomes.map((o, i) => (o.kind === "ambiguous" ? o.apply : current[i]!));
    const keepMatches = matchesTotal(payable(current));
    if (!keepMatches && matchesTotal(payable(applied))) current = applied;
    else if (!keepMatches) {
      current = current.map((l, i) => (outcomes[i]!.kind === "ambiguous" ? { ...l, discountUnmatched: true } : l));
    }
  }

  // "Total descuentos": lo que no explican las líneas es descuento del total.
  let orderCents = 0;
  const printedDiscount = positiveCents(invoice.invoiceDiscountCents) ? invoice.invoiceDiscountCents : 0;
  if (printedDiscount > 0) {
    const quantified = outcomes.every((o) => o.kind === "none" || o.discountCents != null);
    const lineSum = outcomes.reduce((s, o) => s + (o.kind === "none" ? 0 : o.discountCents ?? 0), 0);
    const remainder = quantified ? printedDiscount - lineSum : null;
    if (remainder != null && remainder <= tolerance) {
      // Explained by the line discounts.
    } else if (matchesTotal(payable(current))) {
      // The line amounts already contain it: never discount twice.
    } else if (remainder != null && printedTotal != null) {
      if (matchesTotal(payable(current, remainder))) {
        orderCents = remainder;
      } else {
        // IVA impreso antes del descuento del total: el impreso gana.
        const held = current.map((l) => {
          const amounts = l.taxAmount.trim() === "" ? reviewLineAmounts(l) : null;
          return amounts && amounts.taxCents > 0 ? { ...l, taxAmount: pesos(amounts.taxCents), taxBeforeDiscount: true } : l;
        });
        if (held.some((l, i) => l !== current[i]) && matchesTotal(payable(held, remainder))) {
          current = held;
          orderCents = remainder;
          result.taxBeforeDiscount = true;
        } else {
          result.unplacedDiscountCents = remainder;
        }
      }
    } else if (remainder != null && printedTotal == null && validCents(invoice.invoiceSubtotalCents)) {
      const resolved = resolveReviewInvoice(current, {});
      const inside = resolved.complete && near(resolved.netCents, invoice.invoiceSubtotalCents - printedDiscount, tolerance);
      if (!inside) result.unplacedDiscountCents = remainder;
    } else {
      result.unplacedDiscountCents = remainder ?? printedDiscount;
    }
  }
  if (orderCents > 0) {
    result.orderDiscRaw = pesos(orderCents);
    result.orderDiscountFromInvoice = true;
  }

  // IVA impreso del pie calculado sobre la lista (antes del descuento).
  const printedTax = validCents(invoice.invoiceTaxCents) ? invoice.invoiceTaxCents : null;
  if (printedTax != null) {
    const resolved = resolveReviewInvoice(current, { cents: orderCents });
    if (resolved.complete && !near(resolved.taxCents, printedTax, tolerance)) {
      const alternative = current.map((l, i) => {
        const r = resolved.lines[i]!;
        const pct = l.taxPct ?? 0;
        return l.taxAmount.trim() === "" && pct > 0 && r.lineDiscountCents + r.orderDiscountCents > 0
          ? { ...l, taxAmount: pesos(lineTaxCents(r.listCents, pct)), taxBeforeDiscount: true } : l;
      });
      const changed = alternative.some((l, i) => l !== current[i]);
      const alt = resolveReviewInvoice(alternative, { cents: orderCents });
      const totalOk = printedTotal == null || matchesTotal(payable(alternative, orderCents));
      if (changed && alt.complete && near(alt.taxCents, printedTax, tolerance) && totalOk) {
        current = alternative;
        result.taxBeforeDiscount = true;
      }
    }
  }
  result.lines = current;
  return result;
}
