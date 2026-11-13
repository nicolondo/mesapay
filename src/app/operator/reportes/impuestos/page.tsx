import { getLocale, getTranslations } from "next-intl/server";
import type { Locale } from "@/i18n/config";
import { formatMoney } from "@/lib/format";
import { TAXES_AUX_ENDPOINT as AUX_ENDPOINT } from "@/lib/erp/reports/auxRows";
import { baseReportQuery, periodFromQuery } from "@/lib/erp/reports/params";
import { currentMonthPeriod, periodKind, todayIso, type ReportPeriod as Period } from "@/lib/erp/reports/period";
import { sortChecks, type CheckResult } from "@/lib/erp/reports/taxesChecks";
import { visibleTaxes, type DrillTax, type DrillTaxKey } from "@/lib/erp/reports/taxesDrill";
import { loadTaxesDrillBase, loadTaxesTrend, taxChecks } from "@/lib/erp/reports/taxesDrillReport";
import { previousDelta, type TaxTrend } from "@/lib/erp/reports/taxesTrend";
import { firstParam, reportGate } from "../_components/gate";
import { fmtIsoDate, fmtMonth } from "../_components/fmt";
import { ChecksPanel, type CheckItem } from "../_components/ChecksPanel";
import { KeepOpenField } from "../_components/KeepOpenField";
import { OpenRowButton } from "../_components/OpenRowButton";
import { PrintButton } from "../_components/PrintButton";
import { ReportPeriod } from "../_components/ReportPeriod";
import { ReportFilterForm, ReportShell } from "../_components/ReportShell";
import { StatusBadge } from "../_components/StatusBadge";
import { TrendBars } from "../_components/TrendBars";
import { TaxDrillView } from "./TaxDrillView";
import { invoiceListHref } from "@/lib/dian/invoiceList";

export const dynamic = "force-dynamic";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/**
 * Impuestos del período — despliegue interactivo (pedido del dueño: «poder
 * desplegar los auxiliares para ver qué generó esos impuestos… y detectar
 * problemas a tiempo»). Tres partes, de lo general a lo particular:
 *
 *  1. RESUMEN PARA LA DIAN: una tesela por impuesto (INC, IVA a pagar o a
 *     favor, retefuente, reteIVA, reteICA) con la cifra de los documentos,
 *     el comparativo y las barras de los últimos 6 períodos del mismo tipo,
 *     y el semáforo contra el libro (ícono + texto).
 *  2. REVISAR ANTES DE DECLARAR: las revisiones de `taxesChecks.ts`, cada
 *     una con su explicación, qué hacer y sus filas desplegables.
 *  3. DETALLE POR IMPUESTO: niveles 1 → 2 → 3 (`TaxDrillView`): impuesto,
 *     origen y tarifa / fuente del asiento, y los auxiliares (documentos y
 *     líneas del libro) que se cargan al abrir, desde la API.
 *
 * Las cifras salen de los mismos módulos que el reporte de siempre
 * (`aggregateDocumentTaxes`, `buildTaxAccountReport`) a través de
 * `taxesDrill.ts`, y cada nivel suma exactamente el de arriba. Lo
 * desplegado vive en `?abrir=` (compartible; «atrás» desde un documento lo
 * conserva). Reemplaza también a «Impuestos detallados» (que redirige acá):
 * los auxiliares y su Excel cubren documento por documento y comprobante
 * por comprobante.
 */
