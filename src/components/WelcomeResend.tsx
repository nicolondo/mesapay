"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";

export function WelcomeResend({
  defaultEmail = "",
}: {
  defaultEmail?: string;
}) {
  const t = useTranslations("restaurantWelcome");
  const [email, setEmail] = useState(defaultEmail);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  return (
    <form
      className="space-y-3"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setNotice(null);
        try {
          const r = await fetch("/api/auth/resend-restaurant-welcome", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ email }),
          });
          setNotice(t(r.ok ? "resendNotice" : "resendFailed"));
        } catch {
          setNotice(t("resendFailed"));
        } finally {
          setBusy(false);
        }
      }}
    >
      <label className="block text-sm">
        {t("emailLabel")}
        <input
          type="email"
          required
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="mt-1 w-full h-11 px-3 rounded-xl border border-op-border bg-op-bg"
        />
      </label>
      <button
        disabled={busy}
        className="min-h-11 px-4 rounded-xl border border-op-border text-sm disabled:opacity-50"
      >
        {t(busy ? "resending" : "resend")}
      </button>
      {notice && (
        <p role="status" className="text-sm text-op-muted">
          {notice}
        </p>
      )}
    </form>
  );
}
