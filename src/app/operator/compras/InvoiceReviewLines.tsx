"use client";

// Líneas de la factura en revisión, COMPACTAS: en escritorio una fila por
// ítem (insumo, cantidad, unidad, valor unitario, valor total, IVA, consumo,
// impuestos incluidos, total con impuestos y estado), editable en la misma
// fila y con la cabecera fija; en el celular y la tableta, dos líneas por
// ítem con su cabecera fija. Lo secundario (cambiar el insumo, recordar el
// nombre, presentación, descuento, desglose) va en «Detalles» de cada fila.
import { useId, useMemo, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import type { Locale } from "@/i18n/config";
import { formatMoney } from "@/lib/format";
import { MoneyInput } from "@/components/MoneyInput";
import { sanitizeDecimalInput } from "@/lib/decimalInput";
import { chooseInvoiceIngredient } from "@/lib/erp/invoiceReviewAlias";
import {
  reviewLineAmounts,
  reviewLineDiscountDetail,
  reviewLineQtyBase,
  reviewPriceQuantity,
  setReviewTaxIncluded,
  type InvoiceReviewLine,
} from "@/lib/erp/invoiceReviewLine";
import type { TaxCellScope } from "@/lib/erp/invoiceReconcile";
import { normalizeTaxPct } from "@/lib/erp/purchaseTax";
import { DISPLAY_UNITS, formatBaseQty, type MeasureKind } from "@/lib/erp/units";
import { DiscountControl } from "./DiscountControl";
import { InvoiceLineTaxToggle } from "./InvoiceLineTaxToggle";
import { controlCls } from "./oc/cells";
import { useMediaQuery } from "./oc/useMediaQuery";
import { Field, inputCls, type IngredientRef } from "./shared";

/** La tabla de una fila por ítem necesita ~1.150 px. */
export const INVOICE_TABLE_QUERY = "(min-width: 1280px)";

export type InvoiceColumnInfo = { header: string | null; scope: TaxCellScope | null } | null;

type Props = {
  lines: InvoiceReviewLine[];
  currency: string;
  taxRates: number[];
  ingredients: IngredientRef[] | null;
  ingredientsError: boolean;
  onRetryIngredients: () => void;
  onChange: (key: number, changes: Partial<InvoiceReviewLine>) => void;
  onRemove: (key: number) => void;
  columns: { iva: InvoiceColumnInfo; consumo: InvoiceColumnInfo };
};

const SCOPE_LABEL: Record<TaxCellScope, string> = {
  unit: "invRecScopeUnit",
  line: "invRecScopeLine",
  percent: "invRecScopePercent",
};

/** Búsqueda sin acentos. */
function fold(s: string): string {
  return s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
}

function unitSymbols(kind: MeasureKind): string {
  return DISPLAY_UNITS[kind].map((u) => u.symbol).join("/");
}

/** Pesos crudos de MoneyInput → centavos (null si no es un monto). */
function pesosToCentsOrNull(value: string): number | null {
  if (!/^\d+(?:[.,]\d{0,2})?$/.test(value.trim())) return null;
  const cents = Math.round(Number(value.replace(",", ".")) * 100);
  return Number.isSafeInteger(cents) ? cents : null;
}

/** Chip emparejado/nuevo: verde «Ya existe» vs azul «Se creará». */
export function MatchStatusChip({ existing }: { existing: boolean }) {
  const t = useTranslations("opErp");
  return (
    <span
      className={
        "px-2 h-5 inline-flex items-center rounded-full text-[10px] font-medium shrink-0 whitespace-nowrap " +
        (existing ? "bg-[#2E7D32]/15 text-[#2E7D32]" : "bg-[#2563EB]/12 text-[#2563EB]")
      }
    >
      {t(existing ? "invReviewStatusExisting" : "invReviewStatusNew")}
    </span>
  );
}

/** Lo que una fila necesita para mostrarse, calculado una sola vez. */
function lineView(l: InvoiceReviewLine) {
  const amounts = reviewLineAmounts(l);
  const quantity = reviewPriceQuantity(l);
  const cost = pesosToCentsOrNull(l.cost);
  const validQty = Number.isFinite(quantity) && quantity > 0;
  const unitCents = l.amountKind === "unit" ? cost : cost != null && validQty ? Math.round(cost / quantity) : null;
  const lineCents = l.amountKind === "line" ? cost : cost != null && validQty ? Math.round(cost * quantity) : null;
  const needsReview = amounts == null || l.taxBasis === "unknown" || l.taxPct == null
    || (l.incNeedsReview === true && !l.incAmount.trim())
    || (l.arithmeticDiffCents != null && l.arithmeticDiffCents !== 0)
    || l.aliasUnavailable === true || reviewLineQtyBase(l) == null
    || (!l.ingredientId && !l.ingredientName.trim());
  return { amounts, unitCents, lineCents, needsReview };
}

export function InvoiceReviewLines(props: Props) {
  const desktop = useMediaQuery(INVOICE_TABLE_QUERY);
  return desktop ? <LinesTable {...props} /> : <LinesCompact {...props} />;
}

function useColumnLabels(columns: Props["columns"]) {
  const t = useTranslations("opErp");
  return useMemo(() => {
    const label = (info: InvoiceColumnInfo, fallback: string) => ({
      name: info?.header?.trim() || t(fallback),
      scope: info?.scope ? t(SCOPE_LABEL[info.scope]) : null,
    });
    return { iva: label(columns.iva, "invTblIva"), consumo: label(columns.consumo, "invTblInc") };
  }, [columns, t]);
}

/* ───────────────────────── Escritorio: tabla ───────────────────────── */

function LinesTable(props: Props) {
  const t = useTranslations("opErp");
  const labels = useColumnLabels(props.columns);
  const th = "py-1.5 px-1 font-mono text-[10px] tracking-[0.08em] uppercase text-op-muted font-normal border-b border-op-border align-bottom";
  return (
    <table className="w-full table-fixed border-separate border-spacing-0 text-sm" data-testid="invoice-lines-table">
      <colgroup>
        <col className="w-[30px]" />
        <col />
        <col className="w-[68px]" />
        <col className="w-[70px]" />
        <col className="w-[112px]" />
        <col className="w-[120px]" />
        <col className="w-[172px]" />
        <col className="w-[108px]" />
        <col className="w-[44px]" />
        <col className="w-[116px]" />
        <col className="w-[88px]" />
        <col className="w-[36px]" />
      </colgroup>
      <thead className="sticky -top-5 z-10">
        <tr className="bg-op-surface">
          <th className={th} scope="col"><span className="sr-only">{t("invRowDetails")}</span></th>
          <th className={th + " text-left"} scope="col">{t("invTblItem")}</th>
          <th className={th + " text-right"} scope="col">{t("invTblQty")}</th>
          <th className={th + " text-left"} scope="col">{t("invTblUnit")}</th>
          <th className={th + " text-right"} scope="col">{t("invTblUnitPrice")}</th>
          <th className={th + " text-right"} scope="col">{t("invTblLineTotal")}</th>
          <th className={th + " text-right"} scope="col">
            <span className="block truncate">{labels.iva.name}</span>
            {labels.iva.scope && <span className="block normal-case tracking-normal truncate">{labels.iva.scope}</span>}
          </th>
          <th className={th + " text-right"} scope="col">
            <span className="block truncate">{labels.consumo.name}</span>
            {labels.consumo.scope && <span className="block normal-case tracking-normal truncate">{labels.consumo.scope}</span>}
          </th>
          <th className={th + " text-center"} scope="col" title={t("invLineTaxIncluded")}>{t("invTblTaxIncluded")}</th>
          <th className={th + " text-right"} scope="col">{t("invTblFinal")}</th>
          <th className={th + " text-left"} scope="col">{t("invTblStatus")}</th>
          <th className={th} scope="col"><span className="sr-only">{t("invReviewRemoveLine")}</span></th>
        </tr>
      </thead>
      {props.lines.map((l, index) => (
        <TableRow key={l.key} line={l} index={index} {...props} />
      ))}
    </table>
  );
}

function TableRow({ line: l, index, ...props }: Props & { line: InvoiceReviewLine; index: number }) {
  const t = useTranslations("opErp");
  const locale = useLocale() as Locale;
  const [open, setOpen] = useState(false);
  const detailsId = useId();
  const view = lineView(l);
  const money = (cents: number) => formatMoney(cents, { currency: props.currency, locale });
  const change = (changes: Partial<InvoiceReviewLine>) => props.onChange(l.key, changes);
  const name = l.ingredientName.trim() || t("invReviewNewIngredientName");
  const label = (col: string) => `${col} · ${name}`;
  const td = "px-1 py-1 align-middle" + (open ? "" : " border-b border-op-border");
  const presentation = l.qtyMode === "presentation" && l.suggestedPresentation;
  return (
    <tbody data-testid="invoice-review-line" className="group">
      <tr className="group-hover:bg-op-bg/60 group-focus-within:bg-op-bg/80 transition-colors">
        <td className={td + " pl-1"}>
          <DetailsButton open={open} controls={detailsId} onToggle={() => setOpen(!open)} n={index + 1} />
        </td>
        <td className={td + " min-w-0"}>
          <div className="truncate text-[13px] font-medium" title={name}>{name}</div>
          {l.sourceDescription && (
            <div className="truncate text-[10px] text-op-muted" title={l.sourceDescription}>
              {t("invAliasSource", { name: l.sourceDescription })}
            </div>
          )}
        </td>
        <td className={td}>
          <input type="text" inputMode={presentation ? "numeric" : "decimal"}
            value={presentation ? l.presentations : l.qty}
            onChange={(e) => change(presentation ? { presentations: e.target.value.replace(/\D/g, "") } : { qty: sanitizeDecimalInput(e.target.value) })}
            onFocus={(e) => e.currentTarget.select()}
            aria-label={label(t("invTblQty"))}
            className={controlCls("cell", "text-right tabular-nums")} />
        </td>
        <td className={td}>
          <UnitCell line={l} onChange={change} ariaLabel={label(t("invTblUnit"))} />
        </td>
        <td className={td}>
          <MoneyInput value={l.amountKind === "unit" ? l.cost : view.unitCents == null ? "" : String(view.unitCents / 100)}
            fractionDigits={2} ariaLabel={label(t("invTblUnitPrice"))}
            onChange={(cost) => change({ amountKind: "unit", cost })}
            className={controlCls("cell", "text-right tabular-nums" + (l.amountKind === "unit" ? "" : " text-op-muted"))} />
        </td>
        <td className={td}>
          <MoneyInput value={l.amountKind === "line" ? l.cost : view.lineCents == null ? "" : String(view.lineCents / 100)}
            fractionDigits={2} ariaLabel={label(t("invTblLineTotal"))}
            onChange={(cost) => change({ amountKind: "line", cost })}
            className={controlCls("cell", "text-right tabular-nums" + (l.amountKind === "line" ? "" : " text-op-muted"))} />
        </td>
        <td className={td}>
          <div className="flex items-center gap-0.5">
            <div className="w-[58px] shrink-0">
              <RateSelect line={l} taxRates={props.taxRates} onChange={change} ariaLabel={label(t("fieldTaxPct"))} />
            </div>
            <MoneyInput value={l.taxAmount} fractionDigits={2}
              placeholder={view.amounts ? money(view.amounts.taxCents) : ""}
              ariaLabel={label(t("invLineVatAmount"))}
              onChange={(taxAmount) => change({ taxAmount })}
              className={controlCls("cell", "text-right tabular-nums min-w-0")} />
          </div>
        </td>
        <td className={td}>
          <MoneyInput value={l.incAmount} fractionDigits={2} placeholder="0"
            ariaLabel={label(t("invLineIncAmount"))}
            onChange={(incAmount) => change({ incAmount })}
            className={controlCls("cell", "text-right tabular-nums" + (l.incNeedsReview && !l.incAmount.trim() ? " border-terracotta/60 bg-terracotta/5" : ""))} />
        </td>
        <td className={td + " text-center"}>
          <TaxIncludedBox line={l} onChange={change} ariaLabel={label(t("invLineTaxIncluded"))} />
        </td>
        <td className={td + " text-right tabular-nums text-[13px] font-medium"}>
          {view.amounts ? money(view.amounts.totalCents) : <span className="text-op-muted">{"—"}</span>}
        </td>
        <td className={td}>
          <StatusChips line={l} needsReview={view.needsReview} />
        </td>
        <td className={td + " pr-1"}>
          <RemoveButton onRemove={() => props.onRemove(l.key)} label={t("invReviewRemoveLine")} />
        </td>
      </tr>
      {open && (
        <tr id={detailsId}>
          <td className="border-b border-op-border" />
          <td colSpan={11} className="px-1 pb-3 pt-1 border-b border-op-border">
            <LineDetails line={l} {...props} wide />
          </td>
        </tr>
      )}
    </tbody>
  );
}

/* ─────────────── Celular y tableta: dos líneas por ítem ─────────────── */

const COMPACT_GRID = "grid grid-cols-[minmax(0,40px)_minmax(0,44px)_minmax(0,1.2fr)_minmax(0,50px)_minmax(0,1fr)] gap-1";
/** Controles de la línea compacta: bajos y con el número completo a la vista. */
const COMPACT_INPUT =
  "w-full h-8 px-1 rounded-md border border-op-border/60 bg-transparent text-[13px] text-op-text placeholder:text-op-muted/70 focus:border-op-text/40 focus:bg-op-surface focus:outline-none disabled:opacity-40";

function LinesCompact(props: Props) {
  const t = useTranslations("opErp");
  const labels = useColumnLabels(props.columns);
  const head = "font-mono text-[9px] tracking-[0.06em] uppercase text-op-muted truncate";
  return (
    <div data-testid="invoice-lines-compact">
      <div className={"sticky -top-5 z-10 bg-op-surface border-b border-op-border py-1 pl-8 pr-1 " + COMPACT_GRID} aria-hidden="true">
        <span className={head + " text-right"}>{t("invTblQty")}</span>
        <span className={head}>{t("invTblUnit")}</span>
        <span className={head + " text-right"}>{t("invTblLineTotal")}</span>
        <span className={head}>{labels.iva.name}</span>
        <span className={head + " text-right"}>{labels.consumo.scope ? `${labels.consumo.name} · ${labels.consumo.scope}` : labels.consumo.name}</span>
      </div>
      {props.lines.map((l, index) => <CompactRow key={l.key} line={l} index={index} {...props} />)}
    </div>
  );
}

function CompactRow({ line: l, index, ...props }: Props & { line: InvoiceReviewLine; index: number }) {
  const t = useTranslations("opErp");
  const locale = useLocale() as Locale;
  const [open, setOpen] = useState(false);
  const detailsId = useId();
  const view = lineView(l);
  const money = (cents: number) => formatMoney(cents, { currency: props.currency, locale });
  const change = (changes: Partial<InvoiceReviewLine>) => props.onChange(l.key, changes);
  const name = l.ingredientName.trim() || t("invReviewNewIngredientName");
  const label = (col: string) => `${col} · ${name}`;
  const presentation = l.qtyMode === "presentation" && l.suggestedPresentation;
  return (
    <div data-testid="invoice-review-line" className="border-b border-op-border py-1 pr-1">
      <div className="flex items-center gap-1.5 min-h-[28px]">
        <DetailsButton open={open} controls={detailsId} onToggle={() => setOpen(!open)} n={index + 1} />
        <span className="flex-1 min-w-0 truncate text-[13px] font-medium" title={l.sourceDescription ?? name}>{name}</span>
        <StatusChips line={l} needsReview={view.needsReview} compact />
        <span className="shrink-0 tabular-nums text-[13px] font-medium">
          {view.amounts ? money(view.amounts.totalCents) : "—"}
        </span>
      </div>
      <div className={"pl-8 " + COMPACT_GRID}>
        <input type="text" inputMode={presentation ? "numeric" : "decimal"}
          value={presentation ? l.presentations : l.qty}
          onChange={(e) => change(presentation ? { presentations: e.target.value.replace(/\D/g, "") } : { qty: sanitizeDecimalInput(e.target.value) })}
          onFocus={(e) => e.currentTarget.select()}
          aria-label={label(t("invTblQty"))}
          className={COMPACT_INPUT + " text-right tabular-nums"} />
        <UnitCell line={l} onChange={change} ariaLabel={label(t("invTblUnit"))} compact />
        <MoneyInput value={l.amountKind === "line" ? l.cost : view.lineCents == null ? "" : String(view.lineCents / 100)}
          fractionDigits={2} ariaLabel={label(t("invTblLineTotal"))}
          onChange={(cost) => change({ amountKind: "line", cost })}
          className={COMPACT_INPUT + " text-right tabular-nums"} />
        <RateSelect line={l} taxRates={props.taxRates} onChange={change} ariaLabel={label(t("fieldTaxPct"))} compact />
        <MoneyInput value={l.incAmount} fractionDigits={2} placeholder="0"
          ariaLabel={label(t("invLineIncAmount"))}
          onChange={(incAmount) => change({ incAmount })}
          className={COMPACT_INPUT + " text-right tabular-nums" + (l.incNeedsReview && !l.incAmount.trim() ? " border-terracotta/60 bg-terracotta/5" : "")} />
      </div>
      {open && (
        <div id={detailsId} className="pl-8 pt-2 pb-2">
          <LineDetails line={l} {...props} wide={false} />
        </div>
      )}
    </div>
  );
}

/* ───────────────────────────── Celdas ─────────────────────────────── */

function DetailsButton({ open, controls, onToggle, n }: { open: boolean; controls: string; onToggle: () => void; n: number }) {
  const t = useTranslations("opErp");
  return (
    <button type="button" onClick={onToggle} aria-expanded={open} aria-controls={controls}
      aria-label={t("invRowDetailsOf", { n })} title={t("invRowDetails")}
      className="w-7 h-7 shrink-0 inline-flex items-center justify-center rounded-md text-op-muted hover:text-ink hover:bg-op-bg">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"
        strokeLinejoin="round" aria-hidden="true" className={"transition-transform " + (open ? "rotate-90" : "")}>
        <path d="M9 6l6 6-6 6" />
      </svg>
    </button>
  );
}

function RemoveButton({ onRemove, label }: { onRemove: () => void; label: string }) {
  return (
    <button type="button" onClick={onRemove} aria-label={label} title={label}
      className="w-8 h-8 inline-flex items-center justify-center rounded-md text-op-muted opacity-60 group-hover:opacity-100 focus-visible:opacity-100 hover:text-danger hover:bg-danger/10 transition">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
        <path d="M6 6l12 12M18 6L6 18" />
      </svg>
    </button>
  );
}

function UnitCell({ line: l, onChange, ariaLabel, compact = false }: {
  line: InvoiceReviewLine; onChange: (c: Partial<InvoiceReviewLine>) => void; ariaLabel: string; compact?: boolean;
}) {
  if (l.qtyMode === "presentation" && l.suggestedPresentation) {
    return (
      <span className="block truncate text-xs text-op-muted px-1" title={l.suggestedPresentation.presentationLabel}>
        {l.suggestedPresentation.presentationLabel}
      </span>
    );
  }
  return (
    <select value={l.unit} onChange={(e) => onChange({ unit: e.target.value })} aria-label={ariaLabel}
      disabled={DISPLAY_UNITS[l.measureKind].length < 2}
      className={compact ? COMPACT_INPUT : controlCls("cell", "text-xs")}>
      {DISPLAY_UNITS[l.measureKind].map((u) => <option key={u.symbol} value={u.symbol}>{u.symbol}</option>)}
    </select>
  );
}

function RateSelect({ line: l, taxRates, onChange, ariaLabel, compact = false }: {
  line: InvoiceReviewLine; taxRates: number[]; onChange: (c: Partial<InvoiceReviewLine>) => void; ariaLabel: string; compact?: boolean;
}) {
  const t = useTranslations("opErp");
  const rates = [...new Set([...taxRates, ...(l.taxPct == null ? [] : [l.taxPct])])].sort((a, b) => a - b);
  return (
    <select value={l.taxPct ?? ""} aria-label={ariaLabel}
      onChange={(e) => onChange({ taxPct: e.target.value === "" ? null : normalizeTaxPct(e.target.value) })}
      className={(compact ? COMPACT_INPUT : controlCls("cell", "text-xs")) + (l.taxPct == null ? " border-terracotta/60 bg-terracotta/5" : "")}>
      <option value="">{t("invTblRateChoose")}</option>
      {rates.map((pct) => <option key={pct} value={pct}>{t("taxPctOption", { pct })}</option>)}
    </select>
  );
}

/** Impuestos incluidos en el importe: marcado, desmarcado o por confirmar. */
function TaxIncludedBox({ line: l, onChange, ariaLabel }: {
  line: InvoiceReviewLine; onChange: (c: Partial<InvoiceReviewLine>) => void; ariaLabel: string;
}) {
  const unknown = l.taxBasis === "unknown";
  return (
    <input type="checkbox" aria-label={ariaLabel} title={ariaLabel}
      aria-checked={unknown ? "mixed" : l.taxBasis === "gross"}
      ref={(node) => { if (node) node.indeterminate = unknown; }}
      checked={l.taxBasis === "gross"}
      onChange={(e) => onChange(setReviewTaxIncluded(l, e.target.checked))}
      className={"h-4 w-4 accent-ink " + (unknown ? "outline outline-2 outline-terracotta/60 outline-offset-1" : "")} />
  );
}

function StatusChips({ line: l, needsReview, compact = false }: { line: InvoiceReviewLine; needsReview: boolean; compact?: boolean }) {
  const t = useTranslations("opErp");
  return (
    <span className="inline-flex items-center gap-1 shrink-0">
      {needsReview || l.lowConfidence ? (
        <span className="px-2 h-5 inline-flex items-center rounded-full text-[10px] font-medium bg-terracotta/12 text-terracotta whitespace-nowrap">
          {t("invRowNeedsReview")}
        </span>
      ) : !compact || l.ingredientId == null ? (
        <MatchStatusChip existing={l.ingredientId != null} />
      ) : null}
    </span>
  );
}

/* ───────────────────── Detalles de la fila (desplegable) ───────────────────── */

function LineDetails({
  line: l, currency, ingredients, ingredientsError, onRetryIngredients, onChange, onRemove, columns, wide,
}: Props & { line: InvoiceReviewLine; wide: boolean }) {
  const t = useTranslations("opErp");
  const locale = useLocale() as Locale;
  const [ingQ, setIngQ] = useState("");
  const [picking, setPicking] = useState(false);
  const change = (changes: Partial<InvoiceReviewLine>) => onChange(l.key, changes);
  const ingMatches = useMemo(() => {
    const needle = fold(ingQ.trim());
    return (ingredients ?? []).filter((i) => !needle || fold(i.name).includes(needle)).slice(0, 8);
  }, [ingredients, ingQ]);
  const qtyBase = reviewLineQtyBase(l);
  const amounts = reviewLineAmounts(l);
  const discountDetail = reviewLineDiscountDetail(l, amounts);
  const priceQuantity = reviewPriceQuantity(l);
  const unitCents = lineView(l).unitCents;
  const money = (cents: number) => formatMoney(cents, { currency, locale });
  const readQtyStr = new Intl.NumberFormat(locale, { maximumFractionDigits: 3 }).format(l.readQty);
  const incName = columns.consumo?.header?.trim() || t("invRecColumnConsumo");

  return (
    <div className={"rounded-xl border border-op-border bg-op-bg/50 p-3 grid gap-3 " + (wide ? "grid-cols-3" : "grid-cols-1")}>
      {/* Insumo y nombre del proveedor */}
      <div className="space-y-2 min-w-0">
        {l.matchSource === "alias" && <p className="text-xs text-[#2E7D32]" role="status">{t("invAliasSaved")}</p>}
        {l.aliasUnavailable && <p className="text-xs text-danger" role="alert">{t("invAliasUnavailable")}</p>}
        {picking ? (
          <div>
            <input type="search" value={ingQ} onChange={(e) => setIngQ(e.target.value)}
              placeholder={t("ingredientSearchPlaceholder")} aria-label={t("ingredientSearchPlaceholder")}
              disabled={ingredients === null} className={inputCls} />
            <div className="mt-1 rounded-lg border border-op-border bg-op-surface overflow-hidden max-h-40 overflow-y-auto">
              {ingredientsError ? (
                <div role="alert" className="px-3 py-2 text-xs text-danger">
                  {t("invAliasIngredientsError")}
                  <button type="button" className="mp-btn mp-btn--secondary mp-btn--sm mt-2" onClick={onRetryIngredients}>{t("invAliasRetry")}</button>
                </div>
              ) : ingredients === null ? (
                <p role="status" className="px-3 py-2 text-xs text-op-muted">{t("loading")}</p>
              ) : ingMatches.length === 0 ? (
                <div className="px-3 py-2 text-xs text-op-muted">{t("noIngredientMatches")}</div>
              ) : (
                ingMatches.map((i) => (
                  <button key={i.id} type="button"
                    onClick={() => { change(chooseInvoiceIngredient(l, i)); setPicking(false); setIngQ(""); }}
                    className="w-full min-h-[40px] px-3 py-1.5 text-left text-sm hover:bg-op-bg border-b border-op-border last:border-b-0">
                    <span>{i.name}</span>
                    <span className="font-mono text-[10px] text-op-muted ml-2">{unitSymbols(i.measureKind)}</span>
                  </button>
                ))
              )}
            </div>
            <button type="button" onClick={() => { setPicking(false); setIngQ(""); }} className="text-[11px] font-medium text-op-muted hover:text-ink mt-1">
              {t("cancel")}
            </button>
          </div>
        ) : l.ingredientId ? (
          <div className="flex flex-wrap gap-x-4 gap-y-2">
            <span className="text-xs text-op-muted">{unitSymbols(l.measureKind)}</span>
            <button type="button" onClick={() => setPicking(true)} className="text-[11px] font-medium text-op-muted hover:text-ink">
              {t("invReviewChangeIngredient")}
            </button>
            <button type="button" onClick={() => change(chooseInvoiceIngredient(l, { id: null, name: "", measureKind: l.measureKind }))}
              className="text-[11px] font-medium text-op-muted hover:text-ink">
              {t("invReviewCreateNewIngredient")}
            </button>
          </div>
        ) : (
          <>
            <button type="button" onClick={() => setPicking(true)} className="mp-btn mp-btn--secondary mp-btn--sm">
              {t("invReviewUseExistingIngredient")}
            </button>
            <Field label={t("invReviewNewIngredientName")} required>
              <input type="text" value={l.ingredientName} maxLength={120} className={inputCls}
                onChange={(e) => change({ ingredientName: e.target.value, manuallySelected: true, aliasUnavailable: false })} />
            </Field>
            <Field label={t("invReviewMeasureKind")}>
              <select value={l.measureKind} className={inputCls}
                onChange={(e) => change(chooseInvoiceIngredient(l, { id: null, name: l.ingredientName, measureKind: e.target.value as MeasureKind }))}>
                <option value="mass">{t("invReviewMeasureMass")}</option>
                <option value="volume">{t("invReviewMeasureVolume")}</option>
                <option value="count">{t("invReviewMeasureCount")}</option>
              </select>
            </Field>
          </>
        )}
        {l.ingredientId && l.sourceLineIndex != null && l.matchSource !== "alias" && (
          <label className="flex items-start gap-2 rounded-xl border border-op-border bg-op-surface p-2 text-xs leading-relaxed">
            <input type="checkbox" aria-label={t("invAliasRemember")} className="mt-0.5 h-4 w-4 shrink-0 accent-ink" checked={l.rememberMatch === true}
              onChange={(e) => change({ rememberMatch: e.target.checked, ...(e.target.checked ? { manuallySelected: true } : {}) })} />
            <span>{t("invAliasRemember")}<span className="block text-op-muted mt-1">{t("invAliasRememberHint")}</span></span>
          </label>
        )}
        {l.suggestedPresentation && (
          <div className="grid grid-cols-2 gap-2">
            {([["presentation", t("invReviewQtyModePresentation")], ["direct", t("invReviewQtyModeDirect")]] as ["presentation" | "direct", string][]).map(([value, text]) => (
              <button key={value} type="button" onClick={() => change({ qtyMode: value })}
                className={"min-h-[36px] px-2 rounded-xl border text-xs font-medium transition-colors " +
                  (l.qtyMode === value ? "border-ink bg-ink text-bone" : "border-op-border bg-op-bg hover:bg-op-surface")}>
                {text}
              </button>
            ))}
          </div>
        )}
        <div className="text-[10px] text-op-muted">
          {[
            l.readQty > 0 ? (l.readUnit ? t("invReviewReadUnitHint", { qty: readQtyStr, unit: l.readUnit }) : t("invReviewReadUnitHintNoUnit", { qty: readQtyStr })) : null,
            qtyBase != null ? formatBaseQty(qtyBase, l.measureKind, locale) : null,
          ].filter(Boolean).join(" · ")}
        </div>
      </div>

      {/* Importe, descuento e impuestos */}
      <div className="space-y-2 min-w-0">
        {!wide && (
          <div className="grid grid-cols-2 gap-2">
            <Field label={`${t("invTblUnitPrice")} (${currency})`}>
              <MoneyInput value={l.amountKind === "unit" ? l.cost : ""} fractionDigits={2}
                placeholder={unitCents == null ? "" : money(unitCents)}
                onChange={(cost) => change({ amountKind: "unit", cost })} className={inputCls} />
            </Field>
            <Field label={t("invLineVatAmount")}>
              <MoneyInput value={l.taxAmount} fractionDigits={2} placeholder={t("invLineAutomatic")}
                onChange={(taxAmount) => change({ taxAmount })} className={inputCls} />
            </Field>
          </div>
        )}
        <div className="rounded-xl border border-op-border bg-op-surface px-3 py-2">
          <DiscountControl id={`inv-line-discount-${l.key}`} label={t("invDiscLineLabel")} raw={l.discRaw ?? ""}
            isPct={l.discIsPct ?? true} currency={currency} onChange={(discRaw, discIsPct) => change({ discRaw, discIsPct })} />
          <p className="mt-1 text-[10px] text-op-muted">{t(l.taxBasis === "gross" ? "invDiscLineHintGross" : "invDiscLineHint")}</p>
          {l.discountFromInvoice && <p className="mt-1 text-[11px] text-[#2E7D32]" role="status">{t("invDiscLineFromInvoice")}</p>}
          {l.discountUnmatched && <p className="mt-1 text-[11px] text-terracotta" role="status">{t("invDiscLineUnmatched")}</p>}
        </div>
        <InvoiceLineTaxToggle basis={l.taxBasis} manual={l.taxBasisManual} onChange={(included) => change(setReviewTaxIncluded(l, included))} />
      </div>

      {/* Avisos y desglose */}
      <div className="space-y-1.5 min-w-0 text-[11px]">
        {columns.consumo?.scope === "unit" && l.incCellCents != null && l.incCellCents > 0 && l.readQty > 0 && (
          <p className="text-op-muted">
            {t("invRecIncPerUnit", { name: incName, unit: money(l.incCellCents), qty: readQtyStr, total: money(Math.round(l.incCellCents * l.readQty)) })}
          </p>
        )}
        {l.arithmeticDiffCents != null && l.arithmeticDiffCents !== 0 && (
          <p className="text-terracotta" role="status">{t("invRecLineArithmetic", { amount: money(Math.abs(l.arithmeticDiffCents)) })}</p>
        )}
        {(l.taxBasis === "unknown" || l.taxPct == null || (l.incNeedsReview && !l.incAmount.trim())) &&
          <p className="text-terracotta">{t("invLineUnknownHint")}</p>}
        {l.taxBeforeDiscount && <p className="text-[#7F5A1F]" role="status">{t("invDiscLineTaxBeforeDiscount")}</p>}
        {amounts && (
          <div className="space-y-0.5 tabular-nums" data-testid="invoice-line-amounts">
            {discountDetail && discountDetail.shownDiscountCents > 0 && <>
              <div className="flex justify-between gap-2 text-op-muted"><span>{t("invDiscLineList")}</span><span>{money(discountDetail.shownListCents)}</span></div>
              <div className="flex justify-between gap-2 text-op-muted"><span>{t("discountLabel")}</span><span className="text-ok">{`− ${money(discountDetail.shownDiscountCents)}`}</span></div>
            </>}
            <div className="flex justify-between gap-2 text-op-muted"><span>{t("invLineNetAmount")}</span><span>{money(amounts.netCents)}</span></div>
            <div className="flex justify-between gap-2 text-op-muted"><span>{t("taxLabel")}</span><span>{money(amounts.taxCents)}</span></div>
            {amounts.incCents > 0 && <div className="flex justify-between gap-2 text-op-muted"><span>{t("invTaxInc")}</span><span>{money(amounts.incCents)}</span></div>}
            <div className="flex justify-between gap-2 text-xs font-medium"><span>{t("invLineFinalAmount")}</span><span>{money(amounts.totalCents)}</span></div>
            {priceQuantity > 0 && <p className="text-op-muted">{t("invLineUnitFinal", { amount: money(Math.round(amounts.totalCents / priceQuantity)), unit: l.qtyMode === "presentation" && l.suggestedPresentation ? l.suggestedPresentation.presentationLabel : l.unit })}</p>}
          </div>
        )}
        {l.amountLabel && <p className="text-[10px] text-op-muted">{t("invLineSourceLabel", { label: l.amountLabel })}</p>}
        <button type="button" onClick={() => onRemove(l.key)}
          className="min-h-[32px] px-2 -ml-2 rounded-full text-[11px] font-medium text-danger hover:bg-danger/10">
          {t("invReviewRemoveLine")}
        </button>
      </div>
    </div>
  );
}