export default async function ImpuestosPage({ searchParams }: { searchParams: SearchParams }) {
  const [t, tRep, tDrill, tSettings, locale] = await Promise.all([
    getTranslations("opImpuestosRep"),
    getTranslations("opReportes"),
    getTranslations("opReportDrill"),
    getTranslations("opSettings"),
    getLocale(),
  ]);
  const gate = await reportGate();
  if (!gate) return <div className="p-6">{tSettings("noRestaurant")}</div>;

  const sp = await searchParams;
  const raw = {
    desde: firstParam(sp.desde),
    hasta: firstParam(sp.hasta),
    anio: firstParam(sp.anio),
  };
  // En la página se es tolerante: lo inválido se ignora en vez de romper.
  const parsed = baseReportQuery
    .omit({ format: true })
    .safeParse(Object.fromEntries(Object.entries(raw).filter(([, v]) => v)));
  const q = parsed.success ? parsed.data : {};
  const today = todayIso();
  const fallback = currentMonthPeriod(today);
  const resolved =
    periodFromQuery(q.desde || q.hasta || q.anio ? q : fallback, today) ??
    periodFromQuery(fallback, today)!;
  const period: Period = { desde: resolved.desde, hasta: resolved.hasta };

  const [base, trend] = await Promise.all([
    loadTaxesDrillBase(gate.restaurantId, period),
    loadTaxesTrend(gate.restaurantId, period),
  ]);
  const checks = sortChecks(taxChecks(base, trend));

  const loc = locale as Locale;
  const money = (c: number) => formatMoney(c, { currency: gate.currency, locale: loc });
  const periodLabel = tRep("periodLabel", {
    from: fmtIsoDate(period.desde, loc),
    to: fmtIsoDate(period.hasta, loc),
  });
  const kind = periodKind(period);
  const shortLabel = (p: Period) =>
    kind === "mes"
      ? fmtMonth(p.desde.slice(0, 7), loc)
      : kind === "año"
        ? p.desde.slice(0, 4)
        : tRep("periodLabel", { from: fmtIsoDate(p.desde, loc), to: fmtIsoDate(p.hasta, loc) });
  const trendLabels = trend.periods.map(shortLabel);
  const prevLabel = trendLabels[trendLabels.length - 2] ?? "";
  const regime = base.currentTax.kind;
  const taxes = visibleTaxes(base.drill, regime);
  const query = { desde: period.desde, hasta: period.hasta };
  const exportHref = (format: "xlsx" | "csv") =>
    `${AUX_ENDPOINT}?${new URLSearchParams({ ...query, nodo: "todo", format }).toString()}`;

  const { items, passed } = checkItems(checks, { t, tDrill, money, regime });

  return (
    <ReportShell
      title={t("title")}
      description={t("subtitle")}
      print={{
        businessName: gate.business.name,
        taxId: gate.business.taxId,
        title: t("title"),
        subtitle: periodLabel,
      }}
      filters={
        <ReportFilterForm>
          <KeepOpenField />
          <ReportPeriod
            key={`${period.desde}-${period.hasta}`}
            desde={period.desde}
            hasta={period.hasta}
            step="mes"
          />
        </ReportFilterForm>
      }
      actions={
        <>
          <a href={exportHref("xlsx")} className="mp-btn mp-btn--ghost mp-btn--sm no-print" download>
            {t("exportXlsx")}
          </a>
          <a href={exportHref("csv")} className="mp-btn mp-btn--ghost mp-btn--sm no-print" download>
            {tRep("exportCsv")}
          </a>
          <PrintButton />
        </>
      }
      note={t("pageNote")}
    >
      <section aria-labelledby="resumen-title" className="min-w-0 space-y-2">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3">
          <h2 id="resumen-title" className="text-sm font-semibold">
            {t("summaryTitle")}
          </h2>
          <span className="text-xs text-op-muted">{periodLabel}</span>
        </div>
        <p className="text-xs text-op-muted">{t("summaryNote")}</p>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {taxes.map((x) => (
            <TaxTile
              key={x.key}
              tax={x}
              trend={trend}
              labels={trendLabels}
              prevLabel={prevLabel}
              currency={gate.currency}
              money={money}
              t={t}
            />
          ))}
        </div>
      </section>

      <ChecksPanel
        id="revisar"
        title={t("reviewTitle")}
        intro={t("reviewNote")}
        items={items}
        passed={passed}
        endpoint={AUX_ENDPOINT}
        query={query}
        currency={gate.currency}
      />

      <TaxDrillView taxes={taxes} others={base.drill.others} currency={gate.currency} query={query} />
    </ReportShell>
  );
}

