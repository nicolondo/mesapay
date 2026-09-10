"use client";
import { useState } from "react";
import { useTranslations } from "next-intl";

export function MenuAiCard({
  initial,
}: {
  initial: { enabled: boolean; source: "admin" | "server" | "none" };
}) {
  const t = useTranslations("menuAi");
  const [status, setStatus] = useState(initial);
  const [enabled, setEnabled] = useState(initial.enabled);
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMessage("");
    try {
      const res = await fetch("/api/admin/menu-ai", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          enabled,
          ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setMessage(t(data.error === "invalid" ? "keyInvalid" : "saveFailed"));
        return;
      }
      setStatus(data);
      setApiKey("");
      setMessage(t("saved"));
    } catch {
      setMessage(t("saveFailed"));
    } finally {
      setBusy(false);
    }
  }
  return (
    <form
      onSubmit={save}
      className="rounded-xl border border-op-border bg-op-surface p-5 space-y-4"
    >
      <div>
        <h2 className="font-display text-2xl">{t("adminTitle")}</h2>
        <p className="text-sm text-op-muted mt-1">{t("adminIntro")}</p>
      </div>
      <p className="text-sm" role="status">
        {t(`source_${status.source}`)}
      </p>
      <label className="flex flex-col gap-1 text-sm">
        <span>{t("keyLabel")}</span>
        <input
          type="password"
          aria-label={t("keyLabel")}
          autoComplete="new-password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          maxLength={500}
          disabled={busy}
          className="h-11 w-full rounded-lg border border-op-border bg-op-bg px-3 text-sm"
          placeholder={t("keyPlaceholder")}
        />
        <span className="text-xs text-op-muted">{t("keyHint")}</span>
      </label>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
          disabled={busy}
        />
        {t("enabled")}
      </label>
      <p className="text-xs text-op-muted">{t("limits")}</p>
      <button type="submit" className="mp-btn mp-btn--primary" disabled={busy}>
        {t(busy ? "saving" : "save")}
      </button>
      {message && (
        <p role="status" className="text-sm">
          {message}
        </p>
      )}
    </form>
  );
}
