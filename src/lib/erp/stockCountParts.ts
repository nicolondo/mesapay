export const MAX_COUNT_PARTS = 200;
export const MAX_COUNT_QTY = 2_000_000_000;

export function isValidCountQuantity(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= MAX_COUNT_QTY);
}

/** Parts are integer base quantities, never display units. An empty array is
 * uncounted; a counted zero must retain at least one explicit zero part. */
export function isValidCountParts(total: unknown, parts: unknown): parts is number[] {
  if (!isValidCountQuantity(total) || !Array.isArray(parts) || parts.length > MAX_COUNT_PARTS) return false;
  if (total === null) return parts.length === 0;
  if (parts.length === 0) return false;
  let sum = 0;
  for (const value of parts) {
    if (!isValidCountQuantity(value) || value === null) return false;
    sum += value;
    if (sum > MAX_COUNT_QTY) return false;
  }
  return sum === total;
}

/** Historical rows have no breakdown. Older writers can also change only the
 * total. The stored total remains authoritative in either case; do not invent
 * scans or change inventory when normalizing a read. */
export function effectiveCountParts(total: number | null, parts: unknown): number[] {
  if (isValidCountParts(total, parts)) return [...parts];
  return total !== null && isValidCountQuantity(total) ? [total] : [];
}
