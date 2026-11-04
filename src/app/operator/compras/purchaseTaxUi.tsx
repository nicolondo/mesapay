"use client";

// Impuestos de una compra MANUAL en pantalla: el control «Impuesto» de cada
// línea (IVA, impuesto al consumo o los dos) y las retenciones de la factura
// del proveedor («Nueva orden» con «Ya recibí esta mercancía» y «Recibir
// mercancía»). Los cálculos son los puros que también corre el servidor
// (purchaseLineTax.ts, purchaseRetentions.ts): lo que se ve es lo que se
// guarda.

import { useEffect, useMemo, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import type { Locale } from "@/i18n/config";
import { formatMoney } from "@/lib/format";
import { MoneyInput } from "@/components/MoneyInput";
import {
  decodeLineTax,
  encodeLineTax,
  lineTaxOptions,
  type LineTaxChoice,
} from "@/lib/erp/purchaseLineTax";
import {
  purchaseRetentionError,
  purchaseRetentionTotals,
  retentionAmountForRate,
  retentionConceptBaseCents,
  suggestPurchaseRetentions,
  PURCHASE_RETENTION_KINDS,
  type PurchaseRetentionError,
  type PurchaseRetentionKind,
  type PurchaseRetentionTotals,
  type RetentionDoc,
} from "@/lib/erp/purchaseRetentions";
import type { RetentionConceptInput } from "@/lib/erp/retencionesCore";
import { DiscountControl } from "./DiscountControl";

/* ───────────────────── Contexto (conceptos + UVT) ──────────────────── */

export type PurchaseTaxContext = {
  /** Conceptos de retención ACTIVOS del comercio. */
  concepts: RetentionConceptInput[];
  uvtCents: number;
};

/**
 * Conceptos activos y UVT para sugerir retenciones. Si falla, la sección
 * sigue sirviendo para escribirlas a mano (sin sugerencia).
 */
export function usePurchaseTaxContext(enabled = true): PurchaseTaxContext | null {
  const [ctx, setCtx] = useState<PurchaseTaxContext | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    fetch("/api/operator/purchase-orders/tax-context")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("load"))))
      .then((j: PurchaseTaxContext) => {
        if (alive) setCtx({ concepts: j.concepts ?? [], uvtCents: j.uvtCents ?? 0 });
      })
      .catch(() => {
        if (alive) setCtx({ concepts: [], uvtCents: 0 });
      });
    return () => {
      alive = false;
    };
  }, [enabled]);
  return ctx;
}

/* ───────────────────────── Impuesto de la línea ────────────────────── */

const labelCls = "font-mono text-[10px] tracking-[0.15em] uppercase text-op-muted mb-1 block";
const selectCls =
  "w-full min-h-[44px] px-3 rounded-lg border border-op-border bg-op-bg text-sm disabled:opacity-40";

/** Texto corto del impuesto de una línea: «IVA 19% · Consumo $1.200». */
export function useLineTaxText() {
  const t = useTranslations("opErp");
  const locale = useLocale() as Locale;
  return (taxPct: number, incCents: number, currency: string) =>
    [
      taxPct > 0 ? t("poTaxIva", { pct: taxPct }) : null,
      incCents > 0 ? t("poTaxIncShort", { amount: formatMoney(incCents, { currency, locale }) }) : null,
    ]
      .filter(Boolean)
      .join(" · ");
}

/**
 * «Impuesto» de una línea: sin impuesto, IVA a una tarifa del país, impuesto
 * al consumo o IVA + consumo. Con consumo, su valor en % de la base de la
 * línea (8 % lo típico) o fijo; `incCents` es lo que resulta, para mostrarlo.
 */
export function LineTaxFields({
  id,
  choice,
  rates,
  incRaw,
  incIsPct,
  incCents,
  currency,
  onChange,
  disabled,
}: {
  id: string;
  choice: LineTaxChoice;
  rates: number[];
  incRaw: string;
  incIsPct: boolean;
  incCents: number;
  currency: string;
  onChange: (next: { choice?: LineTaxChoice; incRaw?: string; incIsPct?: boolean }) => void;
  disabled?: boolean;
}) {
  const t = useTranslations("opErp");
  const locale = useLocale() as Locale;
  const options = lineTaxOptions(rates, choice);
  const label = (c: LineTaxChoice) =>
    c.ivaPct > 0
      ? c.inc
        ? t("poTaxIvaInc", { pct: c.ivaPct })
        : t("poTaxIva", { pct: c.ivaPct })
      : c.inc
        ? t("poTaxInc")
        : t("poTaxNone");
  return (
    <div className="space-y-2">
      <div>
        <label htmlFor={`${id}-tax`} className={labelCls}>
          {t("poTaxLabel")}
        </label>
        <select
          id={`${id}-tax`}
          value={encodeLineTax(choice)}
          onChange={(e) => onChange({ choice: decodeLineTax(e.target.value) })}
          disabled={disabled}
          className={selectCls}
        >
          {options.map((c) => (
            <option key={encodeLineTax(c)} value={encodeLineTax(c)}>
              {label(c)}
            </option>
          ))}
        </select>
      </div>
      {choice.inc && (
        <DiscountControl
          id={`${id}-inc`}
          label={t("poTaxIncLabel")}
          raw={incRaw}
          isPct={incIsPct}
          currency={currency}
          placeholder="0"
          onChange={(raw, isPct) => onChange({ incRaw: raw, incIsPct: isPct })}
          hint={
            incIsPct && incCents > 0
              ? t("poTaxIncResult", { amount: formatMoney(incCents, { currency, locale }) })
              : t("poTaxIncHint")
          }
          className="rounded-xl border border-op-border bg-op-surface px-3 py-2"
        />
      )}
    </div>
  );
}

