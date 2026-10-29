/** Consumption tax from the issued invoice, never today's restaurant rate. */
export type ConsumptionTaxSummary = {
  consumptionTaxCents: number;
  taxPendingPayments: number;
};

export type FiscalPayment = {
  id: string;
  amountCents: number;
  tipCents: number;
  settledAt: Date | null;
  createdAt: Date;
};

export type FrozenTaxInvoice = { totalCents: number; fiscal: unknown };

const money = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function frozenTax(invoice: FrozenTaxInvoice | null): { tax: number; denominator: number } | null {
  if (!invoice || !object(invoice.fiscal)) return null;
  const s = invoice.fiscal;
  if (!money(s.totalCents) || !money(s.tipCents) || s.tipCents > s.totalCents
    || s.totalCents !== invoice.totalCents) return null;
  const denominator = s.totalCents - s.tipCents;
  const addedTax = s.taxCents === undefined ? 0 : s.taxCents;
  const embedded = s.embeddedTaxCents === undefined ? 0 : s.embeddedTaxCents;
  if (!money(addedTax) || !money(embedded)) return null;
  let addedInc = 0;
  if (s.taxByKind !== undefined) {
    if (!object(s.taxByKind) || !money(s.taxByKind.inc) || !money(s.taxByKind.iva)
      || BigInt(s.taxByKind.inc) + BigInt(s.taxByKind.iva) !== BigInt(addedTax)) return null;
    addedInc = s.taxByKind.inc;
  } else if (addedTax !== 0) return null;
  const kind = s.salesTaxKind === undefined ? "none" : s.salesTaxKind;
  if (!["none", "inc", "iva"].includes(kind as string)
    || (kind === "none" && embedded !== 0)
    || BigInt(addedTax) + BigInt(embedded) > BigInt(denominator)) return null;
  // Old invoices without embedded fields were issued without that tax.
  return { denominator, tax: addedInc + (kind === "inc" ? embedded : 0) };
}

const pending = (): ConsumptionTaxSummary => ({ consumptionTaxCents: 0, taxPendingPayments: 1 });

/**
 * Allocate across ALL originally settled payments, including refunded ones.
 * A shift selects its payment IDs only after allocation: refunds, later shifts
 * and differing tips must not move an earlier payment's tax into another one.
 */
export function allocateShiftConsumptionTax(
  invoice: FrozenTaxInvoice | null,
  payments: readonly FiscalPayment[],
): Map<string, ConsumptionTaxSummary> {
  const frozen = frozenTax(invoice);
  const reliable = payments.every((p) => money(p.amountCents) && money(p.tipCents)
    && p.tipCents <= p.amountCents && Number.isFinite((p.settledAt ?? p.createdAt).getTime()));
  if (!frozen || !reliable || (frozen.denominator === 0 && payments.some((p) => p.amountCents !== p.tipCents))) {
    return new Map(payments.map((p) => [p.id, pending()]));
  }
  const sorted = [...payments].sort((a, b) =>
    (a.settledAt ?? a.createdAt).getTime() - (b.settledAt ?? b.createdAt).getTime()
    || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const denominator = BigInt(frozen.denominator);
  const tax = BigInt(frozen.tax);
  let paid = BigInt(0);
  let allocated = BigInt(0);
  return new Map(sorted.map((p) => {
    paid += BigInt(p.amountCents - p.tipCents);
    const capped = paid > denominator ? denominator : paid;
    // Positive-integer half-up rounding; BigInt preserves large products.
    const cumulative = denominator === BigInt(0) ? BigInt(0)
      : (capped * tax * BigInt(2) + denominator) / (denominator * BigInt(2));
    const consumptionTaxCents = Number(cumulative - allocated);
    allocated = cumulative;
    return [p.id, { consumptionTaxCents, taxPendingPayments: 0 }];
  }));
}

export function sumShiftConsumptionTax(
  allocations: ReadonlyMap<string, ConsumptionTaxSummary>,
  paymentIds: readonly string[],
): ConsumptionTaxSummary {
  let consumptionTaxCents = 0;
  let taxPendingPayments = 0;
  for (const id of new Set(paymentIds)) {
    const row = allocations.get(id) ?? pending();
    consumptionTaxCents += row.consumptionTaxCents;
    taxPendingPayments += row.taxPendingPayments;
  }
  return { consumptionTaxCents, taxPendingPayments };
}
