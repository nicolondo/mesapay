"use client";
import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";

export function DescriptionAi({
  name,
  categoryId,
  description,
  disabled,
  onApply,
}: {
  name: string;
  categoryId: string;
  description: string;
  disabled: boolean;
  onApply: (value: string) => void;
}) {
  const t = useTranslations("menuAi");
  const [busy, setBusy] = useState(false);
  const [proposal, setProposal] = useState<string | null>(null);
  const [error, setError] = useState("");
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  async function generate() {
    if (busy) return;
    setBusy(true);
    setError("");
    setProposal(null);
    controller.current = new AbortController();
    try {
      const res = await fetch("/api/operator/menu-items/describe", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: name.trim(), categoryId, description }),
        signal: controller.current.signal,
      });
      const data = await res.json();
      if (!res.ok) {
        setError(
          t(
            ["ai_not_configured", "ai_disabled", "rate_limited"].includes(
              data.error,
            )
              ? data.error
              : "ai_failed",
          ),
        );
        return;
      }
      setProposal(data.description);
    } catch (e) {
      if (!(e instanceof DOMException && e.name === "AbortError"))
        setError(t("ai_failed"));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={generate}
        disabled={disabled || busy || !name.trim()}
        className="mp-btn mp-btn--sm mp-btn--secondary"
      >
        {t(busy ? "generating" : "generate")}
      </button>
      <p className="text-xs text-op-muted">
        {t(name.trim() ? "contextHint" : "nameFirst")}
      </p>
      {busy && (
        <p role="status" className="text-xs text-op-muted">
          {t("generating")}
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
      {proposal !== null && (
        <div className="rounded-xl border border-op-border bg-op-bg p-3 space-y-2">
          <label className="flex flex-col gap-2 text-sm">
            <span>{t("proposal")}</span>
            <textarea
              aria-label={t("proposal")}
              value={proposal}
              onChange={(e) => setProposal(e.target.value)}
              maxLength={500}
              rows={3}
              className="w-full rounded-lg border border-op-border bg-op-surface p-2"
            />
          </label>
          <p className="text-xs text-op-muted">{t("reviewHint")}</p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={disabled || !proposal.trim()}
              className="mp-btn mp-btn--sm mp-btn--primary"
              onClick={() => {
                onApply(proposal.trim());
                setProposal(null);
              }}
            >
              {t("apply")}
            </button>
            <button
              type="button"
              className="mp-btn mp-btn--sm mp-btn--secondary"
              onClick={() => setProposal(null)}
            >
              {t("discard")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
