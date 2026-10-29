import { MAX_TIP_PCT } from "@/lib/tips";

/** Same per-payment bounds as the existing payment APIs. All values are cents. */
export const MIN_MIXED_PAYMENT_CENTS = 100;
export const MAX_MIXED_PAYMENT_CENTS = 2_000_000_000;

export type MixedPaymentBudgetInput = Readonly<{
  /** Account consumption after discounts and any tax added on top. */
  netSubtotalCents: number;
  /** Approved payment totals only, including their tips. */
  paidCents: number;
  paidTipCents: number;
  /** Explicit account-wide choice, not a fresh percentage per payment. */
  tipPct: number;
}>;

export type MixedPaymentBudget = Readonly<{
  ok: true;
  targetTipCents: number;
  remainingTipCents: number;
  outstandingFoodCents: number;
  outstandingGrossCents: number;
}> | Readonly<{ ok: false; error: "invalid_balance" }>;

export type MixedPaymentError =
  | "invalid_balance" | "empty_amount" | "invalid_amount"
  | "amount_too_small" | "amount_too_large" | "amount_exceeds_outstanding"
  | "remainder_too_small" | "amount_leaves_tip_only" | "nothing_outstanding";

export type MixedPaymentAllocation = Readonly<{
  ok: true;
  amountCents: number;
  tipCents: number;
  foodCents: number;
  remainingFoodCents: number;
  remainingTipCents: number;
  remainingGrossCents: number;
}> | Readonly<{ ok: false; error: MixedPaymentError }>;

const validCents = (value: number) => Number.isSafeInteger(value) && value >= 0;

/** Positive-integer half-up rounding without lossy floating-point products. */
function roundedRatio(numerator: bigint, denominator: bigint): number {
  return Number((numerator * BigInt(2) + denominator) / (denominator * BigInt(2)));
}

/**
 * Approved amounts remain immutable. A revised tip percentage changes only
 * what the operator can explicitly confirm next, never a past payment.
 * Once consumption is paid, the server closes the account; no tip-only
 * payment is offered afterward, even if the selected target was higher.
 */
export function mixedPaymentBudget(input: MixedPaymentBudgetInput): MixedPaymentBudget {
  const { netSubtotalCents, paidCents, paidTipCents, tipPct } = input;
  if (![netSubtotalCents, paidCents, paidTipCents].every(validCents)
    || paidTipCents > paidCents || !Number.isInteger(tipPct) || tipPct < 0 || tipPct > MAX_TIP_PCT) {
    return { ok: false, error: "invalid_balance" };
  }
  const targetTipCents = roundedRatio(BigInt(netSubtotalCents) * BigInt(tipPct), BigInt(100));
  const outstandingFoodCents = Math.max(0, netSubtotalCents - (paidCents - paidTipCents));
  const remainingTipCents = outstandingFoodCents === 0 ? 0 : Math.max(0, targetTipCents - paidTipCents);
  const outstandingGrossCents = outstandingFoodCents + remainingTipCents;
  if (!validCents(outstandingGrossCents)) return { ok: false, error: "invalid_balance" };
  return { ok: true, targetTipCents, remainingTipCents, outstandingFoodCents, outstandingGrossCents };
}

/**
 * The entered amount is the TOTAL for this method, including its tip.
 * Allocate against the remaining budget, then leave the exact remainder
 * for the next method. Selecting all consumes both budgets exactly.
 */
export function allocateMixedPayment(
  budget: MixedPaymentBudget,
  selectedGrossCents: number | null | undefined,
): MixedPaymentAllocation {
  if (!budget.ok) return budget;
  if (selectedGrossCents == null) return { ok: false, error: "empty_amount" };
  if (!validCents(selectedGrossCents)) return { ok: false, error: "invalid_amount" };
  if (selectedGrossCents < MIN_MIXED_PAYMENT_CENTS) return { ok: false, error: "amount_too_small" };
  if (selectedGrossCents > MAX_MIXED_PAYMENT_CENTS) return { ok: false, error: "amount_too_large" };
  if (budget.outstandingGrossCents === 0) return { ok: false, error: "nothing_outstanding" };
  if (selectedGrossCents > budget.outstandingGrossCents) return { ok: false, error: "amount_exceeds_outstanding" };
  const remainingGrossCents = budget.outstandingGrossCents - selectedGrossCents;
  // Existing APIs reject a payment below one peso. Do not strand such a
  // balance: the operator must include it now or choose a smaller amount.
  if (remainingGrossCents > 0 && remainingGrossCents < MIN_MIXED_PAYMENT_CENTS) {
    return { ok: false, error: "remainder_too_small" };
  }
  const tipCents = roundedRatio(
    BigInt(selectedGrossCents) * BigInt(budget.remainingTipCents),
    BigInt(budget.outstandingGrossCents),
  );
  const foodCents = selectedGrossCents - tipCents;
  if (foodCents === 0) return { ok: false, error: "amount_too_small" };
  const remainingFoodCents = budget.outstandingFoodCents - foodCents;
  const remainingTipCents = budget.remainingTipCents - tipCents;
  // The server closes on food coverage. A partial must not accidentally
  // close before the operator confirms the rest of the chosen tip.
  if (remainingFoodCents === 0 && remainingTipCents > 0) {
    return { ok: false, error: "amount_leaves_tip_only" };
  }
  return {
    ok: true, amountCents: selectedGrossCents, tipCents, foodCents,
    remainingFoodCents, remainingTipCents, remainingGrossCents,
  };
}
