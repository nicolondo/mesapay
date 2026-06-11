"use client";

import { useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";

export function ResetPasswordClient({ token }: { token: string }) {
  const t = useTranslations("resetPwd");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (password !== confirm) {
      setError(t("mismatch"));
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/reset-password", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token, password }),
      });
      if (!res.ok) {
        setError(t("error"));
        return;
      }
      setDone(true);
    } catch {
      setError(t("error"));
    } finally {
      setSaving(false);
    }
  }

  if (done) {
    return (
      <div className="space-y-4">
        <h1 className="font-display text-2xl tracking-[-0.015em]">
          {t("successTitle")}
        </h1>
        <p className="text-sm text-op-muted">{t("successBody")}</p>
        <Link
          href="/signin"
          className="inline-flex items-center justify-center w-full py-3.5 rounded-xl bg-ink text-bone text-sm font-medium min-h-[44px]"
        >
          {t("goLogin")}
        </Link>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <h1 className="font-display text-2xl tracking-[-0.015em]">
        {t("title")}
      </h1>
      <div>
        <label className="block font-mono text-[10px] tracking-wider uppercase text-op-muted mb-1">
          {t("fieldNew")}
        </label>
        <input
          type="password"
          required
          minLength={8}
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="w-full px-3 py-2.5 rounded-xl border border-op-border bg-op-bg text-sm focus:outline-none focus:ring-1 focus:ring-terracotta min-h-[44px]"
        />
        <p className="text-xs text-op-muted mt-1">{t("hint")}</p>
      </div>
      <div>
        <label className="block font-mono text-[10px] tracking-wider uppercase text-op-muted mb-1">
          {t("fieldConfirm")}
        </label>
        <input
          type="password"
          required
          minLength={8}
          autoComplete="new-password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          className="w-full px-3 py-2.5 rounded-xl border border-op-border bg-op-bg text-sm focus:outline-none focus:ring-1 focus:ring-terracotta min-h-[44px]"
        />
      </div>
      {error && <p className="text-sm text-terracotta">{error}</p>}
      <button
        type="submit"
        disabled={saving || password.length < 8 || confirm.length < 8}
        className="w-full py-3.5 rounded-xl bg-terracotta text-white font-medium disabled:opacity-50 min-h-[44px]"
      >
        {saving ? t("saving") : t("submit")}
      </button>
    </form>
  );
}
