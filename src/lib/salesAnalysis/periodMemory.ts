import { parsePeriodToken, parseSalesFilters, periodToken, salesHref, DEFAULT_PERIOD, DEFAULT_TIME_AXIS, TIME_AXES, type SalesFilters } from "./filters";

const MAX_AGE = 30 * 86_400_000;

export function serializePeriod(filters: SalesFilters, now: number): string {
  return JSON.stringify({ period: periodToken(filters), axis: filters.axis, categories: filters.dims.categoria, savedAt: now });
}

export function restoredPeriodHref(search: string, stored: string | null, now: number, categoryIds: readonly string[] = []): string | null {
  if (search || !stored) return null;
  try {
    const value = JSON.parse(stored);
    if (!value || !Number.isSafeInteger(value.savedAt) || value.savedAt > now ||
        now - value.savedAt > MAX_AGE || !TIME_AXES.includes(value.axis) ||
        typeof value.period !== "string") return null;
    const selection = parsePeriodToken(value.period);
    if (!selection || periodToken(selection) !== value.period) return null;
    const available = new Set(categoryIds);
    const categories = Array.isArray(value.categories)
      ? value.categories.filter((id: unknown): id is string => typeof id === "string" && available.has(id))
      : [];
    const filters = parseSalesFilters({ categoria: categories });
    if (!filters.dims.categoria && selection.period === DEFAULT_PERIOD && value.axis === DEFAULT_TIME_AXIS) return null;
    return salesHref({ ...filters, ...selection, axis: value.axis });
  } catch {
    return null;
  }
}
