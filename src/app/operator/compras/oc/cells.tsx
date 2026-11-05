"use client";

// Controles de una fila de la orden, los mismos en la tabla de escritorio
// (variante "cell": compactos, sin borde hasta el hover/foco) y en la hoja
// de edición del celular (variante "field": 44 px, con borde).

import { useLocale, useTranslations } from "next-intl";
import type { Locale } from "@/i18n/config";
import { formatMoney } from "@/lib/format";
import { MoneyInput } from "@/components/MoneyInput";
import { sanitizeDecimalInput } from "@/lib/decimalInput";
import { DISPLAY_UNITS } from "@/lib/erp/units";
import { decodeLineTax, encodeLineTax, lineTaxOptions, type LineTaxChoice } from "@/lib/erp/purchaseLineTax";
import {
  centsToRaw,
  computedLineCents,
  effectiveUnitCents,
  PRES,
  priceUnitSymbol,
  type OcLine,
  type PriceSource,
} from "./draft";

export type CellVariant = "cell" | "field";

const CELL =
  "w-full h-9 px-2 rounded-md border border-transparent bg-transparent text-sm text-op-text placeholder:text-op-muted/70 hover:border-op-border focus:border-op-text/40 focus:bg-op-surface focus:outline-none disabled:opacity-40 disabled:hover:border-transparent aria-[invalid=true]:border-danger/60 aria-[invalid=true]:bg-danger/5";
const FIELD =
  "w-full min-h-[44px] px-3 rounded-lg border border-op-border bg-op-bg text-base text-op-text placeholder:text-op-muted focus:outline-none focus:border-op-text/40 disabled:opacity-40 aria-[invalid=true]:border-danger/60";

export function controlCls(variant: CellVariant, extra = ""): string {
  return (variant === "cell" ? CELL : FIELD) + (extra ? " " + extra : "");
}

const PRICE_SOURCE_KEYS: Record<PriceSource, string> = {
  list: "ocPriceFromList",
  history: "ocPriceFromHistory",
  reference: "ocPriceFromReference",
};

export function usePriceSourceText() {
  const t = useTranslations("opErp");
  return (s: PriceSource | null) => (s ? t(PRICE_SOURCE_KEYS[s]) : undefined);
}

export function QtyInput({
  line,
  variant,
  onChange,
  onBlur,
  ariaLabel,
  invalid,
  describedBy,
  id,
}: {
  line: OcLine;
  variant: CellVariant;
  onChange: (qtyRaw: string) => void;
  onBlur?: () => void;
  ariaLabel: string;
  invalid?: boolean;
  describedBy?: string;
  id?: string;
}) {
  return (
    <input
      id={id}
      type="text"
      inputMode="decimal"
      value={line.qtyRaw}
      disabled={!line.ingredient}
      onChange={(e) => onChange(sanitizeDecimalInput(e.target.value))}
      onFocus={(e) => e.currentTarget.select()}
      onBlur={onBlur}
      aria-label={ariaLabel}
      aria-invalid={invalid || undefined}
      aria-describedby={describedBy}
      className={controlCls(variant, "text-right tabular-nums")}
    />
  );
}

/** Flecha de los select de la tabla (el nativo queda lejos del texto). */
function SelectChevron() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-op-muted">
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

export function UnitSelect({
  line,
  variant,
  onChange,
  ariaLabel,
  id,
}: {
  line: OcLine;
  variant: CellVariant;
  onChange: (unit: string) => void;
  ariaLabel: string;
  id?: string;
}) {
  const units = line.ingredient ? DISPLAY_UNITS[line.ingredient.measureKind] : [];
  const label = line.unit === PRES ? line.supplierItem?.presentationLabel : undefined;
  const select = (
    <select
      id={id}
      value={line.unit}
      disabled={!line.ingredient}
      onChange={(e) => onChange(e.target.value)}
      aria-label={ariaLabel}
      title={label}
      className={controlCls(variant, variant === "cell" ? "appearance-none pr-6 text-[13px] truncate cursor-pointer" : "")}
    >
      {!line.ingredient && <option value="" />}
      {line.supplierItem && <option value={PRES}>{line.supplierItem.presentationLabel}</option>}
      {units.map((u) => (
        <option key={u.symbol} value={u.symbol}>
          {u.symbol}
        </option>
      ))}
    </select>
  );
  if (variant !== "cell") return select;
  return (
    <div className="relative">
      {select}
      {line.ingredient && <SelectChevron />}
    </div>
  );
}

export function PriceInput({
  line,
  variant,
  onChange,
  onBlur,
  ariaLabel,
  invalid,
  describedBy,
  id,
}: {
  line: OcLine;
  variant: CellVariant;
  onChange: (priceRaw: string) => void;
  onBlur?: () => void;
  ariaLabel: string;
  invalid?: boolean;
  describedBy?: string;
  id?: string;
}) {
  const t = useTranslations("opErp");
  const sourceText = usePriceSourceText();
  // Con el total escrito a mano, el precio que se ve es el que resulta de él.
  const derived = line.totalRaw != null ? effectiveUnitCents(line) : null;
  const value = line.totalRaw != null ? (derived != null ? centsToRaw(derived) : "") : line.priceRaw;
  const per = line.ingredient && line.unit !== PRES ? priceUnitSymbol(line.ingredient.measureKind) : null;
  return (
    <div className="relative">
      <MoneyInput
        id={id}
        value={value}
        fractionDigits={2}
        disabled={!line.ingredient}
        onChange={onChange}
        onFocus={(e) => e.currentTarget.select()}
        onBlur={onBlur}
        ariaLabel={ariaLabel}
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        title={line.totalRaw != null ? t("ocPriceFromTotal") : sourceText(line.priceSource)}
        className={controlCls(variant, "text-right tabular-nums " + (per ? (variant === "cell" ? "pr-8" : "pr-12") : "") + (line.totalRaw != null ? " text-op-muted" : ""))}
      />
      {per && (
        <span
          aria-hidden="true"
          className={
            "pointer-events-none absolute top-1/2 -translate-y-1/2 font-mono text-op-muted " +
            (variant === "cell" ? "right-2 text-[10px]" : "right-3 text-xs")
          }
        >
          {t("ocPerUnitShort", { unit: per })}
        </span>
      )}
    </div>
  );
}

