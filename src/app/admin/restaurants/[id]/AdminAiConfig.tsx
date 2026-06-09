"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";

type AiEnabled = "inherit" | "on" | "off";

function boolToSelect(v: boolean | null): AiEnabled {
  if (v === true) return "on";
  if (v === false) return "off";
  return "inherit";
}

function selectToBool(v: AiEnabled): boolean | null {
  if (v === "on") return true;
  if (v === "off") return false;
  return null;
}

export function AdminAiConfig({
  restaurantId,
  initial,
}: {
  restaurantId: string;
  initial: {
    aiInsightsEnabled: boolean | null;
    aiDailyMessageLimit: number | null;
  };
}) {
  const t = useTranslations("opAdminAi");
  const router = useRouter();
  const [, startTx] = useTransition();

  const [aiEnabled, setAiEnabled] = useState<AiEnabled>(
    boolToSelect(initial.aiInsightsEnabled),
  );
  const [limitRaw, setLimitRaw] = useState(
    initial.aiDailyMessageLimit != null
      ? String(initial.aiDailyMessageLimit)
      : "",
  );
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "error"; text: string } | null>(
    null,
  );

  async function save() {
    setBusy(true);
    setMsg(null);

    const aiDailyMessageLimit =
      limitRaw.trim() === "" ? null : parseInt(limitRaw, 10);

    const res = await fetch(`/api/admin/restaurants/${restaurantId}/ai`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        aiInsightsEnabled: selectToBool(aiEnabled),
        aiDailyMessageLimit: isNaN(aiDailyMessageLimit as number)
          ? null
          : aiDailyMessageLimit,
      }),
    });
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
    <div className="rounded-2xl border border-op-border bg-op-surface p-5">
      <div className="font-display text-lg mb-4">{t("title")}</div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <label className="block">
          <span className="font-mono text-[10px] tracking-wider uppercase text-op-muted">
            {t("title")}
          </span>
          <select
            value={aiEnabled}
            onChange={(e) => setAiEnabled(e.target.value as AiEnabled)}
            className="mt-1 w-full h-10 px-3 rounded-lg border border-op-border bg-op-bg text-sm focus:outline-none focus:border-terracotta"
          >
            <option value="inherit">{t("optInherit")}</option>
            <option value="on">{t("optOn")}</option>
            <option value="off">{t("optOff")}</option>
          </select>
        </label>

        <label className="block">
          <span className="font-mono text-[10px] tracking-wider uppercase text-op-muted">
            {t("limitLabel")}
          </span>
          <input
            type="number"
            min={1}
            max={1000}
            value={limitRaw}
            onChange={(e) => setLimitRaw(e.target.value)}
            placeholder={t("limitPlaceholder")}
            className="mt-1 w-full h-10 px-3 rounded-lg border border-op-border bg-op-bg text-sm focus:outline-none focus:border-terracotta font-mono tabular"
          />
        </label>
      </div>

      <div className="mt-4 flex items-center gap-3">
        <button
          type="button"
          onClick={save}
          disabled={busy}
          className="h-10 px-5 rounded-full bg-ink text-bone text-sm font-medium disabled:opacity-50"
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
