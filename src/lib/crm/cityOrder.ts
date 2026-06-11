/**
 * Order a list of city names so that "main" cities come first (in the given
 * order, only if they are present in `cities`), followed by the remaining
 * cities sorted alphabetically using Spanish locale with base sensitivity
 * (accent/case-insensitive comparison).
 */
export function orderCities(cities: string[], main: string[]): string[] {
  const citySet = new Set(cities);

  const mains = main.filter((m) => citySet.has(m));
  const mainSet = new Set(mains);

  const rest = cities
    .filter((c) => !mainSet.has(c))
    .sort((a, b) => a.localeCompare(b, "es", { sensitivity: "base" }));

  return [...mains, ...rest];
}