type T = Awaited<ReturnType<typeof getTranslations<"opImpuestosRep">>>;
type TD = Awaited<ReturnType<typeof getTranslations<"opReportDrill">>>;

function TaxTile({
  tax: x,
  trend,
  labels,
  prevLabel,
  currency,
  money,
  t,
}: {
  tax: DrillTax;
  trend: TaxTrend;
  labels: string[];
  prevLabel: string;
  currency: string;
  money: (c: number) => string;
  t: T;
}) {
  const series = trend.series[x.key];
  const delta = previousDelta(series);
  const isIva = x.key === "iva";
  const value = isIva ? Math.abs(x.docCents) : x.docCents;
  const sub = isIva
    ? x.docCents >= 0
      ? t("tileSubIvaPay")
      : t("tileSubIvaFavor")
    : x.key === "inc"
      ? t("tileSubInc")
      : t("tileSubRet");
  const deltaText = !delta
    ? null
    : delta.deltaCents === 0
      ? t("deltaSame", { period: prevLabel })
      : delta.deltaPct == null
        ? t("deltaNoPrev", { period: prevLabel })
        : t(delta.deltaCents > 0 ? "deltaUp" : "deltaDown", {
            pct: Math.abs(delta.deltaPct),
            period: prevLabel,
          });
  const badge =
    x.status === "ok" ? (
      <StatusBadge tone="ok">{t("statusOk")}</StatusBadge>
    ) : x.status === "diff" ? (
      <StatusBadge tone="warning">{t("tileStatusDiff", { book: money(x.bookCents), amount: money(x.diffCents) })}</StatusBadge>
    ) : (
      <StatusBadge tone="empty">{t("statusEmpty")}</StatusBadge>
    );
  return (
    <article className="flex min-w-0 flex-col rounded-2xl border border-op-border bg-op-surface px-4 py-3">
      <h3 className="text-[11px] font-semibold uppercase tracking-wider text-op-muted">{t(`tile_${x.key}`)}</h3>
      <p className="mt-1 font-semibold tabular text-xl break-words sm:text-2xl">{money(value)}</p>
      <p className="text-xs text-op-muted">{sub}</p>
      {deltaText && <p className="mt-1 text-xs tabular">{deltaText}</p>}
      <TrendBars values={series} labels={labels} currency={currency} title={t("trendTitle", { tax: t(`tile_${x.key}`) })} />
      <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1">
        <OpenRowButton ids={[x.key]} target={`drill-${x.key}`} label={t("openDetail", { tax: t(`tile_${x.key}`) })}>
          {badge}
        </OpenRowButton>
        {x.status === "diff" && (
          <a href="#revisar" className="no-print text-xs font-medium underline underline-offset-2 hover:text-op-accent">
            {t("whyDiff")}
          </a>
        )}
      </div>
    </article>
  );
}

const CHECK_LINKS: Partial<Record<CheckResult["key"], { href: string; labelKey: string }>> = {
  // Directo al filtro: ahí está la causa en palabras claras y la acción
  // («Reenviar a la DIAN» / «Consultar en la DIAN»).
  dianRechazada: { href: invoiceListHref({ state: "rejected" }), labelKey: "linkInvoices" },
  dianPendiente: { href: invoiceListHref({ state: "in_process" }), labelKey: "linkInvoices" },
  sinAsiento: { href: "/operator/contabilidad?tab=diario", labelKey: "linkJournal" },
  desactualizado: { href: "/operator/contabilidad?tab=diario", labelKey: "linkJournal" },
  tarifaDistinta: { href: "/operator/settings/impuestos", labelKey: "linkTaxSettings" },
  sinImpuesto: { href: "/operator/settings/impuestos", labelKey: "linkTaxSettings" },
  retencionOmitida: { href: "/operator/contabilidad?tab=impuestos", labelKey: "linkRetentions" },
  retencionBajoUmbral: { href: "/operator/contabilidad?tab=impuestos", labelKey: "linkRetentions" },
  ivaNoDescontable: { href: "/operator/settings/proveedores", labelKey: "linkPurchaseSettings" },
  terceroSinNit: { href: "/operator/settings/proveedores", labelKey: "linkSuppliers" },
  sinDocumento: { href: "/operator/contabilidad/comprobantes", labelKey: "linkVouchers" },
  facturadaPendiente: { href: "/operator/tables", labelKey: "linkTables" },
  // Se corrigen con nota crédito (lo decide el contador): ahí se emiten.
  descuentoSinDeclarar: { href: "/operator/facturas/notas-credito", labelKey: "linkCreditNotes" },
};