/* ─────────────────────── Retenciones de la factura ─────────────────── */

/** Una retención en pantalla: de un concepto (tarifa) o escrita a mano. */
export type RetentionLineState = {
  key: string;
  conceptId: string | null;
  kind: PurchaseRetentionKind;
  /** Nombre del concepto; null = retención a mano (se muestra su tipo). */
  name: string | null;
  rateBps: number | null;
  base: "subtotal" | "tax";
  /** Valor digitado; null = tarifa × base (sigue a la base). */
  amountCents: number | null;
};

export type InvoiceRetentions = {
  lines: RetentionLineState[];
  /** ¿Son las sugeridas (siguen a la base y al umbral)? */
  suggested: boolean;
  amountOf: (l: RetentionLineState) => number;
  totals: PurchaseRetentionTotals;
  error: PurchaseRetentionError | null;
  edit: (fn: (cur: RetentionLineState[]) => RetentionLineState[]) => void;
  reset: () => void;
};

let retentionKeySeq = 0;

/**
 * Estado de las retenciones de una factura: las SUGERIDAS (conceptos activos
 * + umbral UVT sobre la base) hasta que el operador toque la lista; desde
 * ahí, las suyas (una de concepto sigue la tarifa sobre la base mientras no
 * le cambie el valor).
 */
export function useInvoiceRetentions(ctx: PurchaseTaxContext | null, doc: RetentionDoc): InvoiceRetentions {
  const [edited, setEdited] = useState<RetentionLineState[] | null>(null);
  const { baseCents, ivaCents } = doc;
  const suggestedLines = useMemo<RetentionLineState[]>(
    () =>
      ctx
        ? suggestPurchaseRetentions(ctx.concepts, { baseCents, ivaCents }, ctx.uvtCents).map((s) => ({
            key: `c:${s.conceptId}`,
            conceptId: s.conceptId,
            kind: s.kind,
            name: s.name,
            rateBps: s.rateBps,
            base: s.base,
            amountCents: null,
          }))
        : [],
    [ctx, baseCents, ivaCents],
  );
  const lines = edited ?? suggestedLines;
  const amountOf = (l: RetentionLineState) =>
    l.amountCents ?? retentionAmountForRate(l.rateBps ?? 0, retentionConceptBaseCents(l, doc));
  const totals = purchaseRetentionTotals(lines.map((l) => ({ kind: l.kind, amountCents: amountOf(l) })));
  return {
    lines,
    suggested: edited === null,
    amountOf,
    totals,
    error: purchaseRetentionError(totals, doc),
    edit: (fn) => setEdited((prev) => fn(prev ?? suggestedLines)),
    reset: () => setEdited(null),
  };
}

const KIND_LABEL_KEYS: Record<PurchaseRetentionKind, string> = {
  retefuente: "invTaxRetefuente",
  reteiva: "invTaxReteIva",
  reteica: "invTaxReteIca",
};

/** Tarifa en bps → "2,5" (separador del idioma). */
function fmtRate(bps: number, locale: Locale): string {
  return new Intl.NumberFormat(locale === "en" ? "en-US" : locale === "pt" ? "pt-BR" : "es-CO", {
    maximumFractionDigits: 2,
  }).format(bps / 100);
}

/**
 * «Retenciones que practicas» de la factura: las sugeridas o las del
 * operador, cada una editable o para quitar, y «+ Agregar retención» (un
 * concepto activo o, si el comercio no los tiene, el tipo con su valor a
 * mano).
 */
