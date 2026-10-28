import { DEFAULT_INPUT_UNIT, displayUnitFor, toBaseQty, type MeasureKind } from './units';
import { effectiveCountParts, MAX_COUNT_PARTS, MAX_COUNT_QTY } from './stockCountParts';

export type CountEntry = { raw: string; unit: string };

export function countEntryFromBase(value: number | null, kind: MeasureKind) {
  if (value == null) return { raw: '', unit: DEFAULT_INPUT_UNIT[kind] };
  const unit = displayUnitFor(value, kind);
  return { raw: String(value / unit.factor), unit: unit.symbol };
}

export function parseCountEntry(raw: string, kind: MeasureKind, unit: string): number | null | 'invalid' {
  if (!raw.trim()) return null;
  const value = Number(raw.trim().replace(',', '.'));
  if (!Number.isFinite(value) || value < 0) return 'invalid';
  if (value === 0) return 0;
  return toBaseQty(value, kind, unit) ?? 'invalid';
}

/** Historical counts have only a total. Parts from older writers may be stale. */
export function countEntriesFromBase(total: number | null, kind: MeasureKind, parts?: unknown): CountEntry[] {
  const values = effectiveCountParts(total, parts);
  return values.length ? values.map(value => countEntryFromBase(value, kind)) : [countEntryFromBase(null, kind)];
}

/** Convert each amount separately before adding; blanks never imply zero. */
export function parseCountEntries(entries: readonly CountEntry[], kind: MeasureKind): { countedQty: number | null; countedParts: number[] } | 'invalid' {
  if (entries.length > MAX_COUNT_PARTS) return 'invalid';
  const countedParts: number[] = [];
  let total = 0;
  for (const entry of entries) {
    const value = parseCountEntry(entry.raw, kind, entry.unit);
    if (value === 'invalid') return 'invalid';
    if (value === null) continue;
    total += value;
    if (total > MAX_COUNT_QTY) return 'invalid';
    countedParts.push(value);
  }
  return { countedQty: countedParts.length ? total : null, countedParts };
}

/** A scan opens one amount, reusing an unfinished field if there is one. */
export function nextCountEntry(entries: readonly CountEntry[], kind: MeasureKind): { entries: CountEntry[]; index: number } | null {
  const unfinished = entries.findIndex(entry => {
    const value = parseCountEntry(entry.raw, kind, entry.unit);
    return value === null || value === 'invalid';
  });
  if (unfinished !== -1) return { entries: [...entries], index: unfinished };
  if (entries.length >= MAX_COUNT_PARTS) return null;
  return {
    entries: [...entries, { raw: '', unit: entries.at(-1)?.unit ?? DEFAULT_INPUT_UNIT[kind] }],
    index: entries.length,
  };
}

export function formatCountQty(value: number, kind: MeasureKind, locale: string): string {
  const unit = displayUnitFor(value, kind);
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: unit.factor > 1 ? 3 : 0 }).format(value / unit.factor)} ${unit.symbol}`;
}
