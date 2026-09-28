import type { Shift } from "@prisma/client";

type StoredCash = number | bigint;
type ShiftCashAmounts = {
  openingCashCents: StoredCash;
  declaredCashCents: StoredCash | null;
  expectedCashCents: StoredCash | null;
  cashDiffCents: StoredCash | null;
};
type NumericCashAmounts = {
  openingCashCents: number;
  declaredCashCents: number | null;
  expectedCashCents: number | null;
  cashDiffCents: number | null;
};

export type CashShift = Omit<Shift, keyof ShiftCashAmounts> & NumericCashAmounts;

/**
 * Shift totals need BIGINT in PostgreSQL (INT4 only holds $21,474,836.47).
 * The existing API uses integer cents as JSON numbers. Keep that contract
 * explicitly, rejecting values that JavaScript cannot represent exactly.
 * The database migration enforces the same safe-integer range.
 */
export function cashCentsToNumber(value: StoredCash): number;
export function cashCentsToNumber(value: StoredCash | null): number | null;
export function cashCentsToNumber(value: StoredCash | null): number | null {
  if (value === null) return null;
  const amount = Number(value);
  if (!Number.isSafeInteger(amount)) throw new RangeError("cash_amount_out_of_range");
  return amount;
}

/** Normalize at the read boundary, before arithmetic or JSON/RSC output. */
export function shiftCashToNumbers<T extends ShiftCashAmounts>(
  shift: T,
): Omit<T, keyof ShiftCashAmounts> & NumericCashAmounts {
  return {
    ...shift,
    openingCashCents: cashCentsToNumber(shift.openingCashCents),
    declaredCashCents: cashCentsToNumber(shift.declaredCashCents),
    expectedCashCents: cashCentsToNumber(shift.expectedCashCents),
    cashDiffCents: cashCentsToNumber(shift.cashDiffCents),
  };
}
