// Filtros del análisis de ventas ⇄ URL — LÓGICA PURA.
//
// Todo el estado de la pantalla vive en la URL para poder compartirla y
// volver con «atrás»: período, comparación, granularidad y los filtros de
// dimensión. Lo que no valida se DESCARTA (nunca rompe la página): un
// enlace viejo o editado a mano cae al período por defecto.
//
// Los filtros de dimensión conservan el ORDEN en que se aplicaron (el orden
// de la URL): con eso se arman las migas para volver atrás un paso a la vez.
import type { PaymentMethod } from "@prisma/client";
import {
  COMPARE_MODES,
  GRANULARITIES,
  MAX_RANGE_DAYS,
  PERIOD_PRESETS,
  comparisonRange,
  diffDays,
  isIsoDate,
  presetRange,
  type CompareMode,
  type DayRange,
  type Granularity,
  type PeriodKind,
  type PeriodPreset,
} from "./period";
import { addDaysIso } from "@/lib/bogota";

export const SALES_ANALYSIS_PATH = "/operator/reports/ventas";
export const SALES_EXPORT_PATH = "/api/operator/reports/ventas/export";

export const DEFAULT_PERIOD: PeriodPreset = "30d";
export const DEFAULT_COMPARE: CompareMode = "anterior";

/** Canal de la cuenta: salón (o mostrador), para llevar, o factura manual. */
export const CHANNELS = ["salon", "llevar", "manual"] as const;
export type Channel = (typeof CHANNELS)[number];

/**
 * Métodos de pago tal como se agrupan en reportes: el efectivo histórico
 * (`demo_cash`) va dentro de `cash` (ver `reportingPaymentMethod`).
 * Es un `Record` sobre el enum para que un método nuevo no compile hasta
 * decidir si se ofrece como filtro.
 */
const REPORTING_METHOD: Record<PaymentMethod, boolean> = {
  cash: true,
  demo_cash: false,
  demo_card: true,
  wompi_card: true,
  wompi_pse: true,
  wompi_nequi: true,
  kushki_apple_pay: true,
  kushki_google_pay: true,
  kushki_card_terminal: true,
  external_terminal: true,
  kushki_pse: true,
  kushki_card: true,
  reservation_deposit: true,
  voucher: true,
  customer_credit: true,
};
export const REPORTING_METHODS = (Object.keys(REPORTING_METHOD) as PaymentMethod[]).filter(
  (m) => REPORTING_METHOD[m],
);
export type ReportingMethod = Exclude<PaymentMethod, "demo_cash">;

/** Métodos crudos de la base que cubre un método de reporte. */
export function methodsForFilter(method: ReportingMethod): PaymentMethod[] {
  return method === "cash" ? ["cash", "demo_cash"] : [method];
}

/** Valor especial del filtro de mesero: cuentas sin mesero identificable. */
export const NO_WAITER = "ninguno";

export const DIMENSIONS = ["canal", "mesero", "categoria", "producto", "pago", "mesa", "dia", "hora"] as const;
export type Dimension = (typeof DIMENSIONS)[number];

/** Dimensiones que filtran LÍNEAS (no cuentas enteras). */
export const ITEM_DIMENSIONS: readonly Dimension[] = ["categoria", "producto"];

export type DimensionFilters = {
  canal?: Channel;
  mesero?: string;
  categoria?: string;
  producto?: string;
  pago?: ReportingMethod;
  mesa?: string;
  /** Día de la semana ISO del día operativo: 1 = lunes … 7 = domingo. */
  dia?: number;
  /** Hora del reloj (Bogotá) del pago, 0–23. */
  hora?: number;
};

export type SalesFilters = {
  period: PeriodKind;
  /** Sólo con `period = "rango"`. */
  desde: string | null;
  hasta: string | null;
  /** Período «padre» desde el que se entró a un día/semana (migas). */
  origen: string | null;
  compare: CompareMode;
  granularity: Granularity | "auto";
  dims: DimensionFilters;
  /** Orden en que se aplicaron los filtros de dimensión. */
  dimOrder: Dimension[];
};

export type SearchInput =
  | URLSearchParams
  | Record<string, string | string[] | undefined>;

const ID = /^[A-Za-z0-9_-]{1,64}$/;

function first(v: string | string[] | undefined | null): string | undefined {
  if (Array.isArray(v)) return v[0];
  return v ?? undefined;
}

