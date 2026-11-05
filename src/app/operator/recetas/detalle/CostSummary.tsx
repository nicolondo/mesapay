"use client";

import { useLocale, useTranslations } from "next-intl";
import type { Locale } from "@/i18n/config";
import { formatMoney } from "@/lib/format";
import {
  FOOD_COST_OK_MAX,
  FOOD_COST_WARN_MAX,
  foodCostTone,
  type FoodCostTone,
  type MenuTax,
  type RecipeSummary,
} from "@/lib/erp/recipeDetail";
import { formatPct } from "../recipeModel";
import { AlertIcon, CheckIcon, WarningIcon } from "./icons";

// Tonos del semáforo: los mismos tokens que la lista de platos (verde ok,
// ámbar de los avisos, rojo danger). El texto del valor queda en tinta; el
// color va en el distintivo (con icono + palabra) y en el medidor.
const TONE_TEXT: Record<FoodCostTone, string> = {
  ok: "text-ok",
  warn: "text-[#7F5A1F]",
  high: "text-danger",
};
const TONE_FILL: Record<FoodCostTone, string> = {
  ok: "bg-ok",
  warn: "bg-warn",
  high: "bg-danger",
};
const TONE_TRACK: Record<FoodCostTone, string> = {
  ok: "bg-ok/15",
  warn: "bg-warn/20",
  high: "bg-danger/15",
};

/** Escala del medidor de food cost: 0–60 % (los umbrales caen a la vista). */
const METER_MAX = 60;

export function useTaxShortLabel(tax: MenuTax): string | null {
  const t = useTranslations("opErp");
  if (tax.kind === "none" || tax.pct <= 0) return null;
  return tax.kind === "inc" ? t("rdTaxShortInc") : t("rdTaxShortIva");
}

/**
 * Franja de costos de la receta, siempre a la vista: precio de carta (y su
 * neto del impuesto), costo, food cost con semáforo y margen bruto. En el
 * celular, tres celdas compactas (el precio va en la cabecera).
 */
export function CostSummary({
  summary,
  lineCount,
  tax,
  currency,
  compact = false,
}: {
  summary: RecipeSummary;
  lineCount: number;
  tax: MenuTax;
  currency: string;
  compact?: boolean;
}) {
  const t = useTranslations("opErp");
  const locale = useLocale() as Locale;
  const money = (c: number) => formatMoney(c, { currency, locale });
  const taxLabel = useTaxShortLabel(tax);

  const fc = summary.foodCostPct;
  const tone = fc != null ? foodCostTone(fc) : null;
  const margin = summary.marginCents;

  const costValue = lineCount === 0 ? "—" : money(summary.totalCents);
  const costCaption =
    lineCount === 0
      ? t("rdNoLinesCaption")
      : summary.missingCount > 0
        ? t("rdCostPartial", { count: summary.missingCount })
        : summary.invalidCount > 0
          ? t("rdCostPendingQty")
          : t("rdLinesCount", { count: lineCount });
  const fcCaption =
    fc != null
      ? t("rdFoodCostTarget", { pct: formatPct(FOOD_COST_OK_MAX, locale) })
      : summary.netPriceCents <= 0
        ? t("rdFoodCostNoPrice")
        : lineCount === 0
          ? t("rdNoLinesCaption")
          : summary.missingCount > 0
            ? t("rdFoodCostNeedsCost")
            : t("rdCostPendingQty");
  const marginCaption = taxLabel
    ? t("rdMarginCaptionTax", { tax: taxLabel })
    : t("rdMarginCaption");

  if (compact) {
    return (
      <div
        className="grid grid-cols-3 divide-x divide-op-border rounded-xl border border-op-border bg-op-bg/60"
        data-testid="recipe-cost-summary"
      >
        <CompactCell
          label={t("rdRecipeCost")}
          value={costValue}
          note={summary.missingCount > 0 ? t("rdPartialShort") : null}
        />
        <CompactCell
          label={t("foodCostLabel")}
          value={fc != null ? formatPct(fc, locale) : "—"}
          tone={tone}
        />
        <CompactCell
          label={t("rdGrossMargin")}
          value={margin != null ? money(margin) : "—"}
          danger={margin != null && margin < 0}
        />
      </div>
    );
  }

  return (
    <div
      className="grid grid-cols-4 divide-x divide-op-border rounded-2xl border border-op-border bg-op-bg/50"
      data-testid="recipe-cost-summary"
    >
      <Tile
        label={t("dishPriceLabel")}
        value={money(summary.priceCents)}
        caption={
          taxLabel
            ? t("rdNetOfTax", { tax: taxLabel, amount: money(summary.netPriceCents) })
            : t("rdPerDish")
        }
      />
      <Tile
        label={t("rdRecipeCost")}
        value={costValue}
        caption={costCaption}
        captionWarn={summary.missingCount > 0}
      />
      <Tile
        label={t("foodCostLabel")}
        value={fc != null ? formatPct(fc, locale) : "—"}
        aside={tone ? <ToneBadge tone={tone} /> : null}
        caption={fcCaption}
      >
        {fc != null && tone && <FoodCostMeter pct={fc} tone={tone} />}
      </Tile>
      <Tile
        label={t("rdGrossMargin")}
        value={margin != null ? money(margin) : "—"}
        valueDanger={margin != null && margin < 0}
        caption={marginCaption}
      />
    </div>
  );
}

