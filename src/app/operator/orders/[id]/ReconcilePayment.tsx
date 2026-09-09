"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useApiError } from "@/lib/useApiError";

export function ReconcilePayment({
  paymentId,
  refund,
  pending,
}: {
  paymentId: string;
  refund: boolean;
  pending: boolean;
}) {
  const t = useTranslations("paymentReconciliation");
  const apiError = useApiError();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const options = refund
    ? ["refunded", "not_refunded"]
    : pending
      ? ["approved", "declined"]
      : ["reviewed"];
  const [outcome, setOutcome] = useState(options[0]);
  const [providerRef, setProviderRef] = useState("");
  const [evidence, setEvidence] = useState("");
  const [verified, setVerified] = useState(false);
  const [busy, setBusy] = useState(false);
  const [completed, setCompleted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (busy || !verified) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/operator/payments/${paymentId}/reconcile`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          outcome,
          providerRef,
          evidence,
          verifiedWithProvider: verified,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(apiError(data));
        return;
      }
      setCompleted(true);
      setOpen(false);
      router.refresh();
    } catch {
      setError(t("error"));
    } finally {
      setBusy(false);
    }
  }
  if (completed)
    return (
      <p role="status" className="mt-2 text-sm text-ok">
        {t("saved")}
      </p>
    );
  return (
    <div className="text-sm">
      <button
        type="button"
        aria-expanded={open}
        className="mp-btn mp-btn--ghost mp-btn--sm"
        onClick={() => setOpen(!open)}
      >
        {t("title")}
      </button>
      {open && (
        <form onSubmit={submit} className="mt-3 grid gap-3 max-w-sm">
          <p className="text-op-muted">{t("body")}</p>
          <label>
            {t("outcome")}
            <select
              className="mp-input w-full"
              value={outcome}
              onChange={(e) => setOutcome(e.target.value)}
            >
              {options.map((o) => (
                <option key={o} value={o}>
                  {t(o)}
                </option>
              ))}
            </select>
          </label>
          <label>
            {t("reference")}
            <input
              className="mp-input w-full"
              required
              minLength={3}
              maxLength={200}
              value={providerRef}
              onChange={(e) => setProviderRef(e.target.value)}
            />
          </label>
          <label>
            {t("evidence")}
            <textarea
              className="mp-input w-full"
              required
              minLength={15}
              maxLength={1000}
              value={evidence}
              onChange={(e) => setEvidence(e.target.value)}
            />
          </label>
          <label className="flex gap-2">
            <input
              type="checkbox"
              checked={verified}
              onChange={(e) => setVerified(e.target.checked)}
            />
            {t("verified")}
          </label>
          {error && (
            <p role="alert" className="text-danger">
              {error}
            </p>
          )}
          <button
            className="mp-btn mp-btn--primary"
            disabled={busy || !verified}
          >
            {busy ? t("saving") : t("save")}
          </button>
        </form>
      )}
    </div>
  );
}