const AMOUNT_HEAD: Partial<Record<CheckResult["key"], string>> = {
  corte: "colDelta",
  sinFactura: "colEstimatedTax",
  retencionOmitida: "colExpectedRet",
  ivaNoDescontable: "colDeductible",
  desactualizado: "colDifference",
  sinDocumento: "colMovement",
  descuentoSinDeclarar: "colOverstatedTax",
};

/** Revisiones → textos traducidos para el panel (sin las filas: esas las trae la API). */
function checkItems(
  checks: readonly CheckResult[],
  { t, tDrill, money, regime }: { t: T; tDrill: TD; money: (c: number) => string; regime: DrillTaxKey | "none" },
): { items: CheckItem[]; passed: { key: string; title: string }[] } {
  const items: CheckItem[] = [];
  const passed: { key: string; title: string }[] = [];
  const rateText = (kind: string | number | undefined, pct: string | number | undefined) =>
    kind === "inc" || kind === "iva" ? t("rateOf", { tax: t(`short_${kind}`), rate: t("ratePct", { pct: pct ?? 0 }) }) : t("noRate");
  for (const c of checks) {
    if (c.count === 0) {
      passed.push({ key: c.key, title: t(`check_${c.key}_ok`) });
      continue;
    }
    const taxes = c.taxes.map((k) => t(`tile_${k}`)).join(", ");
    const params: Record<string, string | number> = {
      count: c.count,
      amount: money(c.amountCents),
      taxes,
      current: rateText(c.params.kind, c.params.pct),
      orders: c.params.orders ?? c.count,
      regime: regime === "none" ? t("noRate") : t(`tile_${regime}`),
      base: money(typeof c.params.baseCents === "number" ? c.params.baseCents : 0),
      discount: money(typeof c.params.discountCents === "number" ? c.params.discountCents : 0),
    };
    const body =
      c.key === "ivaNoDescontable"
        ? t(`check_ivaNoDescontable_body_${c.params.reason === "config" ? "config" : "regime"}`, params)
        : c.key === "variacion"
          ? (c.spikes ?? [])
              .map((s) =>
                t(s.changePct > 0 ? "check_variacion_up" : "check_variacion_down", {
                  tax: t(`tile_${s.tax}`),
                  pct: Math.abs(s.changePct),
                  current: money(s.currentCents),
                  average: money(s.averageCents),
                }),
              )
              .join(" ")
          : t(`check_${c.key}_body`, params);
    const link = CHECK_LINKS[c.key];
    const head = AMOUNT_HEAD[c.key];
    items.push({
      key: c.key,
      tone: c.severity,
      severityLabel: tDrill(`severity_${c.severity}`),
      title: t(`check_${c.key}_title`, params),
      body,
      action: t(`check_${c.key}_action`, params),
      amount: c.key === "variacion" ? null : money(c.amountCents),
      rows: c.rows.length,
      expectedCents: c.rows.reduce((s, r) => s + r.amountCents, 0),
      amountLabel: head ? (head === "colDifference" || head === "colMovement" ? tDrill(head) : t(head)) : undefined,
      link: link ? { href: link.href, label: t(link.labelKey) } : null,
    });
  }
  return { items, passed };
}
