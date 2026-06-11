"use client";

import { useEffect, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { fmtCOP, fmtMiles } from "@/lib/format";

const METHOD_KEY: Record<string, string> = {
  demo_cash: "methodDemoCash",
  demo_card: "methodDemoCard",
  wompi_card: "methodWompiCard",
  wompi_pse: "methodWompiPse",
  wompi_nequi: "methodWompiNequi",
  kushki_apple_pay: "methodKushkiApplePay",
  kushki_card_terminal: "methodKushkiCardTerminal",
};

type Metrics = {
  payments: number;
  ordersClosed: number;
  grossCents: number;
  tipCents: number;
  cashCents: number;
  byMethod: { method: string; count: number; sumCents: number }[];
};

type OpenOrder = {
  id: string;
  shortCode: string;
  status: string;
  subtotalCents: number;
  totalCents: number;
  tableLabel: string;
};

export type ShiftPanelProps = {
  initial:
    | { open: false }
    | {
        open: true;
        shift: { id: string; openedAt: string; openingCashCents: number };
        metrics: Metrics;
        openOrders: OpenOrder[];
        expectedCashCents: number;
      };
};

export function ShiftPanel({ initial }: ShiftPanelProps) {
  const router = useRouter();
  const [state, setState] = useState(initial);
  const [openSheet, setOpenSheet] = useState<"open" | "close" | null>(null);

  // Light polling so the live numbers stay fresh while the operator looks
  // at the page. Every 30s is plenty for a Z-report panel.
  useEffect(() => {
    if (!state.open) return;
    const id = setInterval(async () => {
      try {
        const r = await fetch("/api/operator/shifts/current", { cache: "no-store" });
        if (!r.ok) return;
        const data = await r.json();
        setState(data.open ? data : { open: false });
      } catch {
        // network blip — ignore, next tick retries
      }
    }, 30_000);
    return () => clearInterval(id);
  }, [state.open]);

  const refresh = async () => {
    const r = await fetch("/api/operator/shifts/current", { cache: "no-store" });
    if (r.ok) {
      const data = await r.json();
      setState(data.open ? data : { open: false });
    }
    router.refresh();
  };

  if (!state.open) {
    return (
      <>
        <ClosedBanner onAbrir={() => setOpenSheet("open")} />
        {openSheet === "open" && (
          <OpenShiftSheet onClose={() => setOpenSheet(null)} onDone={refresh} />
        )}
      </>
    );
  }

  return (
    <>
      <OpenPanel
        state={state}
        onCerrar={() => setOpenSheet("close")}
      />
      {openSheet === "close" && (
        <CloseShiftSheet
          state={state}
          onClose={() => setOpenSheet(null)}
          onDone={refresh}
        />
      )}
    </>
  );
}

// ────────────────────────────────────────────────────────────────────────
// Closed (no open shift) — invite the operator to abrir turno.

function ClosedBanner({ onAbrir }: { onAbrir: () => void }) {
  const t = useTranslations("opReports");
  return (
    <div className="bg-op-surface border border-op-border rounded-2xl p-5 mb-4 flex flex-wrap items-center gap-4 justify-between">
      <div>
        <div className="font-display text-xl">{t("noShiftTitle")}</div>
        <p className="text-sm text-op-muted mt-1 max-w-md">
          {t("noShiftBody")}
        </p>
      </div>
      <button
        type="button"
        onClick={onAbrir}
        className="h-10 px-5 rounded-full bg-ink text-bone text-sm font-medium"
      >
        {t("openShift")}
      </button>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────
// Open shift summary panel.

function OpenPanel({
  state,
  onCerrar,
}: {
  state: Extract<ShiftPanelProps["initial"], { open: true }>;
  onCerrar: () => void;
}) {
  const t = useTranslations("opReports");
  const since = useMemo(
    () => relativeTime(state.shift.openedAt, t),
    [state.shift.openedAt, t],
  );
  const canClose = state.openOrders.length === 0;
  return (
    <div className="bg-op-surface border border-op-border rounded-2xl p-5 mb-4">
      <div className="flex flex-wrap items-start justify-between gap-4 mb-4">
        <div>
          <div className="font-mono text-[9px] tracking-[0.14em] uppercase text-op-muted">
            {t("shiftOpen")}
          </div>
          <div className="font-display text-2xl mt-1">{since}</div>
          <div className="text-[12px] text-op-muted mt-0.5">
            {t("openingFund", { amount: fmtCOP(state.shift.openingCashCents) })}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onCerrar}
            disabled={!canClose}
            className={
              "h-10 px-5 rounded-full text-sm font-medium " +
              (canClose
                ? "bg-ink text-bone"
                : "bg-op-surface border border-op-border text-op-muted cursor-not-allowed")
            }
            title={canClose ? "" : t("resolveOpenFirst")}
          >
            {t("closeShift")}
          </button>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Stat label={t("statCharged")} value={fmtCOP(state.metrics.grossCents)} hint={t("statChargedHint", { count: state.metrics.payments })} />
        <Stat label={t("statTipsLower")} value={fmtCOP(state.metrics.tipCents)} />
        <Stat label={t("statCashExpected")} value={fmtCOP(state.expectedCashCents)} hint={t("statCashExpectedHint")} />
        <Stat label={t("statClosedBills")} value={String(state.metrics.ordersClosed)} />
      </div>

      {state.metrics.byMethod.length > 0 && (
        <div className="mt-4 grid grid-cols-2 md:grid-cols-3 gap-2 text-sm">
          {state.metrics.byMethod.map((b) => (
            <div
              key={b.method}
              className="border border-op-border rounded-xl px-3 py-2 flex items-center justify-between"
            >
              <span>
                {METHOD_KEY[b.method] ? t(METHOD_KEY[b.method]) : b.method}
                <span className="text-op-muted text-[11px]"> · {b.count}</span>
              </span>
              <span className="font-mono tabular">{fmtCOP(b.sumCents)}</span>
            </div>
          ))}
        </div>
      )}

      {state.openOrders.length > 0 && (
        <div className="mt-5 border border-op-border rounded-xl p-4 bg-op-surface">
          <div className="font-display text-base mb-1">
            {t("openBillsCount", { count: state.openOrders.length })}
          </div>
          <p className="text-[12px] text-op-muted mb-3">
            {t("resolveOpenBills")}
          </p>
          <ul className="divide-y divide-op-border">
            {state.openOrders.map((o) => (
              <li
                key={o.id}
                className="py-2 flex items-center justify-between gap-3"
              >
                <div className="min-w-0">
                  <div className="text-sm font-medium truncate">{o.tableLabel}</div>
                  <div className="text-[11px] text-op-muted font-mono">
                    {o.shortCode} · {o.status}
                  </div>
                </div>
                <div className="flex items-center gap-3 shrink-0">
                  <div className="font-mono tabular text-sm">{fmtCOP(o.totalCents)}</div>
                  <Link
                    href={`/operator/orders/${o.id}`}
                    className="text-[12px] text-terracotta hover:underline"
                  >
                    {t("goCollect")}
                  </Link>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="border border-op-border rounded-xl p-3">
      <div className="font-mono text-[9px] tracking-[0.14em] uppercase text-op-muted">
        {label}
      </div>
      <div className="font-display text-xl mt-0.5 tabular">{value}</div>
      {hint && <div className="text-[10px] text-op-muted mt-0.5">{hint}</div>}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────
// Sheets.

function OpenShiftSheet({
  onClose,
  onDone,
}: {
  onClose: () => void;
  onDone: () => void | Promise<void>;
}) {
  const t = useTranslations("opReports");
  const [amount, setAmount] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const r = await fetch("/api/operator/shifts/open", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ openingCashCents: amount }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.error ?? t("errCannotOpen"));
      }
      await onDone();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : t("errGeneric"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Backdrop onClose={onClose}>
      <SheetTitle title={t("openShift")} subtitle={t("openShiftSheetSubtitle")} />
      <label className="block">
        <span className="font-mono text-[10px] tracking-[0.14em] uppercase text-op-muted">
          {t("initialCashLabel")}
        </span>
        <CashInput value={amount} onChange={setAmount} autoFocus />
        <span className="block text-[11px] text-op-muted mt-1">
          {t("initialCashHint")}
        </span>
      </label>
      {error && (
        <div className="mt-3 text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
          {error}
        </div>
      )}
      <SheetActions
        onCancel={onClose}
        onConfirm={submit}
        busy={busy}
        confirmLabel={t("openShift")}
      />
    </Backdrop>
  );
}

function CloseShiftSheet({
  state,
  onClose,
  onDone,
}: {
  state: Extract<ShiftPanelProps["initial"], { open: true }>;
  onClose: () => void;
  onDone: () => void | Promise<void>;
}) {
  const t = useTranslations("opReports");
  const [declared, setDeclared] = useState(state.expectedCashCents);
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const diff = declared - state.expectedCashCents;

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const r = await fetch("/api/operator/shifts/close", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          declaredCashCents: declared,
          notes: notes.trim() || undefined,
        }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        throw new Error(j.error ?? t("errCannotClose"));
      }
      await onDone();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : t("errGeneric"));
    } finally {
      setBusy(false);
    }
  }

  const diffValue =
    diff === 0
      ? t("differenceExact")
      : diff > 0
        ? t("differenceOver", { amount: fmtCOP(Math.abs(diff)) })
        : t("differenceShort", { amount: fmtCOP(Math.abs(diff)) });

  return (
    <Backdrop onClose={onClose}>
      <SheetTitle title={t("closeShift")} subtitle={t("closeShiftSheetSubtitle")} />

      <div className="grid grid-cols-2 gap-3 mb-4 text-sm">
        <div className="border border-op-border rounded-xl p-3">
          <div className="font-mono text-[9px] tracking-[0.14em] uppercase text-op-muted">
            {t("initialFund")}
          </div>
          <div className="font-display text-lg tabular">
            {fmtCOP(state.shift.openingCashCents)}
          </div>
        </div>
        <div className="border border-op-border rounded-xl p-3">
          <div className="font-mono text-[9px] tracking-[0.14em] uppercase text-op-muted">
            {t("cashCollected")}
          </div>
          <div className="font-display text-lg tabular">
            {fmtCOP(state.metrics.cashCents)}
          </div>
        </div>
        <div className="border border-op-border rounded-xl p-3 col-span-2 bg-op-surface">
          <div className="font-mono text-[9px] tracking-[0.14em] uppercase text-op-muted">
            {t("cashExpectedInDrawer")}
          </div>
          <div className="font-display text-2xl tabular">
            {fmtCOP(state.expectedCashCents)}
          </div>
        </div>
      </div>

      <label className="block mb-3">
        <span className="font-mono text-[10px] tracking-[0.14em] uppercase text-op-muted">
          {t("cashCountedPhysically")}
        </span>
        <CashInput value={declared} onChange={setDeclared} autoFocus />
      </label>

      <div
        className={
          "rounded-xl px-3 py-3 mb-3 text-sm font-medium " +
          (diff === 0
            ? "bg-emerald-50 border border-emerald-200 text-emerald-900"
            : diff > 0
              ? "bg-amber-50 border border-amber-200 text-amber-900"
              : "bg-red-50 border border-red-200 text-red-900")
        }
      >
        {t("differenceLabel", { value: diffValue })}
      </div>

      <label className="block mb-1">
        <span className="font-mono text-[10px] tracking-[0.14em] uppercase text-op-muted">
          {t("notesLabel")}
        </span>
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={2}
          maxLength={2000}
          placeholder={diff !== 0 ? t("notesPlaceholder") : ""}
          className="w-full mt-1 rounded-lg border border-op-border bg-op-surface px-3 py-2 text-sm"
        />
      </label>

      {error && (
        <div className="mt-3 text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
          {error}
        </div>
      )}
      <SheetActions
        onCancel={onClose}
        onConfirm={submit}
        busy={busy}
        confirmLabel={t("confirmClose")}
      />
    </Backdrop>
  );
}

function CashInput({
  value,
  onChange,
  autoFocus,
}: {
  value: number;
  onChange: (cents: number) => void;
  autoFocus?: boolean;
}) {
  // Plain integer pesos field. Cents are uncommon for cash drawer
  // arqueo in CO so we treat the input as whole pesos and multiply by
  // 100. We store the user's keystrokes as digits-only internally,
  // but render them with es-CO thousand separators ("397.337") so a
  // cajero counting $397.337 actually sees the number formatted the
  // way they wrote it on paper.
  const [digits, setDigits] = useState(
    value > 0 ? String(Math.round(value / 100)) : "",
  );
  const display = digits ? fmtMiles(Number(digits)) : "";
  return (
    <input
      type="text"
      inputMode="numeric"
      autoFocus={autoFocus}
      value={display}
      onChange={(e) => {
        // Strip the formatting (dots, commas, spaces) before
        // remembering the raw value.
        const clean = e.target.value.replace(/[^0-9]/g, "");
        setDigits(clean);
        onChange(clean ? Number(clean) * 100 : 0);
      }}
      placeholder="0"
      className="w-full mt-1 rounded-lg border border-op-border bg-op-surface px-3 py-2 text-2xl font-display tabular"
    />
  );
}

function Backdrop({
  children,
  onClose,
}: {
  children: React.ReactNode;
  onClose: () => void;
}) {
  return (
    <div
      className="fixed inset-0 bg-black/40 z-50 flex items-end md:items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-bone rounded-2xl w-full max-w-md p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}

function SheetTitle({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <div className="mb-4">
      <div className="font-display text-2xl">{title}</div>
      {subtitle && <div className="text-sm text-op-muted">{subtitle}</div>}
    </div>
  );
}

function SheetActions({
  onCancel,
  onConfirm,
  busy,
  confirmLabel,
}: {
  onCancel: () => void;
  onConfirm: () => void;
  busy: boolean;
  confirmLabel: string;
}) {
  const t = useTranslations("opReports");
  return (
    <div className="flex justify-end gap-2 mt-5">
      <button
        type="button"
        onClick={onCancel}
        disabled={busy}
        className="h-10 px-4 rounded-full text-sm text-op-text/80"
      >
        {t("cancel")}
      </button>
      <button
        type="button"
        onClick={onConfirm}
        disabled={busy}
        className="h-10 px-5 rounded-full bg-ink text-bone text-sm font-medium disabled:opacity-60"
      >
        {busy ? t("busy") : confirmLabel}
      </button>
    </div>
  );
}

function relativeTime(
  iso: string,
  t: ReturnType<typeof useTranslations<"opReports">>,
) {
  const opened = new Date(iso).getTime();
  const ms = Date.now() - opened;
  const mins = Math.max(1, Math.round(ms / 60_000));
  if (mins < 60) return t("relativeMin", { mins });
  const hours = Math.floor(mins / 60);
  const rem = mins % 60;
  return rem === 0
    ? t("relativeHour", { hours })
    : t("relativeHourMin", { hours, rem });
}
