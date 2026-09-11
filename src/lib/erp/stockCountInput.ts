import { DEFAULT_INPUT_UNIT, displayUnitFor, toBaseQty, type MeasureKind } from './units';

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

export function formatCountQty(value: number, kind: MeasureKind, locale: string): string {
  const unit = displayUnitFor(value, kind);
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: unit.factor > 1 ? 3 : 0 }).format(value / unit.factor)} ${unit.symbol}`;
}
