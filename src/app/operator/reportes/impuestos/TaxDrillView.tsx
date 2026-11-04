"use client";

import { useLocale, useTranslations } from "next-intl";
import type { Locale } from "@/i18n/config";
import { formatMoney } from "@/lib/format";
import { TAXES_AUX_ENDPOINT } from "@/lib/erp/reports/auxRows";
import { makeSourceLabel } from "@/lib/erp/reports/labels";
import { makeFamilyLabel, makeRateLabel } from "@/lib/erp/reports/taxesLabels";
import type { DrillDocNode, DrillTax, DrillTaxKey, TaxDrill } from "@/lib/erp/reports/taxesDrill";
import { AuxiliariesPanel } from "../_components/AuxiliariesPanel";
import { DrillHeader, DrillRow } from "../_components/DrillRow";
import { StatusBadge } from "../_components/StatusBadge";
import { useDrillOpen } from "../_components/useDrillOpen";

/**
 * «Detalle por impuesto»: los tres niveles del despliegue.
 *
 *   1. un renglón por impuesto: documentos · libro · semáforo;
 *   2. al abrirlo, dos grupos —«Según documentos» por origen y tarifa o
 *      concepto, «Según el libro» por fuente del asiento— con su total, que
 *      es la cifra del nivel 1;
 *   3. al abrir un renglón del grupo, sus auxiliares (`AuxiliariesPanel`),
 *      que suman exactamente el renglón.
 *
 * Lo abierto vive en `?abrir=` (`useDrillOpen`): se comparte y sobrevive a
 * ir a un documento y volver.
 */
const L1_COLS = "md:grid-cols-[minmax(0,1fr)_9.5rem_9.5rem_minmax(12rem,auto)]";
const L2_COLS = "md:grid-cols-[minmax(0,1fr)_7rem_9.5rem_9.5rem]";

const AUX_ENDPOINT = TAXES_AUX_ENDPOINT;

/** Impuestos cuya tarifa se nombra con su sigla («INC 8 %», «IVA 19 %»). */
const WITH_SHORT: ReadonlySet<DrillTaxKey> = new Set(["inc", "iva"]);

export function TaxDrillView({
  taxes,
  others,
  currency,
  query,
}: {
  taxes: DrillTax[];
  others: TaxDrill["others"];
  currency: string;
  query: Record<string, string>;
}) {
  const t = useTranslations("opImpuestosRep");
  const tDrill = useTranslations("opReportDrill");
  const tErp = useTranslations("opErp");
  const locale = useLocale() as Locale;
  const drill = useDrillOpen();
  const money = (c: number) => formatMoney(c, { currency, locale });
  const rate = makeRateLabel(t, locale);
  const sourceLabel = makeSourceLabel(tErp);
  const familyLabel = makeFamilyLabel(t);
  const l1Ids = [...taxes.map((x) => x.key as string), ...(others.nodes.length ? ["otros"] : [])];
  const allOpen = l1Ids.every((id) => drill.isOpen(id));

  const docLabel = (n: DrillDocNode) => {
    const r = rate(n);
    const rateText =
      WITH_SHORT.has(n.tax) && !n.conceptName && n.pct != null && !n.rateKey.startsWith("e")
        ? t("rateOf", { tax: t(`short_${n.tax}`), rate: r })
        : r;
    return t("nodeLabel", { origin: t(`origin_${n.origin}`), rate: rateText });
  };
  const status = (x: DrillTax) =>
    x.status === "ok" ? (
      <StatusBadge tone="ok">{t("statusOk")}</StatusBadge>
    ) : x.status === "diff" ? (
      <StatusBadge tone="warning">{t("statusDiff", { amount: money(x.diffCents) })}</StatusBadge>
    ) : (
      <StatusBadge tone="empty">{t("statusEmpty")}</StatusBadge>
    );

  return (
    <section id="detalle" aria-labelledby="detalle-title" className="scroll-mt-4 min-w-0 overflow-hidden rounded-2xl border border-op-border bg-op-surface">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-op-border px-4 py-3">
        <div className="min-w-0">
          <h2 id="detalle-title" className="text-sm font-semibold">
            {t("drillTitle")}
          </h2>
          <p className="mt-0.5 text-xs text-op-muted">{t("drillNote")}</p>
        </div>
        <button
          type="button"
          className="no-print mp-btn mp-btn--ghost mp-btn--sm min-h-11"
          onClick={() => (allOpen ? drill.closeAll() : drill.openMany(l1Ids))}
        >
          {allOpen ? tDrill("collapseAll") : tDrill("expandAll")}
        </button>
      </div>

      <DrillHeader first={t("colTaxName")} cells={[t("colDocs"), t("colBookShort")]} trailing={t("colStatus")} columns={L1_COLS} />

      <ul className="divide-y divide-op-border">
        {taxes.map((x) => (
          <li key={x.key} id={`drill-${x.key}`} className="scroll-mt-4">
            <DrillRow
              id={x.key}
              level={1}
              open={drill.isOpen(x.key)}
              onToggle={drill.toggle}
              label={t(`tile_${x.key}`)}
              columns={L1_COLS}
              cells={[
                { label: t("colDocs"), value: money(x.docCents) },
                { label: t("colBookShort"), value: money(x.bookCents) },
              ]}
              trailing={status(x)}
            >
              <TaxPanel
                tax={x}
                drill={drill}
                money={money}
                docLabel={docLabel}
                sourceLabel={sourceLabel}
                currency={currency}
                query={query}
              />
            </DrillRow>
          </li>
        ))}
        {others.nodes.length > 0 && (
          <li id="drill-otros" className="scroll-mt-4">
            <DrillRow
              id="otros"
              level={1}
              open={drill.isOpen("otros")}
              onToggle={drill.toggle}
              label={t("othersTitle")}
              sublabel={t("othersNote")}
              columns={L1_COLS}
              cells={[
                { label: t("colDocs"), value: "—" },
                { label: t("colBookShort"), value: money(others.valueCents) },
              ]}
              trailing={<StatusBadge tone="info">{t("statusBookOnly")}</StatusBadge>}
            >
              <div className="pb-2">
                <DrillHeader first={t("colFamily")} cells={[t("colEntries"), "", t("colMovement")]} columns={L2_COLS} indent />
                {others.nodes.map((n) => (
                  <DrillRow
                    key={n.id}
                    id={n.id}
                    level={2}
                    open={drill.isOpen(n.id)}
                    onToggle={drill.toggle}
                    label={familyLabel(n.family)}
                    columns={L2_COLS}
                    cells={[
                      { label: t("colEntries"), value: n.count },
                      { label: "", value: "", className: "max-md:hidden" },
                      { label: t("colMovement"), value: money(n.valueCents) },
                    ]}
                  >
                    <AuxiliariesPanel
                      endpoint={AUX_ENDPOINT}
                      query={query}
                      nodeId={n.id}
                      currency={currency}
                      expectedCents={n.valueCents}
                      amountLabel={t("colMovement")}
                    />
                  </DrillRow>
                ))}
              </div>
            </DrillRow>
          </li>
        )}
      </ul>
    </section>
  );
}