function Tile({
  label,
  value,
  caption,
  aside,
  valueDanger,
  captionWarn,
  children,
}: {
  label: string;
  value: string;
  caption: string;
  aside?: React.ReactNode;
  valueDanger?: boolean;
  captionWarn?: boolean;
  children?: React.ReactNode;
}) {
  return (
    <div className="px-4 py-3 min-w-0">
      <div className="text-[12px] text-op-muted truncate">{label}</div>
      <div className="mt-0.5 flex items-center gap-2 min-w-0">
        <span
          className={
            "text-[22px] leading-7 font-semibold tabular-nums truncate " +
            (valueDanger ? "text-danger" : "text-op-text")
          }
        >
          {value}
        </span>
        {aside}
      </div>
      {children}
      <div
        className={
          "mt-1 text-[11px] leading-4 truncate " +
          (captionWarn ? "text-[#7F5A1F]" : "text-op-muted")
        }
        title={caption}
      >
        {caption}
      </div>
    </div>
  );
}

function CompactCell({
  label,
  value,
  tone,
  danger,
  note,
}: {
  label: string;
  value: string;
  tone?: FoodCostTone | null;
  danger?: boolean;
  note?: string | null;
}) {
  return (
    <div className="px-3 py-2 min-w-0">
      <div className="text-[11px] text-op-muted truncate">{label}</div>
      <div className="mt-0.5 flex items-center gap-1 min-w-0">
        {tone && <ToneIcon tone={tone} />}
        <span
          className={
            "text-[15px] font-semibold tabular-nums truncate " +
            (danger ? "text-danger" : "text-op-text")
          }
        >
          {value}
        </span>
      </div>
      {note && (
        <div className="text-[10px] text-[#7F5A1F] leading-3 mt-0.5 truncate">
          {note}
        </div>
      )}
    </div>
  );
}

function ToneIcon({ tone }: { tone: FoodCostTone }) {
  const cls = TONE_TEXT[tone];
  if (tone === "ok") return <CheckIcon size={13} className={cls} />;
  if (tone === "warn") return <AlertIcon size={13} className={cls} />;
  return <WarningIcon size={13} className={cls} />;
}

/** Distintivo del semáforo: icono + palabra, no solo color. */
export function ToneBadge({ tone }: { tone: FoodCostTone }) {
  const t = useTranslations("opErp");
  const label =
    tone === "ok" ? t("rdToneOk") : tone === "warn" ? t("rdToneWarn") : t("rdToneHigh");
  return (
    <span
      className={
        "inline-flex items-center gap-1 h-5 px-1.5 rounded-md text-[11px] font-medium shrink-0 " +
        TONE_TRACK[tone] +
        " " +
        TONE_TEXT[tone]
      }
    >
      <ToneIcon tone={tone} />
      {label}
    </span>
  );
}

/**
 * Medidor del food cost (0–60 %): el relleno lleva el semáforo y la pista es
 * un tono más claro del mismo color; dos marcas en 30 % y 40 %.
 */
function FoodCostMeter({ pct, tone }: { pct: number; tone: FoodCostTone }) {
  const t = useTranslations("opErp");
  const locale = useLocale();
  const width = Math.min(Math.max(pct, 0), METER_MAX) / METER_MAX;
  return (
    <div
      role="meter"
      aria-label={t("foodCostLabel")}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(pct * 10) / 10}
      aria-valuetext={formatPct(pct, locale)}
      className={"relative mt-2 h-1.5 rounded-full " + TONE_TRACK[tone]}
    >
      <div
        className={"absolute inset-y-0 left-0 rounded-full " + TONE_FILL[tone]}
        style={{ width: `${width * 100}%` }}
      />
      {[FOOD_COST_OK_MAX, FOOD_COST_WARN_MAX].map((mark) => (
        <span
          key={mark}
          aria-hidden="true"
          className="absolute -top-0.5 -bottom-0.5 w-px bg-op-text/30"
          style={{ left: `${(mark / METER_MAX) * 100}%` }}
        />
      ))}
    </div>
  );
}

/**
 * Aviso único de costos faltantes (en lugar de un párrafo debajo de cada
 * línea): cuántos insumos no tienen costo o están en $0, qué implica y el
 * botón que lleva a corregirlos.
 */
export function MissingCostBanner({
  missing,
  zero,
  onFix,
  compact = false,
}: {
  missing: number;
  zero: number;
  onFix: () => void;
  compact?: boolean;
}) {
  const t = useTranslations("opErp");
  if (missing === 0 && zero === 0) return null;
  const title =
    missing > 0 && zero > 0
      ? t("rdBannerBoth", { missing, zero })
      : missing > 0
        ? t("rdBannerMissing", { count: missing })
        : t("rdBannerZero", { count: zero });
  return (
    <div
      role="status"
      className={
        "flex items-center gap-3 rounded-xl border border-warn/40 bg-warn/10 text-[#7F5A1F] " +
        (compact ? "px-3 py-1.5" : "px-4 py-2.5")
      }
      data-testid="recipe-missing-banner"
    >
      <WarningIcon size={16} />
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium leading-5">{title}</div>
        {!compact && (
          <div className="text-xs leading-4 text-op-muted">
            {t("rdBannerBody")}
          </div>
        )}
      </div>
      <button
        type="button"
        onClick={onFix}
        className={
          "mp-btn mp-btn--secondary mp-btn--sm shrink-0 " +
          (compact ? "h-9! px-3!" : "")
        }
      >
        {t("rdBannerAction")}
      </button>
    </div>
  );
}
