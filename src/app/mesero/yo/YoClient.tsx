"use client";

import { useEffect, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import type { Locale } from "@/i18n/config";
import { fmtCOP, formatDate } from "@/lib/format";
import type { TipPolicy, ShiftPolicy } from "@/lib/staffPolicies";

type Stats = {
  sinceIso: string;
  tipsCents: number | null;
  tipsRawCents: number;
  salesCents: number;
  paymentCount: number;
  tableCount: number;
  shift: { id: string; openedAtIso: string } | null;
};

type CloseSummary = {
  shiftId: string;
  openedAtIso: string;
  closedAtIso: string;
  durationMs: number;
  tipsCents: number;
  salesCents: number;
  paymentCount: number;
  tableCount: number;
};

/**
 * Sección reactiva de /mesero/yo. Muestra stats (ventas / propinas /
 * mesas / pagos) en una card grande, y arriba el control de turno
 * cuando el restaurante usa shiftPolicy="by_waiter". Cuando es
 * "global" solo muestra las stats con el label "Hoy desde 00:00" y
 * sin botones — el turno lo abre/cierra el operador.
 */
export function YoClient({
  tipPolicy,
  shiftPolicy,
  initial,
}: {
  tipPolicy: TipPolicy;
  shiftPolicy: ShiftPolicy;
  initial: Stats;
}) {
  const t = useTranslations("meseroYo");
  const locale = useLocale() as Locale;
  const [stats, setStats] = useState<Stats>(initial);
  const [busy, setBusy] = useState(false);
  const [summary, setSummary] = useState<CloseSummary | null>(null);
  const [err, setErr] = useState<string | null>(null);

  // Refresh moderado: cada 30s. Si está caro lo subimos a 60s.
  useEffect(() => {
    const tick = async () => {
      try {
        const r = await fetch("/api/mesero/me/today");
        if (!r.ok) return;
        const j = (await r.json()) as Stats;
        setStats(j);
      } catch {}
    };
    const h = setInterval(tick, 30_000);
    return () => clearInterval(h);
  }, []);

  async function refreshStats() {
    try {
      const r = await fetch("/api/mesero/me/today");
      if (r.ok) {
        const j = (await r.json()) as Stats;
        setStats(j);
      }
    } catch {}
  }

  async function openShift() {
    setBusy(true);
    setErr(null);
    const r = await fetch("/api/mesero/shift/open", { method: "POST" });
    setBusy(false);
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      setErr(j.message ?? j.error ?? t("errOpenShift"));
      return;
    }
    await refreshStats();
  }

  async function closeShift() {
    if (!confirm(t("closeConfirm"))) {
      return;
    }
    setBusy(true);
    setErr(null);
    const r = await fetch("/api/mesero/shift/close", { method: "POST" });
    setBusy(false);
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      setErr(j.message ?? j.error ?? t("errCloseShift"));
      return;
    }
    const j = (await r.json()) as { summary: CloseSummary };
    setSummary(j.summary);
    await refreshStats();
  }

  const hasOpenShift = !!stats.shift;
  const sinceLabel = (() => {
    const d = new Date(stats.sinceIso);
    if (hasOpenShift) {
      return t("sinceTime", {
        time: formatDate(d, {
          locale,
          hour: "2-digit",
          minute: "2-digit",
        }),
      });
    }
    return t("sinceMidnight");
  })();

  return (
    <>
      {/* Card "Tu turno" / "Hoy" */}
      <section className="rounded-2xl border border-hairline bg-paper p-5 space-y-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="font-mono text-[10px] tracking-[0.15em] uppercase text-muted">
              {hasOpenShift ? t("shiftKicker") : t("todayKicker")}
            </div>
            <div className="font-display text-2xl mt-0.5">
              {hasOpenShift ? t("shiftOpen") : t("shiftNone")}
            </div>
            <div className="text-xs text-muted mt-1">{sinceLabel}</div>
          </div>

          {shiftPolicy === "by_waiter" && !hasOpenShift && (
            <button
              type="button"
              onClick={openShift}
              disabled={busy}
              className="h-10 px-4 rounded-full bg-ink text-bone text-sm font-medium disabled:opacity-50 shrink-0"
            >
              {t("openShift")}
            </button>
          )}
          {shiftPolicy === "by_waiter" && hasOpenShift && (
            <button
              type="button"
              onClick={closeShift}
              disabled={busy}
              className="h-10 px-4 rounded-full border border-hairline text-ink text-sm font-medium disabled:opacity-50 shrink-0"
            >
              {t("closeShift")}
            </button>
          )}
        </div>

        {shiftPolicy === "global" && (
          <p className="text-[11px] text-op-muted -mt-2">
            {t("globalShiftNote")}
          </p>
        )}

        {/* Grid de stats — 2x2 en mobile */}
        <div className="grid grid-cols-2 gap-3">
          <Stat label={t("statSales")} value={fmtCOP(stats.salesCents)} />
          <Stat
            label={t("statTips")}
            value={
              stats.tipsCents != null
                ? fmtCOP(stats.tipsCents)
                : t("tipsShared")
            }
            hint={
              stats.tipsCents == null ? t("tipsSharedHint") : undefined
            }
          />
          <Stat label={t("statTables")} value={String(stats.tableCount)} />
          <Stat label={t("statPayments")} value={String(stats.paymentCount)} />
        </div>

        {err && <div className="text-xs text-danger">{err}</div>}
      </section>

      {/* Resumen al cerrar turno */}
      {summary && (
        <CloseSummarySheet
          summary={summary}
          tipPolicy={tipPolicy}
          onClose={() => setSummary(null)}
        />
      )}
    </>
  );
}

