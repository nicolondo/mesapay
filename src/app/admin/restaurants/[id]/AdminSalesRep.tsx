"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";

type Rep = {
  id: string;
  name: string | null;
  email: string;
  commissionBps: number | null;
};

export function AdminSalesRep({
  restaurantId,
  comerciales,
  initialSalesRepUserId,
  initialSalesRepCommissionBps,
  platformDefaultBps,
  repDefaultBps,
}: {
  restaurantId: string;
  comerciales: Rep[];
  initialSalesRepUserId: string | null;
  initialSalesRepCommissionBps: number | null;
  /** Global platform default (e.g. 1000 = 10%) */
  platformDefaultBps: number;
  /** The selected rep's own default bps, if any — used as placeholder */
  repDefaultBps: number | null;
}) {
  const t = useTranslations("opAdminCommissions");
  const router = useRouter();
  const [, startTx] = useTransition();

  const [selectedRepId, setSelectedRepId] = useState<string>(
    initialSalesRepUserId ?? "",
  );
  const [bpsRaw, setBpsRaw] = useState(
    initialSalesRepCommissionBps != null
      ? String(initialSalesRepCommissionBps / 100)
      : "",
  );
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "error"; text: string } | null>(
    null,
  );

  // Effective default bps for the currently selected rep.
  const selectedRep = comerciales.find((r) => r.id === selectedRepId) ?? null;
  const effectiveRepDefaultBps = selectedRep?.commissionBps ?? null;
  const placeholderBps = effectiveRepDefaultBps ?? repDefaultBps ?? platformDefaultBps;
  const placeholderPct = (placeholderBps / 100).toFixed(2);

  async function save() {
    setBusy(true);
    setMsg(null);

    const salesRepUserId = selectedRepId === "" ? null : selectedRepId;

    let salesRepCommissionBps: number | null = null;
    if (bpsRaw.trim() !== "") {
      const pct = parseFloat(bpsRaw);
      if (!isNaN(pct) && pct >= 0 && pct <= 50) {
        salesRepCommissionBps = Math.round(pct * 100);
      } else {
        setMsg({ kind: "error", text: t("saveFailed") });
        setBusy(false);
        return;
      }
    }

    const res = await fetch(
      `/api/admin/restaurants/${restaurantId}/salesrep`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ salesRepUserId, salesRepCommissionBps }),
      },
    );
    setBusy(false);
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      setMsg({ kind: "error", text: j.error ?? t("saveFailed") });
      return;
    }
    setMsg({ kind: "ok", text: t("saved") });
    startTx(() => router.refresh());
  }

  return (
    <div className="rounded-2xl border border-op-border bg-op-surface p-5 mb-4">
      <div className="font-display text-lg mb-4">{t("cardTitle")}</div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <label className="block">
          <span className="font-mono text-[10px] tracking-wider uppercase text-op-muted">
            {t("repLabel")}
          </span>
          <select
            value={selectedRepId}
            onChange={(e) => {
              setSelectedRepId(e.target.value);
              // Clear override when rep changes so user decides fresh.
              setBpsRaw("");
            }}
            className="mt-1 w-full h-10 px-3 rounded-lg border border-op-border bg-op-bg text-sm focus:outline-none focus:border-terracotta"
          >
            <option value="">{t("repPlaceholder")}</option>
            {comerciales.map((rep) => (
              <option key={rep.id} value={rep.id}>
                {rep.name ? `${rep.name} (${rep.email})` : rep.email}
              </option>
            ))}
          </select>
        </label>

        <label className="block">
          <span className="font-mono text-[10px] tracking-wider uppercase text-op-muted">
            {t("bpsLabel")}
          </span>
          <input
            type="number"
            min={0}
            max={50}
            step={0.01}
            value={bpsRaw}
            onChange={(e) => setBpsRaw(e.target.value)}
            placeholder={placeholderPct}
            disabled={selectedRepId === ""}
            className="mt-1 w-full h-10 px-3 rounded-lg border border-op-border bg-op-bg text-sm focus:outline-none focus:border-terracotta font-mono tabular disabled:opacity-40"
          />
        </label>
      </div>

      <div className="mt-4 flex items-center gap-3">
        <button
          type="button"
          onClick={save}
          disabled={busy}
          className="mp-btn mp-btn--primary mp-btn--sm px-5"
        >
          {busy ? t("saving") : t("save")}
        </button>
        {msg && (
          <span
            className={
              "text-sm " + (msg.kind === "ok" ? "text-ok" : "text-danger")
            }
          >
            {msg.text}
          </span>
        )}
      </div>
    </div>
  );
}