/** Entradas en el orden de la URL (los objetos de Next conservan ese orden). */
function entries(input: SearchInput): [string, string][] {
  if (input instanceof URLSearchParams) {
    const seen = new Set<string>();
    const out: [string, string][] = [];
    for (const [k, v] of input) {
      if (seen.has(k)) continue;
      seen.add(k);
      out.push([k, v]);
    }
    return out;
  }
  return Object.entries(input)
    .map(([k, v]) => [k, first(v)] as [string, string | undefined])
    .filter((e): e is [string, string] => typeof e[1] === "string");
}

/** Valida un valor de dimensión; `undefined` si no sirve. */
export function parseDimension<D extends Dimension>(
  key: D,
  raw: string | undefined,
): DimensionFilters[D] | undefined {
  if (raw === undefined) return undefined;
  const v = raw.trim();
  switch (key) {
    case "canal":
      return ((CHANNELS as readonly string[]).includes(v) ? v : undefined) as DimensionFilters[D];
    case "pago":
      return ((REPORTING_METHODS as readonly string[]).includes(v) ? v : undefined) as DimensionFilters[D];
    case "dia": {
      const n = /^[1-7]$/.test(v) ? Number(v) : undefined;
      return n as DimensionFilters[D];
    }
    case "hora": {
      const n = /^\d{1,2}$/.test(v) && Number(v) <= 23 ? Number(v) : undefined;
      return n as DimensionFilters[D];
    }
    default:
      return (ID.test(v) ? v : undefined) as DimensionFilters[D];
  }
}

/** Token de un período para `origen`: "30d" o "rango:2026-09-01:2026-09-30". */
export function periodToken(f: Pick<SalesFilters, "period" | "desde" | "hasta">): string {
  return f.period === "rango" ? `rango:${f.desde}:${f.hasta}` : f.period;
}

/** Lee un token de período; null si no valida. */
export function parsePeriodToken(
  token: string | null | undefined,
): Pick<SalesFilters, "period" | "desde" | "hasta"> | null {
  if (!token) return null;
  if ((PERIOD_PRESETS as readonly string[]).includes(token)) {
    return { period: token as PeriodPreset, desde: null, hasta: null };
  }
  const m = /^rango:(\d{4}-\d{2}-\d{2}):(\d{4}-\d{2}-\d{2})$/.exec(token);
  if (!m) return null;
  const range = normalizeRange(m[1], m[2]);
  return range ? { period: "rango", desde: range.from, hasta: range.to } : null;
}

/** Rango personalizado validado: fechas reales, ordenadas y de largo acotado. */
export function normalizeRange(desde: string | undefined, hasta: string | undefined): DayRange | null {
  if (!isIsoDate(desde) || !isIsoDate(hasta)) return null;
  let from = desde;
  let to = hasta;
  if (from > to) [from, to] = [to, from];
  if (diffDays(from, to) + 1 > MAX_RANGE_DAYS) from = addDaysIso(to, -(MAX_RANGE_DAYS - 1));
  return { from, to };
}

export function parseSalesFilters(input: SearchInput): SalesFilters {
  const list = entries(input);
  const get = (k: string) => list.find(([key]) => key === k)?.[1];

  let period: PeriodKind = DEFAULT_PERIOD;
  let desde: string | null = null;
  let hasta: string | null = null;
  const rawPeriod = get("periodo");
  const range = normalizeRange(get("desde"), get("hasta"));
  if (rawPeriod && (PERIOD_PRESETS as readonly string[]).includes(rawPeriod)) {
    period = rawPeriod as PeriodPreset;
  } else if (range && (rawPeriod === undefined || rawPeriod === "rango")) {
    period = "rango";
    desde = range.from;
    hasta = range.to;
  }

  const rawCompare = get("comparar");
  const compare = (COMPARE_MODES as readonly string[]).includes(rawCompare ?? "")
    ? (rawCompare as CompareMode)
    : DEFAULT_COMPARE;
  const rawGran = get("agrupar");
  const granularity = (GRANULARITIES as readonly string[]).includes(rawGran ?? "")
    ? (rawGran as Granularity)
    : "auto";

  const dims: DimensionFilters = {};
  const dimOrder: Dimension[] = [];
  for (const [key, value] of list) {
    if (!(DIMENSIONS as readonly string[]).includes(key)) continue;
    const dim = key as Dimension;
    const parsed = parseDimension(dim, value);
    if (parsed === undefined) continue;
    (dims as Record<Dimension, unknown>)[dim] = parsed;
    dimOrder.push(dim);
  }

  const origenToken = get("origen");
  const origen = period === "rango" && parsePeriodToken(origenToken) ? origenToken! : null;

  return { period, desde, hasta, origen, compare, granularity, dims, dimOrder };
}

