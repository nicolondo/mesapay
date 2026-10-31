"use client";

// Pagos y canales: mezcla de métodos de pago (lo cobrado, con propina) y de
// salón vs. para llevar (venta neta), en barras — no tortas: comparar largos
// es más fácil que comparar ángulos. Clic = filtrar por ese método o canal.
import { useLocale, useTranslations } from "next-intl";
import { BarList, type BarItem } from "@/components/charts/BarList";
import { formatValue } from "@/components/charts/format";
import { defaultLocale, isLocale } from "@/i18n/config";
import { salesHref, withDimension, type SalesFilters } from "@/lib/salesAnalysis/filters";
import { deltaTone, share, variation } from "@/lib/salesAnalysis/compare";
import type { ChannelRow, MethodRow, TableRow } from "@/lib/salesAnalysis/types";
import { channelLabel, methodLabel, tableName } from "@/lib/salesAnalysis/dimLabels";
import { fmtDelta, fmtPercent } from "@/lib/salesAnalysis/labels";

export function MixPanel({
  methods,
  compareMethods,
  channels,
  compareChannels,
  tables,
  filters,
  currency,
  counterMode,
  itemFilter,
}: {
  methods: MethodRow[];
  compareMethods: MethodRow[] | null;
  channels: ChannelRow[];
  compareChannels: ChannelRow[] | null;
  tables: TableRow[];
  filters: SalesFilters;
  currency: string;
  counterMode: boolean;
  itemFilter: boolean;
}) {
  const t = useTranslations("salesAnalysis");
  const localeValue = useLocale();
  const locale = isLocale(localeValue) ? localeValue : defaultLocale;
  const money = { kind: "money" as const, currency, locale };
  const count = { kind: "number" as const, locale };
  const deltaOf = (cur: number, prev: number | null | undefined, enabled: boolean) => {
    if (!enabled) return null;
    const d = variation(cur, prev ?? null);
    return d === null ? null : { text: fmtDelta(d, locale), tone: deltaTone(d, "up") };
  };

  const totalMethods = methods.reduce((s, m) => s + m.amountCents, 0);
  const prevMethod = new Map((compareMethods ?? []).map((m) => [m.method, m]));
  const methodItems: BarItem[] = methods.map((m) => {
    const name = methodLabel(m.method, t);
    const pct = share(m.amountCents, totalMethods);
    return {
      key: m.method,
      label: name,
      value: m.amountCents,
      valueLabel: formatValue(m.amountCents, money),
      sub: t("mix.methodSub", { share: pct === null ? t("emptyDash") : fmtPercent(pct, locale), payments: m.payments }),
      delta: deltaOf(m.amountCents, prevMethod.get(m.method)?.amountCents, !!compareMethods),
      href: salesHref(withDimension(filters, "pago", m.method)),
      selected: filters.dims.pago === m.method,
      tooltip: {
        title: name,
        rows: [
          { value: formatValue(m.amountCents, money), label: t("mix.collected") },
          { value: formatValue(m.tipCents, money), label: t("kpi.tips") },
          { value: formatValue(m.orders, count), label: t("kpi.orders") },
        ],
        hint: t("clickToFilter"),
      },
    };
  });

  const totalChannels = channels.reduce((s, c) => s + c.netCents, 0);
  const prevChannel = new Map((compareChannels ?? []).map((c) => [c.channel, c]));
  const channelItems: BarItem[] = channels.map((c) => {
    const name = channelLabel(c.channel, t, counterMode);
    const pct = share(c.netCents, totalChannels);
    const ticket = c.orders > 0 ? Math.round(c.netCents / c.orders) : null;
    return {
      key: c.channel,
      label: name,
      value: c.netCents,
      valueLabel: formatValue(c.netCents, money),
      sub: t("mix.channelSub", { share: pct === null ? t("emptyDash") : fmtPercent(pct, locale), orders: c.orders }),
      delta: deltaOf(c.netCents, prevChannel.get(c.channel)?.netCents, !!compareChannels),
      href: salesHref(withDimension(filters, "canal", c.channel)),
      selected: filters.dims.canal === c.channel,
      tooltip: {
        title: name,
        rows: [
          { value: formatValue(c.netCents, money), label: t("kpi.net") },
          { value: formatValue(c.orders, count), label: t("kpi.orders") },
          ...(ticket !== null ? [{ value: formatValue(ticket, money), label: t("kpi.avgTicket") }] : []),
        ],
        hint: t("clickToFilter"),
      },
    };
  });

  const tableItems: BarItem[] = tables.map((x) => {
    const name = tableName(x, t);
    return {
      key: x.tableId,
      label: name,
      value: x.netCents,
      valueLabel: formatValue(x.netCents, money),
      sub: t("mix.tableSub", { orders: x.orders, diners: x.diners }),
      href: salesHref(withDimension(filters, "mesa", x.tableId)),
      selected: filters.dims.mesa === x.tableId,
      tooltip: {
        title: name,
        rows: [
          { value: formatValue(x.netCents, money), label: t("kpi.net") },
          { value: formatValue(x.orders, count), label: t("kpi.orders") },
          ...(x.orders > 0 ? [{ value: formatValue(Math.round(x.netCents / x.orders), money), label: t("kpi.avgTicket") }] : []),
        ],
        hint: t("clickToFilter"),
      },
    };
  });

  return (
    <section className="mp-panel mp-sa-panel" aria-labelledby="sales-mix-title">
      <div className="mp-panel-heading">
        <div>
          <h2 id="sales-mix-title">{t("mix.title")}</h2>
          <p className="mp-sales-sub">{itemFilter ? t("mix.itemFilterNote") : t("mix.subtitle")}</p>
        </div>
      </div>
      <div className="mp-sales-panel-body mp-sales-stack">
        <div>
          <h3 className="mp-sales-h3">{t("mix.methods")}</h3>
          <BarList items={methodItems} ariaLabel={t("mix.methods")} empty={t("emptyPeriod")} />
        </div>
        <div>
          <h3 className="mp-sales-h3">{t("mix.channels")}</h3>
          <BarList items={channelItems} ariaLabel={t("mix.channels")} empty={t("emptyPeriod")} />
        </div>
        {!counterMode && tableItems.length > 0 && (
          <div>
            <h3 className="mp-sales-h3">{t("mix.tables")}</h3>
            <BarList items={tableItems.slice(0, 8)} ariaLabel={t("mix.tables")} />
          </div>
        )}
      </div>
    </section>
  );
}
