"use client";

import { startTransition, useEffect, useId, useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import type { Locale } from "@/i18n/config";
import { formatMoney } from "@/lib/format";
import {
  DEFAULT_TIP_PCT,
  MAX_TIP_PCT,
  TIP_OPTIONS,
  clampTipPct,
  hrefWithTip,
  parseTipPct,
  tipCentsFor,
  tipStorageKey,
  totalWithTip,
} from "@/lib/tips";

/**
 * "Total a pagar" del estado del pedido: lo que falta de la cuenta con la
 * propina incluida (10 % por defecto) y un control para moverla y ver el
 * total en vivo ANTES de entrar a pagar.
 *
 * La base (`baseCents`) llega calculada del servidor con el mismo helper
 * que usa el flujo de pago (neto del descuento, menos lo ya pagado de
 * comida), y la propina se redondea con `tipCentsFor` — la misma función
 * que después cobra PayClient. Así el número que el comensal ve acá es
 * exactamente el que le van a cobrar en modo "Todo".
 *
 * El % elegido se recuerda por cuenta en sessionStorage y viaja también en
 * `?tip=` del link a pagar, para que llegue preseleccionado.
 */
export function TipPreview({
  orderId,
  currency,
  locale,
  grossSubtotalCents,
  discountCents,
  discountPct,
  paidFoodCents,
  baseCents,
  taxLine,
  payHref,
  addMoreHref,
}: {
  orderId: string;
  /** Moneda del comercio (país), no del idioma. */
  currency: string;
  locale: Locale;
  /** Subtotal de comida ANTES del descuento — arranque del desglose. */
  grossSubtotalCents: number;
  discountCents: number;
  discountPct: number | null;
  /** Comida ya pagada en pagos aprobados anteriores (split, parciales). */
  paidFoodCents: number;
  /** Lo que FALTA de comida: la base sobre la que va la propina. */
  baseCents: number;
  /** Impuesto que ya viene DENTRO de la base (informativo, no suma). */
  taxLine: { kind: "inc" | "iva"; pct: number; taxCents: number } | null;
  /** Link al flujo de pago, sin `?tip=` (se agrega acá con el % vivo). */
  payHref: string;
  addMoreHref: string;
}) {
  const t = useTranslations("order");
  const tPay = useTranslations("pay");
  const tCommon = useTranslations("common");
  const headingId = useId();
  const [tipPct, setTipPct] = useState<number>(DEFAULT_TIP_PCT);

  // Al montar: si el comensal ya eligió propina para ESTA cuenta (acá o en
  // el flujo de pago), la retomamos. sessionStorage no existe en SSR y puede
  // estar bloqueado (navegación privada) — por eso en efecto y con try/catch.
  useEffect(() => {
    let saved: number | null = null;
    try {
      saved = parseTipPct(sessionStorage.getItem(tipStorageKey(orderId)));
    } catch {
      return;
    }
    if (saved !== null) startTransition(() => setTipPct(saved));
  }, [orderId]);

  function choose(pct: number) {
    const next = clampTipPct(pct);
    setTipPct(next);
    try {
      sessionStorage.setItem(tipStorageKey(orderId), String(next));
    } catch {
      // Sin persistencia — la elección vive igual en el estado y en el link.
    }
  }

  const fmt = (cents: number) => formatMoney(cents, { currency, locale });
  const tipCents = tipCentsFor(baseCents, tipPct);
  const totalCents = totalWithTip(baseCents, tipPct);
  // El desglose sólo aporta cuando la base difiere del consumo (hay
  // descuento o ya se pagó parte); si no, "Consumo" ya es la base.
  const showLedger = discountCents > 0 || paidFoodCents > 0;

  return (
    <section
      aria-labelledby={headingId}
      className="mt-8 rounded-2xl border border-hairline bg-paper p-4"
    >
      <h2
        id={headingId}
        className="font-mono text-[10px] tracking-[0.14em] uppercase text-muted"
      >
        {t("tipPreviewTitle")}
      </h2>

      <div className="mt-3 space-y-1.5">
        <Row label={t("tipPreviewBase")} value={fmt(grossSubtotalCents)} />
        {discountCents > 0 && (
          <Row
            label={
              discountPct
                ? t("discountRowPct", { pct: discountPct })
                : t("discountRow")
            }
            value={"− " + fmt(discountCents)}
            muted
          />
        )}
        {paidFoodCents > 0 && (
          <Row
            label={tPay("rowPaidFood")}
            value={"− " + fmt(paidFoodCents)}
            muted
          />
        )}
        {showLedger && (
          <Row label={tPay("rowOwedFood")} value={fmt(baseCents)} accent />
        )}
        {taxLine && (
          <div className="flex items-center justify-between text-xs text-muted-2">
            <span>
              {taxLine.kind === "inc"
                ? tCommon("taxIncludedInc", { pct: taxLine.pct })
                : tCommon("taxIncludedIva", { pct: taxLine.pct })}
            </span>
            <span className="font-mono tabular">{fmt(taxLine.taxCents)}</span>
          </div>
        )}
      </div>

      <div className="mt-4">
        <div className="flex items-center justify-between text-sm">
          <span>{t("tipPreviewTip", { pct: tipPct })}</span>
          <span className="font-mono tabular">{fmt(tipCents)}</span>
        </div>
        <div className="mt-2 flex flex-wrap gap-2">
          {TIP_OPTIONS.map((p) => (
            <button
              key={p}
              type="button"
              aria-pressed={tipPct === p}
              onClick={() => choose(p)}
              className={
                "h-9 px-3 rounded-full text-sm border " +
                (tipPct === p
                  ? "bg-ink text-bone border-ink"
                  : "bg-ivory border-hairline text-ink")
              }
            >
              {p === 0 ? tPay("noTip") : `${p}%`}
            </button>
          ))}
        </div>
        <input
          type="range"
          min={0}
          max={MAX_TIP_PCT}
          step={1}
          value={tipPct}
          onChange={(e) => choose(Number(e.currentTarget.value))}
          aria-label={t("tipPreviewSlider")}
          aria-valuetext={t("tipPreviewTip", { pct: tipPct })}
          className="mt-3 w-full accent-ink"
        />
      </div>

      <div className="mt-4 pt-4 border-t border-hairline flex items-baseline justify-between gap-3">
        <span className="font-mono text-[10px] tracking-[0.14em] uppercase text-muted">
          {t("tipPreviewTotal")}
        </span>
        <span className="font-display text-3xl" aria-live="polite" aria-atomic="true">
          {fmt(totalCents)}
        </span>
      </div>
      <p className="mt-2 text-xs text-muted-2">{t("tipPreviewHint")}</p>

      <div className="mt-4 flex gap-2">
        <Link
          href={addMoreHref}
          className="flex-1 h-11 px-4 rounded-full border border-hairline inline-flex items-center justify-center text-sm font-medium"
        >
          {t("addMore")}
        </Link>
        <Link
          href={hrefWithTip(payHref, tipPct)}
          className="flex-1 h-11 px-4 rounded-full bg-ink text-bone inline-flex items-center justify-center text-sm font-medium"
        >
          {t("pay")}
        </Link>
      </div>
    </section>
  );
}

function Row({
  label,
  value,
  muted,
  accent,
}: {
  label: string;
  value: string;
  muted?: boolean;
  /** Énfasis leve para "Falta de comida", la base de la propina. */
  accent?: boolean;
}) {
  return (
    <div
      className={
        "flex items-center justify-between gap-3 " +
        (muted ? "text-muted " : "") +
        (accent ? "pt-1 mt-1 border-t border-hairline font-medium" : "")
      }
    >
      <span className="text-sm">{label}</span>
      <span className="font-mono tabular text-sm">{value}</span>
    </div>
  );
}
