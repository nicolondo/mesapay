import { categorySelection } from "./categorySelection";
import type { Locale } from "@/i18n/config";
import { compareTableIdentity } from "@/lib/tables/sortTables";
import { categoryName, channelLabel, methodLabel, tableName, type Tr } from "./dimLabels";
import { CHANNELS, NO_WAITER, REPORTING_METHODS } from "./filters";
import type { FilterOptions } from "./types";

type Choice = { value: string; label: string };

// Dos etiquetas pueden ser equivalentes para el idioma. El id único desempata.
function compareId(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function buildFilterChoices(
  options: FilterOptions,
  t: Tr,
  locale: Locale,
  counterMode: boolean,
  categoryIds?: string[],
) {
  const { compare } = new Intl.Collator(locale, { sensitivity: "base", numeric: true });
  const all = { value: "", label: t("all") };
  const alphabetical = (choices: Choice[]) => [
    all, ...choices.sort((a, b) => compare(a.label, b.label) || compareId(a.value, b.value)),
  ];

  const categories = [...options.categories].sort((a, b) =>
    compare(a.parentLabel ?? a.label, b.parentLabel ?? b.label) ||
    compareId(a.parentId ?? a.id, b.parentId ?? b.id) ||
    compare(a.parentLabel ? a.label : "", b.parentLabel ? b.label : "") ||
    compareId(a.id, b.id),
  );
  const { included } = categorySelection(categories, categoryIds);
  const products = included.size
    ? options.products.filter((p) => included.has(p.categoryId))
    : options.products;

  return {
    categoria: categories.map((c) => ({ value: c.id, parentId: c.parentId, label: categoryName(c, t) })),
    canal: alphabetical(CHANNELS.map((c) => ({ value: c, label: channelLabel(c, t, counterMode) }))),
    mesero: alphabetical([
      ...options.waiters.map((w) => ({
        value: w.id,
        label: w.disabled ? t("disabledWaiter", { name: w.name }) : w.name,
      })),
      { value: NO_WAITER, label: t("noWaiter") },
    ]),
    producto: alphabetical(products.map((p) => ({ value: p.id, label: p.name }))),
    pago: alphabetical(REPORTING_METHODS.map((m) => ({ value: m, label: methodLabel(m, t) }))),
    mesa: [all, ...[...options.tables].sort(compareTableIdentity).map((x) => ({
      value: x.id, label: tableName(x, t),
    }))],
  };
}
