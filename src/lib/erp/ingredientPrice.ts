import { pesosToCents } from "@/lib/format";
import type { MeasureKind } from "./units";

/** One kg, liter or whole unit is always 1000 base units. */
export const REFERENCE_PRICE_QTY_BASE = 1000;
const MAX_AMOUNT = 2_000_000_000;

export function referencePriceUnit(kind: MeasureKind): string {
  return { mass: "kg", volume: "L", count: "un" }[kind];
}

/** MoneyInput supplies ungrouped major units with a decimal point. */
export function parseReferencePriceInput(raw: string): number | null | "invalid" {
  const value = raw.trim();
  if (!value) return null;
  if (!/^\d+(?:\.\d{0,2})?$/.test(value)) return "invalid";
  const cents = pesosToCents(Number(value));
  return Number.isSafeInteger(cents) && cents >= 0 && cents <= MAX_AMOUNT
    ? cents
    : "invalid";
}

/** Rounded cents for a future purchase; never used to revalue existing stock. */
export function referenceLineCost(
  priceCents: number | null | undefined,
  qtyBase: number,
): number | null {
  if (priceCents == null || !Number.isSafeInteger(priceCents) ||
      priceCents < 0 || priceCents > MAX_AMOUNT ||
      !Number.isSafeInteger(qtyBase) || qtyBase <= 0 || qtyBase > MAX_AMOUNT) {
    return null;
  }
  const amount = (BigInt(priceCents) * BigInt(qtyBase) + BigInt(REFERENCE_PRICE_QTY_BASE / 2)) / BigInt(REFERENCE_PRICE_QTY_BASE);
  return amount <= BigInt(MAX_AMOUNT) ? Number(amount) : null;
}
