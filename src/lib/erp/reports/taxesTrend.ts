/**
 * IMPUESTOS DEL PERÍODO — tendencia de los últimos períodos (lógica pura).
 * La cifra de cada período es la MISMA que la tesela del resumen
 * (documental, `aggregateDocumentTaxes`), calculada sobre los documentos de
 * ese período: así el último punto de la serie es la tesela y la barra
 * anterior es «el período pasado» del comparativo.
 *
 * «Períodos del mismo tipo»: si el período elegido es un mes, los meses
 * anteriores; una semana, las semanas; un año, los años; un rango libre,
 * los rangos contiguos de la misma cantidad de días.
 */
import {
  aggregateDocumentTaxes,
  type CreditNoteTaxInput,
  type CurrentSalesTax,
  type DocumentTaxTotals,
  type PurchaseTaxInput,
  type SaleTaxInput,
} from "./taxesDocuments";
import { DRILL_TAXES, type DrillTaxKey } from "./taxesDrill";
import { isoDateUtc, periodKind, shiftPeriod, type ReportPeriod } from "./period";

export const TREND_LENGTH = 6;

/** Los `n` períodos del mismo tipo que terminan en `period` (el más viejo primero). */
export function trendPeriods(period: ReportPeriod, n = TREND_LENGTH): ReportPeriod[] {
  const kind = periodKind(period);
  const out: ReportPeriod[] = [period];
  for (let i = 1; i < n; i++) {
    const last = out[0]!;
    if (kind === "rango") {
      const days = daysBetween(period.desde, period.hasta) + 1;
      out.unshift({ desde: addDays(last.desde, -days), hasta: addDays(last.desde, -1) });
    } else {
      out.unshift(shiftPeriod(last, kind, -1));
    }
  }
  return out;
}

function addDays(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return isoDateUtc(d);
}

function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

/** Cifra de la tesela de cada impuesto a partir de los totales documentales. */
export function tileValue(t: DocumentTaxTotals, tax: DrillTaxKey): number {
  switch (tax) {
    case "inc":
      return t.incGeneradoCents;
    case "iva":
      return t.ivaGeneradoCents - t.ivaDescontableCents;
    case "retefuente":
      return t.retefuenteCents;
    case "reteiva":
      return t.reteIvaCents;
    case "reteica":
      return t.reteIcaCents;
  }
}

export type TrendBucketInput = {
  period: ReportPeriod;
  refundsCents: number;
};

export type TaxTrend = {
  periods: ReportPeriod[];
  /** Una serie por impuesto, alineada con `periods`. */
  series: Record<DrillTaxKey, number[]>;
};

const inDays = (iso: string, p: ReportPeriod) => {
  const day = iso.slice(0, 10);
  return day >= p.desde && day <= p.hasta;
};

/**
 * Serie por impuesto: reparte los documentos de toda la ventana en sus
 * períodos (por la fecha UTC, como el documental) y agrega cada uno con
 * `aggregateDocumentTaxes`, con sus devoluciones.
 */
export function buildTaxTrend({
  buckets,
  sales,
  purchases,
  creditNotes,
  currentTax,
}: {
  buckets: readonly TrendBucketInput[];
  sales: readonly SaleTaxInput[];
  purchases: readonly PurchaseTaxInput[];
  creditNotes: readonly CreditNoteTaxInput[];
  currentTax: CurrentSalesTax;
}): TaxTrend {
  const series = Object.fromEntries(DRILL_TAXES.map((k) => [k, [] as number[]])) as Record<DrillTaxKey, number[]>;
  for (const b of buckets) {
    const docs = aggregateDocumentTaxes({
      sales: sales.filter((s) => inDays(s.dateIso, b.period)),
      purchases: purchases.filter((p) => inDays(p.dateIso, b.period)),
      creditNotes: creditNotes.filter((n) => inDays(n.dateIso, b.period)),
      refundsCents: b.refundsCents,
      currentTax,
    });
    for (const k of DRILL_TAXES) series[k].push(tileValue(docs.totals, k));
  }
  return { periods: buckets.map((b) => b.period), series };
}

/** Comparativo del período contra el anterior (null si no hay anterior o era 0). */
export function previousDelta(series: readonly number[]): { previousCents: number; deltaCents: number; deltaPct: number | null } | null {
  if (series.length < 2) return null;
  const cur = series[series.length - 1]!;
  const prev = series[series.length - 2]!;
  return {
    previousCents: prev,
    deltaCents: cur - prev,
    deltaPct: prev === 0 ? null : Math.round(((cur - prev) / Math.abs(prev)) * 100),
  };
}