/** URL canónica: omite los valores por defecto y respeta el orden de los filtros. */
export function salesFiltersToSearchParams(f: SalesFilters): URLSearchParams {
  const sp = new URLSearchParams();
  if (f.period === "rango" && f.desde && f.hasta) {
    sp.set("periodo", "rango");
    sp.set("desde", f.desde);
    sp.set("hasta", f.hasta);
    if (f.origen) sp.set("origen", f.origen);
  } else if (f.period !== DEFAULT_PERIOD && f.period !== "rango") {
    sp.set("periodo", f.period);
  }
  if (f.compare !== DEFAULT_COMPARE) sp.set("comparar", f.compare);
  if (f.granularity !== "auto") sp.set("agrupar", f.granularity);
  const order = [...f.dimOrder, ...DIMENSIONS.filter((d) => !f.dimOrder.includes(d))];
  for (const d of order) {
    const v = f.dims[d];
    if (v !== undefined) sp.set(d, String(v));
  }
  return sp;
}

export function salesHref(f: SalesFilters, base: string = SALES_ANALYSIS_PATH): string {
  const qs = salesFiltersToSearchParams(f).toString();
  return qs ? `${base}?${qs}` : base;
}

/** Aplica (o reemplaza) un filtro de dimensión; queda al final de las migas. */
export function withDimension<D extends Dimension>(
  f: SalesFilters,
  key: D,
  value: NonNullable<DimensionFilters[D]>,
): SalesFilters {
  return {
    ...f,
    dims: { ...f.dims, [key]: value },
    dimOrder: [...f.dimOrder.filter((d) => d !== key), key],
  };
}

/** Quita un filtro de dimensión (el chip «×»). */
export function withoutDimension(f: SalesFilters, key: Dimension): SalesFilters {
  const dims = { ...f.dims };
  delete dims[key];
  return { ...f, dims, dimOrder: f.dimOrder.filter((d) => d !== key) };
}

/** Cambia el período (presets o rango) y olvida el «origen» del drill. */
export function withPeriod(f: SalesFilters, period: PeriodKind, range?: DayRange): SalesFilters {
  if (period === "rango" && range) {
    return { ...f, period, desde: range.from, hasta: range.to, origen: null, granularity: "auto" };
  }
  return { ...f, period, desde: null, hasta: null, origen: null, granularity: "auto" };
}

/**
 * Entra a un sub-período (un día, una semana o un mes del gráfico): queda
 * como rango personalizado y recuerda de dónde vino, para la miga de vuelta.
 */
export function drillToRange(f: SalesFilters, range: DayRange): SalesFilters {
  const origen = f.origen ?? periodToken(f);
  return { ...f, period: "rango", desde: range.from, hasta: range.to, origen, granularity: "auto" };
}

/** Vuelve al período de origen del drill (si lo hay). */
export function backToOrigin(f: SalesFilters): SalesFilters | null {
  const parent = parsePeriodToken(f.origen);
  if (!parent) return null;
  return { ...f, ...parent, origen: null, granularity: "auto" };
}

export function hasItemFilter(f: Pick<SalesFilters, "dims">): boolean {
  return f.dims.categoria !== undefined || f.dims.producto !== undefined;
}

/** Rango efectivo del período (con el día operativo de hoy). */
export function resolveRange(f: SalesFilters, today: string): DayRange {
  if (f.period === "rango" && f.desde && f.hasta) return { from: f.desde, to: f.hasta };
  return presetRange(f.period === "rango" ? DEFAULT_PERIOD : f.period, today);
}

export function resolveComparison(f: SalesFilters, range: DayRange): DayRange | null {
  return comparisonRange(range, f.period, f.compare);
}

export type Crumb = { kind: "root" | "period" | Dimension; href: string; current: boolean };

/**
 * Migas: raíz (sin filtros, período por defecto) › período de origen ›
 * período actual › cada filtro en el orden en que se aplicó. Cada miga
 * enlaza al estado con los pasos siguientes quitados.
 */
export function breadcrumbs(f: SalesFilters): Crumb[] {
  const crumbs: Crumb[] = [];
  const base: SalesFilters = { ...f, dims: {}, dimOrder: [] };
  crumbs.push({ kind: "root", href: SALES_ANALYSIS_PATH, current: false });
  const origin = backToOrigin(base);
  if (origin) crumbs.push({ kind: "period", href: salesHref(origin), current: false });
  crumbs.push({ kind: "period", href: salesHref(base), current: false });
  let acc = base;
  for (const d of f.dimOrder) {
    const v = f.dims[d];
    if (v === undefined) continue;
    acc = withDimension(acc, d, v as never);
    crumbs.push({ kind: d, href: salesHref(acc), current: false });
  }
  crumbs[crumbs.length - 1]!.current = true;
  return crumbs;
}
