"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { useFormatter } from "next-intl";

type Account = {
  fromName: string;
  email: string;
  smtpHost: string;
  smtpPort: number;
  smtpUser: string;
  verifiedAt: string | null;
  hasPassword: boolean;
} | null;

export function EmailAccountClient({ initial }: { initial: Account }) {
  const t = useTranslations("crm");
  const fmt = useFormatter();

  const [fromName, setFromName] = useState(initial?.fromName ?? "");
  const [email, setEmail] = useState(initial?.email ?? "");
  const [smtpHost, setSmtpHost] = useState(initial?.smtpHost ?? "");
  const [smtpPort, setSmtpPort] = useState(String(initial?.smtpPort ?? "587"));
  const [smtpUser, setSmtpUser] = useState(initial?.smtpUser ?? "");
  const [smtpPass, setSmtpPass] = useState("");

  const [verifiedAt, setVerifiedAt] = useState<string | null>(
    initial?.verifiedAt ?? null,
  );
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveOk, setSaveOk] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);
  const [testOk, setTestOk] = useState(false);
  const [showHelp, setShowHelp] = useState(false);

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setSaveError(null);
    setSaveOk(false);

    try {
      const res = await fetch("/api/crm/email-account", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          fromName: fromName.trim(),
          email: email.trim(),
          smtpHost: smtpHost.trim(),
          smtpPort: parseInt(smtpPort, 10),
          smtpUser: smtpUser.trim(),
          ...(smtpPass ? { smtpPass } : {}),
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        setSaveError(t("emailSaveError"));
        return;
      }
      setVerifiedAt(json.account?.verifiedAt ?? null);
      setSaveOk(true);
    } catch {
      setSaveError(t("emailSaveError"));
    } finally {
      setSaving(false);
    }
  }

  async function handleTest() {
    setTesting(true);
    setTestResult(null);
    setTestOk(false);

    try {
      const res = await fetch("/api/crm/email-account/test", {
        method: "POST",
      });
      const json = await res.json();
      if (res.ok) {
        setTestOk(true);
        setTestResult(t("emailTestSuccess"));
        setVerifiedAt(new Date().toISOString());
      } else {
        setTestOk(false);
        setTestResult(t("emailTestError", { detail: json.detail ?? json.error ?? "error" }));
      }
    } catch {
      setTestOk(false);
      setTestResult(t("emailTestError", { detail: "network error" }));
    } finally {
      setTesting(false);
    }
  }

  return (
    <div className="flex-1 p-4 max-w-lg mx-auto w-full space-y-6">
      <div className="font-display text-2xl tracking-[-0.015em]">
        {t("emailPageTitle")}
      </div>

      {/* Verified status */}
      <div className={"flex items-center gap-2 px-4 py-3 rounded-xl border text-sm " + (verifiedAt ? "border-green-300 bg-green-50 text-green-800" : "border-amber-300 bg-amber-50 text-amber-800")}>
        <svg viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4 shrink-0">
          {verifiedAt ? (
            <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
          ) : (
            <path fillRule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
          )}
        </svg>
        <span>
          {verifiedAt
            ? t("emailVerifiedAt", {
                date: fmt.dateTime(new Date(verifiedAt), {
                  dateStyle: "medium",
                }),
              })
            : t("emailNotVerified")}
        </span>
      </div>

      {/* Form */}
      <form onSubmit={handleSave} className="space-y-4">
        {[
          { key: "fromName", label: t("emailFromName"), value: fromName, set: setFromName, type: "text" as const },
          { key: "email", label: t("emailFromAddress"), value: email, set: setEmail, type: "email" as const },
          { key: "smtpHost", label: t("emailSmtpHost"), value: smtpHost, set: setSmtpHost, type: "text" as const },
          { key: "smtpPort", label: t("emailSmtpPort"), value: smtpPort, set: setSmtpPort, type: "text" as const },
          { key: "smtpUser", label: t("emailSmtpUser"), value: smtpUser, set: setSmtpUser, type: "text" as const },
        ].map(({ key, label, value, set, type }) => (
          <div key={key}>
            <label className="block font-mono text-[10px] tracking-wider uppercase text-op-muted mb-1">
              {label}
            </label>
            <input
              type={type}
              value={value}
              onChange={(e) => set(e.target.value)}
              required={key !== "smtpPass"}
              className="w-full px-3 py-2.5 rounded-xl border border-op-border bg-op-bg text-sm focus:outline-none focus:ring-1 focus:ring-terracotta min-h-[44px]"
            />
          </div>
        ))}
        <div>
          <label className="block font-mono text-[10px] tracking-wider uppercase text-op-muted mb-1">
            {t("emailSmtpPass")}
          </label>
          <input
            type="password"
            value={smtpPass}
            onChange={(e) => setSmtpPass(e.target.value)}
            placeholder={initial?.hasPassword ? t("emailSmtpPassPlaceholder") : undefined}
            className="w-full px-3 py-2.5 rounded-xl border border-op-border bg-op-bg text-sm focus:outline-none focus:ring-1 focus:ring-terracotta min-h-[44px]"
          />
        </div>

        {saveError && <p className="text-sm text-terracotta">{saveError}</p>}
        {saveOk && !saveError && (
          <p className="text-sm text-green-600">{t("emailVerified")}</p>
        )}

        <button
          type="submit"
          disabled={saving}
          className="w-full py-3.5 rounded-xl bg-terracotta text-white font-medium disabled:opacity-50 min-h-[44px]"
        >
          {saving ? t("emailSaving") : t("emailSaveBtn")}
        </button>
      </form>

      {/* Test button */}
      <button
        type="button"
        onClick={handleTest}
        disabled={testing}
        className="w-full py-3 rounded-xl border border-terracotta text-terracotta text-sm font-medium disabled:opacity-50 min-h-[44px] hover:bg-terracotta/5 transition-colors"
      >
        {testing ? t("emailTesting") : t("emailTestBtn")}
      </button>

      {testResult && (
        <p className={"text-sm " + (testOk ? "text-green-600" : "text-terracotta")}>
          {testResult}
        </p>
      )}

      {/* Gmail help collapsible */}
      <div className="rounded-xl border border-op-border overflow-hidden">
        <button
          type="button"
          onClick={() => setShowHelp(!showHelp)}
          className="w-full flex items-center justify-between px-4 py-3 text-sm font-medium text-left min-h-[44px] hover:bg-op-bg transition-colors"
        >
          <span>{t("emailHelpTitle")}</span>
          <svg viewBox="0 0 20 20" fill="currentColor" className={"w-4 h-4 text-op-muted transition-transform " + (showHelp ? "rotate-180" : "")}>
            <path fillRule="evenodd" d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z" clipRule="evenodd" />
          </svg>
        </button>
        {showHelp && (
          <div className="px-4 pb-4 space-y-2 text-sm text-op-muted border-t border-op-border pt-3">
            <p>{"1. " + t("emailHelpStep1")}</p>
            <p>{"2. " + t("emailHelpStep2")}</p>
            <p>{"3. " + t("emailHelpStep3")}</p>
          </div>
        )}
      </div>
    </div>
  );
}