function TaxPanel({
  tax: x,
  drill,
  money,
  docLabel,
  sourceLabel,
  currency,
  query,
}: {
  tax: DrillTax;
  drill: ReturnType<typeof useDrillOpen>;
  money: (c: number) => string;
  docLabel: (n: DrillDocNode) => string;
  sourceLabel: (s: string) => string;
  currency: string;
  query: Record<string, string>;
}) {
  const t = useTranslations("opImpuestosRep");
  const groupTitle = "px-4 pt-3 pb-1 text-[11px] font-semibold uppercase tracking-wider text-op-muted md:pl-10";
  const total = "flex flex-wrap items-baseline justify-between gap-x-4 border-t border-op-border/60 px-4 py-2 text-sm font-semibold md:pl-10";
  return (
    <div className="border-t border-op-border/60 pb-2">
      <h3 className={groupTitle}>{t("groupDocs")}</h3>
      {x.docNodes.length === 0 ? (
        <p className="px-4 py-2 text-sm text-op-muted md:pl-10">{t("noDocs")}</p>
      ) : (
        <>
          <DrillHeader first={t("colOriginRate")} cells={[t("colDocCount"), t("colBase"), t("colContribution")]} columns={L2_COLS} indent />
          {x.docNodes.map((n) => (
            <DrillRow
              key={n.id}
              id={n.id}
              level={2}
              open={drill.isOpen(n.id)}
              onToggle={drill.toggle}
              label={docLabel(n)}
              sublabel={n.origin !== "ventas" ? t(`effect_${n.origin}_${n.tax === "iva" ? "iva" : "other"}`) : undefined}
              columns={L2_COLS}
              cells={[
                { label: t("colDocCount"), value: n.count },
                { label: t("colBase"), value: money(n.baseCents) },
                { label: t("colContribution"), value: money(n.taxCents) },
              ]}
            >
              <AuxiliariesPanel
                endpoint={AUX_ENDPOINT}
                query={query}
                nodeId={n.id}
                currency={currency}
                expectedCents={n.taxCents}
                amountLabel={t("colContribution")}
              />
            </DrillRow>
          ))}
        </>
      )}
      <div className={total}>
        <span>{t("totalDocs")}</span>
        <span className="font-mono tabular">{money(x.docCents)}</span>
      </div>

      <h3 className={groupTitle}>{t("groupBook")}</h3>
      {x.bookNodes.length === 0 ? (
        <p className="px-4 py-2 text-sm text-op-muted md:pl-10">{t("noBookLines")}</p>
      ) : (
        <>
          <DrillHeader first={t("colSourceEntry")} cells={[t("colEntries"), "", t("colMovement")]} columns={L2_COLS} indent />
          {x.bookNodes.map((n) => (
            <DrillRow
              key={n.id}
              id={n.id}
              level={2}
              open={drill.isOpen(n.id)}
              onToggle={drill.toggle}
              label={sourceLabel(n.source)}
              sublabel={n.origin ? t("bookFromOrigin", { origin: t(`origin_${n.origin}`) }) : t("bookNoDocument")}
              columns={L2_COLS}
              cells={[
                { label: t("colEntries"), value: n.count },
                { label: "", value: "", className: "max-md:hidden" },
                { label: t("colMovement"), value: money(n.valueCents) },
              ]}
            >
              <AuxiliariesPanel
                endpoint={AUX_ENDPOINT}
                query={query}
                nodeId={n.id}
                currency={currency}
                expectedCents={n.valueCents}
                amountLabel={t("colMovement")}
              />
            </DrillRow>
          ))}
        </>
      )}
      <div className={total}>
        <span>{t("totalBook")}</span>
        <span className="font-mono tabular">{money(x.bookCents)}</span>
      </div>
      {x.diffCents !== 0 && (
        <p className="px-4 pt-2 text-sm md:pl-10">
          {t("diffLine", { amount: money(x.diffCents) })}{" "}
          <a href="#revisar" className="font-medium underline underline-offset-2 hover:text-op-accent">
            {t("whyDiff")}
          </a>
        </p>
      )}
    </div>
  );
}
