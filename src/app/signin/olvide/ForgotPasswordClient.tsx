"use client";

import { useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";

/**
 * Pide el enlace de restablecimiento. El servidor responde lo mismo exista o
 * no el correo, así que la pantalla tampoco distingue: siempre el mismo
 * "si el correo existe, te mandamos un enlace".
 */
export function ForgotPasswordClient() {
  const t = useTranslations("forgotPwd");
  const ux = useTranslations("workspaceUi");
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setFieldError(null);
    setFormError(null);
    const value = email.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
      setFieldError(t("errInvalidEmail"));
      return;
    }
    setBusy(true);
    try {
      const res = await fetch("/api/auth/forgot-password", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: value }),
      });
      if (res.ok) {
        setSent(true);
        return;
      }
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (body.error === "invalid") setFieldError(t("errInvalidEmail"));
      else if (body.error === "rate_limited") setFormError(t("errRateLimited"));
      else setFormError(t("errGeneric"));
    } catch {
      setFormError(ux("networkError"));
    } finally {
      setBusy(false);
    }
  }

  if (sent) {
    return (
      <div className="space-y-4" role="status">
        <h1 className="font-display text-2xl tracking-[-0.015em]">
          {t("sentTitle")}
        </h1>
        <p className="text-sm text-op-muted">{t("sentBody")}</p>
        <Link
          href="/signin"
          className="inline-flex items-center justify-center w-full py-3.5 rounded-xl bg-ink text-bone text-sm font-medium min-h-[44px]"
        >
          {t("backToSignin")}
        </Link>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} noValidate aria-busy={busy} className="space-y-4">
      <h1 className="font-display text-2xl tracking-[-0.015em]">{t("title")}</h1>
      <p className="text-sm text-op-muted">{t("intro")}</p>
      <div>
        <label
          htmlFor="forgot-email"
          className="block font-mono text-[10px] tracking-wider uppercase text-op-muted mb-1"
        >
          {t("fieldEmail")}
        </label>
        <input
          id="forgot-email"
          type="email"
          required
          autoComplete="username"
          autoCapitalize="none"
          spellCheck={false}
          maxLength={254}
          aria-invalid={!!fieldError}
          aria-describedby={fieldError ? "forgot-email-error" : undefined}
          value={email}
          onChange={(e) => {
            setEmail(e.target.value);
            if (fieldError) setFieldError(null);
          }}
          className={
            "w-full px-3 py-2.5 rounded-xl border bg-op-bg text-sm focus:outline-none focus:ring-1 focus:ring-terracotta min-h-[44px] " +
            (fieldError ? "border-danger" : "border-op-border")
          }
        />
        {fieldError && (
          <p id="forgot-email-error" className="mt-1 text-xs text-danger">
            {fieldError}
          </p>
        )}
      </div>
      {formError && (
        <div role="alert" className="rounded-lg bg-danger/10 px-3 py-3 text-danger text-sm">
          {formError}
        </div>
      )}
      <button
        type="submit"
        disabled={busy}
        className="w-full py-3.5 rounded-xl bg-terracotta text-white font-medium disabled:opacity-50 min-h-[44px]"
      >
        {busy ? t("sending") : t("submit")}
      </button>
      <div className="text-sm text-op-muted text-center space-y-1">
        <div>
          <Link href="/signin" className="text-terracotta underline">
            {t("backToSignin")}
          </Link>
        </div>
        <div>
          {t("dinerQuestion")}{" "}
          <Link href="/cuenta/entrar" className="text-terracotta underline">
            {t("dinerLink")}
          </Link>
        </div>
      </div>
    </form>
  );
}
