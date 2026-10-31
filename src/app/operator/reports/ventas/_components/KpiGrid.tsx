// Indicadores del período con su variación contra la comparación. Cada
// cifra es un número grande (no un gráfico de una barra) y la variación
// lleva flecha + porcentaje + color según si subir es bueno o malo.
import type { Locale } from "@/i18n/config";
import { formatMoney } from "@/lib/format";
import { deltaTone, KPI_POLARITY, variation } from "@/lib/salesAnalysis/compare";
import type { KpiKey } from "@/lib/salesAnalysis/metrics";
import type { SalesAnalysis } from "@/lib/salesAnalysis/types";
import { fmtDelta, fmtMinutes, fmtNumber } from "@/lib/salesAnalysis/labels";
import type { Tr } from "@/lib/salesAnalysis/dimLabels";

type Tile = {
  key: KpiKey;
  label: string;
  value: string;
  hint?: string;
  /** null = no aplica con el filtro actual. */
  raw: number | null;
};

export function KpiGrid({
  t,
  analysis,
  currency,
  locale,
  compareLabel,
}: {
  t: Tr;
  analysis: SalesAnalysis;
  currency: string;
  locale: Locale;
  compareLabel: string | null;
}) {
  const k = analysis.kpis;
  const money = (v: number | null) => (v === null ? t("notApplicable") : formatMoney(v, { currency, locale }));
  const dash = t("emptyDash");
  const item = analysis.itemFilter;
  const returns = analysis.current.returns;

  const sales: Tile[] = [
    { key: "netCents", label: t("kpi.net"), value: money(k.netCents), hint: t("kpi.netHint"), raw: k.netCents },
    { key: "grossCents", label: t("kpi.gross"), value: money(k.grossCents), hint: t("kpi.grossHint"), raw: k.grossCents },
    { key: "taxCents", label: t("kpi.tax"), value: money(k.taxCents), hint: t("kpi.taxHint"), raw: k.taxCents },
    {
      key: "tipCents",
      label: t("kpi.tips"),
      value: k.tipCents === null ? t("notApplicable") : money(k.tipCents),
      hint: item ? t("kpi.itemFilterNa") : t("kpi.tipsHint"),
      raw: k.tipCents,
    },
    {
      key: "discountsAndCompsCents",
      label: t("kpi.discountsComps"),
      value: money(k.discountsAndCompsCents),
      hint: t("kpi.discountsCompsHint", { discounts: money(k.discountCents), comps: money(k.compsCents) }),
      raw: k.discountsAndCompsCents,
    },
    {
      key: "returnsCents",
      label: t("kpi.returns"),
      value: k.returnsCents === null ? t("notApplicable") : money(k.returnsCents),
      hint: returns && k.netAfterReturnsCents !== null
        ? t("kpi.returnsHint", {
            notes: returns.creditNotes.count,
            refunds: returns.refunds.count,
            net: money(k.netAfterReturnsCents),
          })
        : t("kpi.itemFilterNa"),
      raw: k.returnsCents,
    },
  ];
  const accounts: Tile[] = [
    { key: "orders", label: t("kpi.orders"), value: fmtNumber(k.orders, locale), hint: t("kpi.ordersHint"), raw: k.orders },
    { key: "diners", label: t("kpi.diners"), value: fmtNumber(k.diners, locale), hint: t("kpi.dinersHint"), raw: k.diners },
    {
      key: "avgTicketCents",
      label: item ? t("kpi.avgPerOrderItem") : t("kpi.avgTicket"),
      value: k.avgTicketCents === null ? dash : money(k.avgTicketCents),
      hint: t("kpi.avgTicketHint"),
      raw: k.avgTicketCents,
    },
    {
      key: "avgPerDinerCents",
      label: t("kpi.avgPerDiner"),
      value: k.avgPerDinerCents === null ? dash : money(k.avgPerDinerCents),
      hint: t("kpi.avgPerDinerHint"),
      raw: k.avgPerDinerCents,
    },
    {
      key: "unitsPerOrder",
      label: t("kpi.unitsPerOrder"),
      value: k.unitsPerOrder === null ? dash : fmtNumber(k.unitsPerOrder, locale, 1),
      hint: t("kpi.unitsPerOrderHint"),
      raw: k.unitsPerOrder,
    },
    {
      key: "medianTableMinutes",
      label: t("kpi.tableTime"),
      value: k.medianTableMinutes === null ? dash : fmtMinutes(k.medianTableMinutes, { h: t("unitHours"), min: t("unitMinutes") }),
      hint: k.medianTableMinutes === null ? t("kpi.tableTimeNoData") : t("kpi.tableTimeHint"),
      raw: k.medianTableMinutes,
    },
  ];

  const prev = analysis.compareKpis;
  const delta = (tile: Tile) => {
    if (!prev || tile.raw === null) return null;
    const d = variation(tile.raw, prev[tile.key] as number | null);
    if (d === null) return null;
    return { text: fmtDelta(d, locale), tone: deltaTone(d, KPI_POLARITY[tile.key]) };
  };

  const render = (tiles: Tile[], label: string, primaryFirst: boolean) => (
    <section aria-label={label} className="mp-sales-kpis">
      {tiles.map((tile, i) => {
        const d = delta(tile);
        return (
          <div key={tile.key} className={`mp-kpi${primaryFirst && i === 0 ? " mp-kpi--primary" : ""}`} data-testid={`kpi-${tile.key}`}>
            <span className="mp-kpi-label">{tile.label}</span>
            <span className="mp-sales-kpi-value">{tile.value}</span>
            {d && (
              <span className={`mp-sales-kpi-delta mp-viz-delta--${d.tone}`}>
                {d.text}
                <span className="sr-only">{compareLabel ? t("vsCompare", { period: compareLabel }) : ""}</span>
              </span>
            )}
            {tile.hint && <span className="mp-kpi-hint">{tile.hint}</span>}
          </div>
        );
      })}
    </section>
  );

  return (
    <div className="mp-sales-kpi-groups">
      {render(sales, t("kpi.salesGroup"), true)}
      {render(accounts, t("kpi.accountsGroup"), false)}
      {prev && compareLabel && <p className="mp-sales-note">{t("deltaNote", { period: compareLabel })}</p>}
    </div>
  );
}