export function InvoiceRetentionsEditor({
  state,
  ctx,
  doc,
  currency,
  hint,
}: {
  state: InvoiceRetentions;
  ctx: PurchaseTaxContext | null;
  doc: RetentionDoc;
  currency: string;
  /** Aclaración del contexto (p. ej. que se practican por entrega). */
  hint?: string;
}) {
  const t = useTranslations("opErp");
  const locale = useLocale() as Locale;
  const money = (c: number) => formatMoney(c, { currency, locale });
  const concepts = ctx?.concepts ?? [];
  const usedConcepts = new Set(state.lines.map((l) => l.conceptId).filter(Boolean));
  const addableConcepts = concepts.filter((c) => !usedConcepts.has(c.id) && PURCHASE_RETENTION_KINDS.includes(c.kind as PurchaseRetentionKind));
  const lineName = (l: RetentionLineState) => l.name ?? t(KIND_LABEL_KEYS[l.kind]);

  function add(value: string) {
    if (value.startsWith("concept:")) {
      const c = concepts.find((x) => x.id === value.slice("concept:".length));
      if (!c) return;
      state.edit((cur) => [
        ...cur,
        {
          key: `c:${c.id}`,
          conceptId: c.id,
          kind: c.kind as PurchaseRetentionKind,
          name: c.name,
          rateBps: c.rateBps,
          base: c.base === "tax" ? "tax" : "subtotal",
          amountCents: null,
        },
      ]);
    } else if (value.startsWith("kind:")) {
      const kind = value.slice("kind:".length) as PurchaseRetentionKind;
      if (!PURCHASE_RETENTION_KINDS.includes(kind)) return;
      state.edit((cur) => [
        ...cur,
        { key: `m:${++retentionKeySeq}`, conceptId: null, kind, name: null, rateBps: null, base: kind === "reteiva" ? "tax" : "subtotal", amountCents: 0 },
      ]);
    }
  }

  return (
    <div className="rounded-xl border border-op-border bg-op-bg/50 p-3 space-y-2" data-testid="invoice-retentions">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium">{t("poRetTitle")}</span>
        {!state.suggested && concepts.length > 0 && (
          <button
            type="button"
            onClick={state.reset}
            className="text-[11px] font-medium text-op-muted hover:text-ink min-h-[32px] shrink-0"
          >
            {t("poRetReset")}
          </button>
        )}
      </div>
      {!ctx ? (
        <p className="text-xs text-op-muted">{t("loading")}</p>
      ) : (
        <>
          {state.lines.length === 0 ? (
            <p className="text-xs text-op-muted">
              {concepts.length === 0 ? t("poRetNoConcepts") : t("poRetNone")}
            </p>
          ) : (
            <ul className="space-y-2">
              {state.lines.map((l) => {
                const base = retentionConceptBaseCents(l, doc);
                const name = lineName(l);
                return (
                  <li key={l.key} className="flex items-center gap-2">
                    <div className="flex-1 min-w-0">
                      <div className="text-sm leading-snug break-words">{name}</div>
                      <div className="text-[11px] text-op-muted leading-snug break-words">
                        {l.rateBps != null
                          ? t(l.base === "tax" ? "poRetOnTax" : "poRetOnBase", { rate: fmtRate(l.rateBps, locale), base: money(base) })
                          : t(l.base === "tax" ? "poRetManualTax" : "poRetManualBase", { base: money(base) })}
                      </div>
                    </div>
                    <MoneyInput
                      value={String(state.amountOf(l) / 100)}
                      fractionDigits={2}
                      onChange={(raw) => {
                        const n = Number(raw);
                        const cents = Number.isFinite(n) && n > 0 ? Math.round(n * 100) : 0;
                        state.edit((cur) => cur.map((x) => (x.key === l.key ? { ...x, amountCents: cents } : x)));
                      }}
                      ariaLabel={name}
                      className="w-28 min-h-[44px] px-2 rounded-lg border border-op-border bg-op-surface text-sm text-right tabular-nums"
                    />
                    <button
                      type="button"
                      onClick={() => state.edit((cur) => cur.filter((x) => x.key !== l.key))}
                      aria-label={t("poRetRemove", { name })}
                      className="min-h-[44px] min-w-[36px] text-op-muted hover:text-ink shrink-0"
                    >
                      {"✕"}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          {state.suggested && state.lines.length > 0 && (
            <p className="text-[11px] text-op-muted">{t("poRetSuggested")}</p>
          )}
          <select
            value=""
            onChange={(e) => add(e.target.value)}
            className={selectCls}
            aria-label={t("poRetAdd")}
          >
            <option value="">{t("poRetAdd")}</option>
            {addableConcepts.map((c) => (
              <option key={c.id} value={`concept:${c.id}`}>
                {c.name}
              </option>
            ))}
            {PURCHASE_RETENTION_KINDS.map((kind) => (
              <option key={kind} value={`kind:${kind}`}>
                {t("poRetAddManual", { name: t(KIND_LABEL_KEYS[kind]) })}
              </option>
            ))}
          </select>
          {hint && <p className="text-[11px] text-op-muted">{hint}</p>}
          {state.error && (
            <p role="alert" className="text-xs text-danger">
              {t(state.error === "retention_exceeds_base" ? "errRetentionExceedsBase" : "errRetentionExceedsTotal")}
            </p>
          )}
        </>
      )}
    </div>
  );
}

/** Filas por tipo para el desglose (detalle, impresión): solo las que hay. */
export function useRetentionRows() {
  const t = useTranslations("opErp");
  return (r: Partial<PurchaseRetentionTotals>) =>
    (
      [
        ["retefuente", r.retefuenteCents ?? 0],
        ["reteiva", r.reteIvaCents ?? 0],
        ["reteica", r.reteIcaCents ?? 0],
      ] as [PurchaseRetentionKind, number][]
    )
      .filter(([, cents]) => cents > 0)
      .map(([kind, cents]) => ({ label: t(KIND_LABEL_KEYS[kind]), cents }));
}
