/**
 * Rótulos del despliegue de impuestos a partir de los traductores
 * (`opImpuestosRep`, `opReportDrill`, `opErp`). Los comparten la página
 * (server) y la API de auxiliares (CSV/Excel), para que pantalla y archivo
 * digan lo mismo. Sin dependencias de React ni de la base.
 */
import type { Locale } from "@/i18n/config";
import { localeTag } from "@/lib/format";
import { makeSourceLabel } from "./labels";
import type { CheckResult } from "./taxesChecks";
import type { TaxesExportLabels } from "./taxesExport";
import type { DrillTaxKey } from "./taxesDrill";

type Translator = {
  (key: string, params?: Record<string, string | number>): string;
  has(key: string): boolean;
};

/** Porcentaje con la coma o el punto del idioma (2,5 / 2.5), sin ceros de más. */
export function fmtPct(pct: number, locale: Locale): string {
  return new Intl.NumberFormat(localeTag(locale), { maximumFractionDigits: 2 }).format(pct);
}

export function makeRateLabel(t: Translator, locale: Locale) {
  return (row: { pct: number | null; conceptName: string | null; rateKey?: string }): string => {
    if (row.conceptName) return row.conceptName;
    if (row.pct == null) return t("noRate");
    const pct = fmtPct(row.pct, locale);
    return row.rateKey?.startsWith("e") ? t("effectiveRate", { pct }) : t("ratePct", { pct });
  };
}

export function makeTaxLabel(t: Translator) {
  return (tax: DrillTaxKey): string => t(`tile_${tax}`);
}

export function makeFamilyLabel(t: Translator) {
  return (family: string): string => {
    const key = `fam_${family.replaceAll("-", "_")}`;
    return t.has(key) ? t(key) : family;
  };
}

/** Título de una revisión (con su conteo). */
export function makeCheckTitle(t: Translator) {
  return (c: Pick<CheckResult, "key" | "count">): string => t(`check_${c.key}_title`, { count: c.count });
}

export function makeTaxesExportLabels(
  t: Translator,
  tDrill: Translator,
  tErp: Translator,
  locale: Locale,
): TaxesExportLabels {
  return {
    col: {
      date: tDrill("colDate"),
      document: tDrill("colDocument"),
      reference: tDrill("colReference"),
      party: tDrill("colParty"),
      nit: tDrill("colNit"),
      rate: tDrill("colRate"),
      base: tDrill("colBase"),
      tax: tDrill("colTax"),
      voucher: tDrill("colVoucher"),
      source: tDrill("colSource"),
      account: tDrill("colAccount"),
      accountName: tDrill("colAccountName"),
      memo: tDrill("colMemo"),
      value: tDrill("colValue"),
      day: tDrill("colDay"),
      expected: tDrill("colExpected"),
      book: tDrill("colBook"),
      difference: tDrill("colDifference"),
      taxName: t("colTaxName"),
      origin: t("colOrigin"),
      concept: t("colCheck"),
      docs: t("colDocs"),
      count: tDrill("colCount"),
      grossTax: t("colGrossTaxReg"),
      nonDeductible: t("colNonDeductible"),
      notes: tDrill("colNotes"),
    },
    sections: {
      summary: t("xlsxSummary"),
      docs: t("xlsxDocs"),
      ledger: t("xlsxLedger"),
      checks: t("xlsxChecks"),
    },
    taxLabel: makeTaxLabel(t),
    originLabel: (o) => (t.has(`origin_${o}`) ? t(`origin_${o}`) : o),
    sourceLabel: makeSourceLabel(tErp),
    familyLabel: makeFamilyLabel(t),
    rateLabel: makeRateLabel(t, locale),
    flagLabel: (f) => (tDrill.has(`flag_${f}`) ? tDrill(`flag_${f}`) : f),
    checkTitle: makeCheckTitle(t),
    finalConsumer: t("finalConsumer"),
    unnumbered: tDrill("unnumbered"),
  };
}
