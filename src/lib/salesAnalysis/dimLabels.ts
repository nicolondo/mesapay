// Nombres a mostrar de períodos, canales, métodos y valores de filtro. Recibe
// el traductor (sirve el de servidor y el de cliente, namespace
// `salesAnalysis`) y las opciones cargadas para resolver ids a nombres.
import type { Locale } from "@/i18n/config";
import type { Channel, Dimension, DimensionFilters, ReportingMethod, SalesFilters } from "@/lib/salesAnalysis/filters";
import { NO_WAITER, parsePeriodToken } from "@/lib/salesAnalysis/filters";
import type { FilterOptions } from "@/lib/salesAnalysis/types";
import { fmtRange, hourLabel, weekdayName } from "./labels";

export type Tr = (key: string, values?: Record<string, string | number>) => string;

export function channelLabel(channel: Channel, t: Tr, counterMode: boolean): string {
  if (channel === "salon") return t(counterMode ? "channel.counter" : "channel.salon");
  return t(`channel.${channel}`);
}

export function methodLabel(method: ReportingMethod | string, t: Tr): string {
  return t(`method.${method}`);
}

export function periodLabel(
  f: Pick<SalesFilters, "period" | "desde" | "hasta">,
  t: Tr,
  locale: Locale,
): string {
  if (f.period === "rango" && f.desde && f.hasta) return fmtRange({ from: f.desde, to: f.hasta }, locale);
  return t(`period.${f.period}`);
}

export function originLabel(token: string | null, t: Tr, locale: Locale): string | null {
  const parsed = parsePeriodToken(token);
  return parsed ? periodLabel(parsed, t, locale) : null;
}

export function tableName(table: { number: number; label: string | null }, t: Tr): string {
  return table.label ? `${t("tableNumber", { number: table.number })} · ${table.label}` : t("tableNumber", { number: table.number });
}

export function categoryName(c: { label: string | null; parentLabel: string | null }, t: Tr): string {
  if (!c.label) return t("freeLines");
  return c.parentLabel ? `${c.parentLabel} › ${c.label}` : c.label;
}

/** Valor legible de un filtro de dimensión. */
export function dimValueLabel<D extends Dimension>(
  dim: D,
  value: NonNullable<DimensionFilters[D]>,
  ctx: { t: Tr; locale: Locale; options: FilterOptions; counterMode: boolean },
): string {
  const { t, locale, options } = ctx;
  switch (dim) {
    case "canal":
      return channelLabel(value as Channel, t, ctx.counterMode);
    case "pago":
      return methodLabel(value as ReportingMethod, t);
    case "dia":
      return weekdayName(value as number, locale, "long");
    case "hora":
      return hourLabel(value as number);
    case "mesero":
      if (value === NO_WAITER) return t("noWaiter");
      return options.waiters.find((w) => w.id === value)?.name ?? t("unknownValue");
    case "categoria": {
      const c = options.categories.find((x) => x.id === value);
      return c ? categoryName(c, t) : t("unknownValue");
    }
    case "producto":
      return options.products.find((p) => p.id === value)?.name ?? t("unknownValue");
    case "mesa": {
      const table = options.tables.find((x) => x.id === value);
      return table ? tableName(table, t) : t("unknownValue");
    }
    default:
      return String(value);
  }
}

export function dimName(dim: Dimension, t: Tr): string {
  return t(`dim.${dim}`);
}