function Stat({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <div className="rounded-xl border border-hairline bg-ivory px-3 py-3">
      <div className="font-mono text-[10px] tracking-[0.15em] uppercase text-muted">
        {label}
      </div>
      <div className="font-display text-lg tabular mt-0.5 break-words">
        {value}
      </div>
      {hint && (
        <div className="text-[10px] text-op-muted mt-1 leading-tight">
          {hint}
        </div>
      )}
    </div>
  );
}

function CloseSummarySheet({
  summary,
  tipPolicy,
  onClose,
}: {
  summary: CloseSummary;
  tipPolicy: TipPolicy;
  onClose: () => void;
}) {
  const t = useTranslations("meseroYo");
  const durationMinutes = Math.floor(summary.durationMs / 60_000);
  const hours = Math.floor(durationMinutes / 60);
  const mins = durationMinutes % 60;
  const durStr =
    hours > 0 ? t("durationHM", { hours, mins }) : t("durationM", { mins });

  return (
    <div
      className="fixed inset-0 z-50 bg-ink/40 flex items-end md:items-center justify-center p-0 md:p-6"
      onClick={onClose}
    >
      <div
        className="w-full md:max-w-md bg-paper rounded-t-3xl md:rounded-3xl border border-hairline p-5 space-y-4 max-h-[90dvh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="font-mono text-[10px] tracking-[0.15em] uppercase text-muted">
              {t("summaryKicker")}
            </div>
            <h2 className="font-display text-2xl mt-1">{t("summaryTitle")}</h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-muted text-sm shrink-0"
            aria-label={t("closeAria")}
          >
            {"✕"}
          </button>
        </div>

        <div className="space-y-1.5">
          <Row label={t("rowDuration")} value={durStr} />
          <Row label={t("rowTables")} value={String(summary.tableCount)} />
          <Row label={t("rowPayments")} value={String(summary.paymentCount)} />
          <Row label={t("rowSales")} value={fmtCOP(summary.salesCents)} />
          <Row
            label={t("rowTips")}
            value={
              tipPolicy === "by_waiter"
                ? fmtCOP(summary.tipsCents)
                : t("tipsSharedLong")
            }
            accent={tipPolicy === "by_waiter"}
          />
        </div>

        <button
          type="button"
          onClick={onClose}
          className="w-full h-12 rounded-2xl bg-ink text-bone text-base font-medium"
        >
          {t("done")}
        </button>
      </div>
    </div>
  );
}

function Row({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-sm text-op-muted">{label}</span>
      <span
        className={
          "font-mono tabular " +
          (accent ? "font-display text-lg" : "text-sm")
        }
      >
        {value}
      </span>
    </div>
  );
}
