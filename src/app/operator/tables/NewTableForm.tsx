"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";

type Mode = "single" | "bulk";

export function NewTableForm({ suggestedNumber }: { suggestedNumber: number }) {
  const t = useTranslations("opTables");
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<Mode>("single");
  const [number, setNumber] = useState<string>(String(suggestedNumber));
  const [label, setLabel] = useState("");
  // Bulk: rango desde/hasta. Default arranca en el siguiente número.
  const [from, setFrom] = useState<string>(String(suggestedNumber));
  const [to, setTo] = useState<string>(String(suggestedNumber + 9));
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [, startTx] = useTransition();

  function reset() {
    setOpen(false);
    setErr(null);
    setMsg(null);
  }

  async function submitSingle(e: React.FormEvent) {
    e.preventDefault();
    const n = Number(number);
    if (!Number.isInteger(n) || n < 1) {
      setErr(t("newTableInvalidNumber"));
      return;
    }
    setErr(null);
    setBusy(true);
    const res = await fetch("/api/operator/tables", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ number: n, label: label.trim() || undefined }),
    });
    setBusy(false);
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      setErr(j.error ?? t("newTableCreateFailed"));
      return;
    }
    setNumber(String(n + 1));
    setLabel("");
    setOpen(false);
    startTx(() => router.refresh());
  }

  async function submitBulk(e: React.FormEvent) {
    e.preventDefault();
    const f = Number(from);
    const tt = Number(to);
    if (!Number.isInteger(f) || !Number.isInteger(tt) || f < 1 || tt < f) {
      setErr(t("bulkInvalidRange"));
      return;
    }
    if (tt - f + 1 > 200) {
      setErr(t("bulkTooMany"));
      return;
    }
    setErr(null);
    setMsg(null);
    setBusy(true);
    const res = await fetch("/api/operator/tables/bulk", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ from: f, to: tt }),
    });
    setBusy(false);
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      const code = j.error;
      setErr(
        code === "tooMany"
          ? t("bulkTooMany")
          : code === "range"
            ? t("bulkInvalidRange")
            : t("newTableCreateFailed"),
      );
      return;
    }
    const j = (await res.json().catch(() => ({}))) as {
      created?: number;
      skipped?: number;
    };
    setMsg(t("bulkResult", { created: j.created ?? 0, skipped: j.skipped ?? 0 }));
    setFrom(String(tt + 1));
    setTo(String(tt + 10));
    startTx(() => router.refresh());
  }

  if (!open) {
    return (
      <button
        onClick={() => {
          setOpen(true);
          setMode("single");
        }}
        className="mp-btn mp-btn--primary mp-btn--sm"
      >
        {t("newTableAdd")}
      </button>
    );
  }

  return (
    <form
      onSubmit={mode === "single" ? submitSingle : submitBulk}
      className="bg-op-surface border border-op-border rounded-xl px-4 py-3 space-y-3"
    >
      {/* Toggle Una / Varias */}
      <div className="mp-seg" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={mode === "single"}
          onClick={() => {
            setMode("single");
            setErr(null);
            setMsg(null);
          }}
          className="mp-seg__i"
        >
          {t("bulkToggleSingle")}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={mode === "bulk"}
          onClick={() => {
            setMode("bulk");
            setErr(null);
            setMsg(null);
          }}
          className="mp-seg__i"
        >
          {t("bulkToggleMany")}
        </button>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        {mode === "single" ? (
          <>
            <label className="flex flex-col">
              <span className="font-mono text-[10px] tracking-[0.14em] uppercase text-op-muted mb-1">
                {t("newTableNumber")}
              </span>
              <input
                type="number"
                min={1}
                max={999}
                value={number}
                onChange={(e) => setNumber(e.target.value)}
                className="w-20 h-10 px-3 rounded-lg border border-op-border bg-op-bg text-sm"
                autoFocus
              />
            </label>
            <label className="flex flex-col flex-1 min-w-[160px]">
              <span className="font-mono text-[10px] tracking-[0.14em] uppercase text-op-muted mb-1">
                {t("newTableLabel")}
              </span>
              <input
                type="text"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder={t("newTableLabelPlaceholder")}
                maxLength={40}
                className="h-10 px-3 rounded-lg border border-op-border bg-op-bg text-sm"
              />
            </label>
          </>
        ) : (
          <>
            <label className="flex flex-col">
              <span className="font-mono text-[10px] tracking-[0.14em] uppercase text-op-muted mb-1">
                {t("bulkFrom")}
              </span>
              <input
                type="number"
                min={1}
                max={999}
                value={from}
                onChange={(e) => setFrom(e.target.value)}
                className="w-20 h-10 px-3 rounded-lg border border-op-border bg-op-bg text-sm"
                autoFocus
              />
            </label>
            <label className="flex flex-col">
              <span className="font-mono text-[10px] tracking-[0.14em] uppercase text-op-muted mb-1">
                {t("bulkTo")}
              </span>
              <input
                type="number"
                min={1}
                max={999}
                value={to}
                onChange={(e) => setTo(e.target.value)}
                className="w-20 h-10 px-3 rounded-lg border border-op-border bg-op-bg text-sm"
              />
            </label>
            <p className="font-mono text-[10px] text-op-muted self-end mb-2">
              {t("bulkSkipNote")}
            </p>
          </>
        )}

        <div className="flex gap-2 ml-auto">
          <button
            type="button"
            onClick={reset}
            className="mp-btn mp-btn--secondary mp-btn--sm"
          >
            {t("newTableCancel")}
          </button>
          <button
            type="submit"
            disabled={busy}
            className="mp-btn mp-btn--primary mp-btn--sm"
          >
            {busy
              ? mode === "single"
                ? t("newTableCreating")
                : t("bulkCreating")
              : mode === "single"
                ? t("newTableCreate")
                : t("bulkCreate")}
          </button>
        </div>
      </div>

      {err && <div className="text-danger text-xs">{err}</div>}
      {msg && <div className="text-ok text-xs">{msg}</div>}
    </form>
  );
}
