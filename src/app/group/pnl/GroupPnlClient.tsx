"use client";

import { useEffect, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import type { Locale } from "@/i18n/config";
import { formatMoney, localeTag } from "@/lib/format";

/* ───────────────────────────── Tipos ───────────────────────────────── */
// Espejo de GET /api/group/pnl (spec B2 · D4). Cada sede trae SU moneda
// (país del restaurante); el consolidado agrupa por moneda sin convertir.

type SitePnl = {
  salesCents: number;
  tipsCents: number;
  taxesCents: number;
  consumptionCents: number;
  wasteCents: number;
  expensesByCategory: Array<{ category: string; amountCents: number }>;
  purchasesReceivedCents: number;
  expensesCents: number;
  grossProfitCents: number;
  grossMarginPct: number | null;
  operatingProfitCents: number;
  operatingMarginPct: number | null;
};

type Site = {
  restaurantId: string;
  name: string;
  currency: string;
  enabled: boolean;
  /** null cuando enabled = false (módulo apagado: sin números). */
  pnl: SitePnl | null;
};

type Consolidated = {
  currency: string;
  salesCents: number;
  consumptionCents: number;
  wasteCents: number;
  expensesCents: number;
  grossProfitCents: number;
  operatingProfitCents: number;
  sites: number;
};

type GroupPnlPayload = {
  month: string;
  sites: Site[];
  consolidated: Consolidated[];
};

/* ─────────────────────────── Helpers ───────────────────────────────── */
// Selector de mes: duplicado de ContabilidadClient (extraerlo a un
// componente compartido operador↔grupo sería más invasivo que copiar
// tres funciones puras — mismo criterio que la spec para el subagente).

/** "2026-07" del mes actual (hora local del dispositivo). */
function currentMonth(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

/** "2026-07" ± n meses — aritmética UTC sobre el día 1 (sin DST). */
function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** "Julio de 2026" — label del selector de mes en el idioma del usuario. */
function monthLabel(month: string, locale: Locale): string {
  const [y, m] = month.split("-").map(Number);
  const label = new Intl.DateTimeFormat(localeTag(locale), {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(y, m - 1, 1)));
  return label.charAt(0).toUpperCase() + label.slice(1);
}

/** % (escala 0-100, 1 decimal) → "66,5 %" localizado; null → "—". */
function fmtPct(pct: number | null, locale: Locale): string {
  if (pct === null) return "—";
  return new Intl.NumberFormat(localeTag(locale), {
    style: "percent",
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  }).format(pct / 100);
}

/** % del consolidado — se deriva client-side (el server no lo trae). */
function pctOf(partCents: number, baseCents: number): number | null {
  if (baseCents === 0) return null;
  return Math.round((partCents / baseCents) * 1000) / 10;
}

/** Verde/rojo según signo de la utilidad; 0 queda neutro. */
function profitCls(cents: number): string {
  return cents > 0 ? "text-ok" : cents < 0 ? "text-danger" : "";
}

/* ───────────────────────────── Client ──────────────────────────────── */

export function GroupPnlClient() {
  const t = useTranslations("opGroup");
  const locale = useLocale() as Locale;
  const [month, setMonth] = useState(currentMonth);
  // Caché por mes (patrón engCache): navegar meses ya vistos no re-fetchea.
  const [cache, setCache] = useState<Record<string, GroupPnlPayload>>({});
  const [loadErr, setLoadErr] = useState(false);
  const data = cache[month];

  useEffect(() => {
    if (cache[month]) return;
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(`/api/group/pnl?month=${month}`);
        if (!r.ok) throw new Error("load_failed");
        const j = (await r.json()) as GroupPnlPayload;
        if (cancelled) return;
        setCache((c) => ({ ...c, [month]: j }));
        setLoadErr(false);
      } catch {
        if (!cancelled) setLoadErr(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [month, cache]);

  return (
    <div className="space-y-4">
      {/* Selector de mes: ◀ Julio de 2026 ▶ (patrón del operador) */}
      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={() => setMonth((m) => shiftMonth(m, -1))}
          aria-label={t("gpMonthPrev")}
          className="min-h-[44px] min-w-[44px] rounded-full border border-op-border bg-op-surface text-sm text-op-muted hover:text-op-text hover:bg-op-bg"
        >
          {"◀"}
        </button>
        <div className="text-sm font-medium">{monthLabel(month, locale)}</div>
        <button
          type="button"
          onClick={() => setMonth((m) => shiftMonth(m, 1))}
          aria-label={t("gpMonthNext")}
          className="min-h-[44px] min-w-[44px] rounded-full border border-op-border bg-op-surface text-sm text-op-muted hover:text-op-text hover:bg-op-bg"
        >
          {"▶"}
        </button>
      </div>

      {data === undefined ? (
        loadErr ? (
          <div className="text-xs text-danger">{t("gpLoadFailed")}</div>
        ) : (
          <div className="py-6 text-center text-sm text-op-muted">
            {t("gpLoading")}
          </div>
        )
      ) : (
        <>
          {/* Consolidado por moneda — normalmente un solo bloque; grupos
              multi-país agrupan sin convertir (D4). */}
          {data.consolidated.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-op-border bg-op-surface/50 p-8 text-center text-sm text-op-muted">
              {t("gpNoActiveSites")}
            </div>
          ) : (
            data.consolidated.map((c) => (
              <ConsolidatedCard key={c.currency} c={c} locale={locale} />
            ))
          )}

          {/* Detalle por sede: números solo con el módulo activo */}
          {data.sites.length > 0 && (
            <section>
              <div className="font-mono text-[10px] tracking-[0.15em] uppercase text-op-muted mb-2">
                {t("gpBySite")}
              </div>
              <div className="bg-op-surface border border-op-border rounded-2xl overflow-hidden">
                {data.sites.map((s) => (
                  <SiteRow key={s.restaurantId} site={s} locale={locale} />
                ))}
              </div>
            </section>
          )}
        </>
      )}
    </div>
  );
}

/** Bloque consolidado de una moneda: cifras grandes + stats del mes. */
function ConsolidatedCard({
  c,
  locale,
}: {
  c: Consolidated;
  locale: Locale;
}) {
  const t = useTranslations("opGroup");
  const money = (cents: number) =>
    formatMoney(cents, { currency: c.currency, locale });

  return (
    <div className="bg-op-surface border border-op-border rounded-2xl p-4">
      <div className="flex items-center justify-between gap-3 mb-2">
        <span className="font-mono text-[10px] tracking-[0.15em] uppercase text-op-muted">
          {t("gpConsolidatedTitle", { currency: c.currency })}
        </span>
        <span className="text-[11px] text-op-muted">
          {t("gpSitesCount", { count: c.sites })}
        </span>
      </div>
      <div className="flex items-end justify-between gap-3 flex-wrap">
        <div>
          <div className="text-[11px] text-op-muted">{t("gpSales")}</div>
          <div className="font-display text-2xl tabular-nums">
            {money(c.salesCents)}
          </div>
        </div>
        <div className="text-right">
          <div className="text-[11px] text-op-muted">
            {t("gpOperatingProfit")}
          </div>
          <div
            className={
              "font-display text-2xl tabular-nums " +
              profitCls(c.operatingProfitCents)
            }
          >
            {money(c.operatingProfitCents)}
          </div>
          <div className="text-[11px] text-op-muted tabular-nums">
            {fmtPct(pctOf(c.operatingProfitCents, c.salesCents), locale)}
          </div>
        </div>
      </div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mt-3 pt-3 border-t border-op-border">
        <ConsolidatedStat
          label={t("gpConsumption")}
          value={money(c.consumptionCents)}
        />
        <ConsolidatedStat label={t("gpWaste")} value={money(c.wasteCents)} />
        <ConsolidatedStat
          label={t("gpExpenses")}
          value={money(c.expensesCents)}
        />
        <ConsolidatedStat
          label={t("gpGrossProfit")}
          value={money(c.grossProfitCents)}
        />
      </div>
    </div>
  );
}

function ConsolidatedStat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[11px] text-op-muted">{label}</div>
      <div className="text-sm font-medium tabular-nums">{value}</div>
    </div>
  );
}

/** Fila de una sede: utilidad + % y sus líneas; apagada → sin números. */
function SiteRow({ site, locale }: { site: Site; locale: Locale }) {
  const t = useTranslations("opGroup");

  if (!site.pnl) {
    return (
      <div className="px-4 py-2.5 border-b border-op-border last:border-b-0 opacity-60 flex items-center justify-between gap-3">
        <span className="text-sm font-medium truncate">{site.name}</span>
        <span className="px-2 h-5 inline-flex items-center rounded-full bg-paper text-op-muted text-[10px] font-medium shrink-0">
          {t("gpModuleOff")}
        </span>
      </div>
    );
  }

  const money = (cents: number) =>
    formatMoney(cents, { currency: site.currency, locale });

  return (
    <div className="px-4 py-2.5 border-b border-op-border last:border-b-0">
      <div className="flex items-center gap-3">
        <span className="flex-1 min-w-0 text-sm font-medium truncate">
          {site.name}
        </span>
        <div className="text-right shrink-0">
          <div
            className={
              "text-sm font-medium tabular-nums " +
              profitCls(site.pnl.operatingProfitCents)
            }
          >
            {money(site.pnl.operatingProfitCents)}
          </div>
          <div className="text-[11px] text-op-muted tabular-nums">
            {fmtPct(site.pnl.operatingMarginPct, locale)}
          </div>
        </div>
      </div>
      <div className="text-[11px] text-op-muted mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5">
        <span>
          {t("gpSales")}{" "}
          <span className="tabular-nums">{money(site.pnl.salesCents)}</span>
        </span>
        <span>
          {t("gpConsumption")}{" "}
          <span className="tabular-nums">
            {money(site.pnl.consumptionCents)}
          </span>
        </span>
        <span>
          {t("gpExpenses")}{" "}
          <span className="tabular-nums">{money(site.pnl.expensesCents)}</span>
        </span>
      </div>
    </div>
  );
}