export function TotalInput({
  line,
  variant,
  onChange,
  onRecalc,
  onBlur,
  ariaLabel,
  id,
}: {
  line: OcLine;
  variant: CellVariant;
  onChange: (totalRaw: string | null) => void;
  onRecalc: () => void;
  onBlur?: () => void;
  ariaLabel: string;
  id?: string;
}) {
  const t = useTranslations("opErp");
  const computed = computedLineCents(line);
  const value = line.totalRaw ?? (computed != null ? centsToRaw(computed) : "");
  const fixed = line.totalRaw != null;
  return (
    <div className="relative">
      <MoneyInput
        id={id}
        value={value}
        fractionDigits={2}
        disabled={!line.ingredient}
        onChange={(raw) => onChange(raw.trim() === "" ? null : raw)}
        onFocus={(e) => e.currentTarget.select()}
        onBlur={onBlur}
        ariaLabel={ariaLabel}
        className={controlCls(variant, "text-right tabular-nums font-medium " + (fixed ? (variant === "cell" ? "pl-7" : "pl-11") : ""))}
      />
      {fixed && (
        <button
          type="button"
          onClick={onRecalc}
          title={t("ocRecalc")}
          aria-label={t("ocRecalc")}
          data-oc-skip-enter=""
          className={
            "absolute top-1/2 -translate-y-1/2 inline-flex items-center justify-center rounded-md text-op-accent hover:bg-op-accent/10 " +
            (variant === "cell" ? "left-0.5 w-6 h-6" : "left-1 w-10 h-10")
          }
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
            <path d="M3 3v5h5" />
          </svg>
        </button>
      )}
    </div>
  );
}

export function TaxSelect({
  choice,
  rates,
  variant,
  onChange,
  disabled,
  ariaLabel,
  id,
}: {
  choice: LineTaxChoice;
  rates: number[];
  variant: CellVariant;
  onChange: (c: LineTaxChoice) => void;
  disabled?: boolean;
  ariaLabel: string;
  id?: string;
}) {
  const t = useTranslations("opErp");
  // En la celda, etiquetas cortas («IVA 19% + INC»); en la hoja, las completas.
  const cell = variant === "cell";
  const label = (c: LineTaxChoice) =>
    c.ivaPct > 0
      ? c.inc
        ? t(cell ? "ocTaxIvaIncCell" : "poTaxIvaInc", { pct: c.ivaPct })
        : t("poTaxIva", { pct: c.ivaPct })
      : c.inc
        ? t(cell ? "ocTaxIncCell" : "poTaxInc")
        : t("poTaxNone");
  const select = (
    <select
      id={id}
      value={encodeLineTax(choice)}
      disabled={disabled}
      onChange={(e) => onChange(decodeLineTax(e.target.value))}
      aria-label={ariaLabel}
      className={controlCls(variant, variant === "cell" ? "appearance-none pr-6 text-[13px] truncate cursor-pointer" : "")}
    >
      {lineTaxOptions(rates, choice).map((c) => (
        <option key={encodeLineTax(c)} value={encodeLineTax(c)}>
          {label(c)}
        </option>
      ))}
    </select>
  );
  if (variant !== "cell") return select;
  return (
    <div className="relative">
      {select}
      {!disabled && <SelectChevron />}
    </div>
  );
}

/**
 * Descuento de la línea en la tabla: el valor y, al lado, el botón que lo
 * cambia entre % y valor fijo (el mismo dato que DiscountControl).
 */
export function DiscountCell({
  raw,
  isPct,
  currency,
  onChange,
  ariaLabel,
  disabled,
}: {
  raw: string;
  isPct: boolean;
  currency: string;
  onChange: (raw: string, isPct: boolean) => void;
  ariaLabel: string;
  disabled?: boolean;
}) {
  const t = useTranslations("opErp");
  return (
    <div className="flex items-center gap-1">
      <input
        type="text"
        inputMode="decimal"
        value={raw}
        disabled={disabled}
        onChange={(e) => onChange(sanitizeDecimalInput(e.target.value), isPct)}
        onFocus={(e) => e.currentTarget.select()}
        placeholder="0"
        aria-label={ariaLabel}
        className={controlCls("cell", "text-right tabular-nums min-w-0")}
      />
      <button
        type="button"
        disabled={disabled}
        onClick={() => onChange(raw, !isPct)}
        aria-label={t("discountToggleUnit")}
        title={t("discountToggleUnit")}
        data-oc-skip-enter=""
        className="shrink-0 h-7 min-w-[30px] px-1 rounded-md border border-op-border text-[11px] font-mono text-op-muted hover:text-op-text hover:bg-op-bg disabled:opacity-40"
      >
        {isPct ? "%" : currency}
      </button>
    </div>
  );
}

/** «−$ 4.400» del descuento de la línea, bajo su control. */
export function DiscountCaption({ cents, currency }: { cents: number; currency: string }) {
  const locale = useLocale() as Locale;
  if (cents <= 0) return null;
  return (
    <span className="block text-[10px] leading-none text-ok tabular-nums mt-0.5 text-right">
      {`− ${formatMoney(cents, { currency, locale })}`}
    </span>
  );
}
