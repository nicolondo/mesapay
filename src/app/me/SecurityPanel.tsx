"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { formatDate } from "@/lib/format";
import type { Locale } from "@/i18n/config";

export type SessionRow = {
  id: string;
  userAgent: string | null;
  createdAt: string;
  lastUsedAt: string;
};

/**
 * Panel de seguridad del comensal: dispositivos abiertos y cambio de clave.
 *
 * Esta pantalla es la contraparte visible de la decisión de fondo: como la
 * sesión del comensal vive en base de datos y no en un JWT, se puede
 * revocar. Sin eso, ninguno de estos botones podría existir — un JWT
 * eterno no se puede matar antes de que expire, y no expira.
 */
export function SecurityPanel({
  locale,
  viaNextAuth,
  currentSessionId,
  sessions,
}: {
  locale: Locale;
  /** true cuando entró con la sesión JWT vieja (antes de este cambio). */
  viaNextAuth: boolean;
  currentSessionId: string | null;
  sessions: SessionRow[];
}) {
  const t = useTranslations("me");
  const router = useRouter();
  const [, startTx] = useTransition();

  const [busy, setBusy] = useState<null | "others" | "all" | "password">(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");

  const fmt = (iso: string) => formatDate(iso, { locale });

  async function closeSessions(keepCurrent: boolean) {
    setBusy(keepCurrent ? "others" : "all");
    setErr(null);
    setMsg(null);
    try {
      const res = await fetch("/api/customer/sessions", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ keepCurrent }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        setErr(t("errGeneric"));
        return;
      }
      if (!keepCurrent) {
        // Se cerró también la de este navegador: ya no hay a dónde volver.
        window.location.href = "/cuenta/entrar";
        return;
      }
      const count = typeof j.revoked === "number" ? j.revoked : 0;
      setMsg(count === 0 ? t("closedNone") : t("closedOthers", { count }));
      startTx(() => router.refresh());
    } catch {
      setErr(t("errGeneric"));
    } finally {
      setBusy(null);
    }
  }

  async function changePassword(e: React.FormEvent) {
    e.preventDefault();
    setBusy("password");
    setErr(null);
    setMsg(null);
    try {
      const res = await fetch("/api/customer/password", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        setErr(
          j.error === "wrong_password"
            ? t("errWrongPassword")
            : t("errGeneric"),
        );
        return;
      }
      setCurrentPassword("");
      setNewPassword("");
      setMsg(t("passwordSaved"));
      startTx(() => router.refresh());
    } catch {
      setErr(t("errGeneric"));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="rounded-2xl border border-hairline bg-paper p-5 space-y-5">
      <p className="text-sm text-muted leading-snug">{t("securityIntro")}</p>

      {viaNextAuth && (
        <p className="text-xs text-muted-2 leading-snug">
          {t("legacySessionNote")}
        </p>
      )}

      {sessions.length > 0 && (
        <ul className="space-y-2">
          {sessions.map((s) => (
            <li
              key={s.id}
              className="rounded-xl border border-hairline bg-ivory p-3"
            >
              <div className="text-sm text-ink truncate">
                {s.userAgent ?? t("deviceUnknown")}
              </div>
              <div className="font-mono text-[10px] text-muted mt-1">
                {t("deviceSince", { date: fmt(s.createdAt) })}
              </div>
              <div className="font-mono text-[10px] text-muted">
                {t("deviceLastUsed", { date: fmt(s.lastUsedAt) })}
              </div>
              {s.id === currentSessionId && (
                <div className="font-mono text-[9px] tracking-wider uppercase text-terracotta mt-1">
                  {t("deviceCurrent")}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => closeSessions(true)}
          disabled={busy !== null}
          className="h-10 px-4 rounded-full border border-hairline text-sm text-ink disabled:opacity-60"
        >
          {busy === "others" ? t("closing") : t("closeOthers")}
        </button>
        <button
          type="button"
          onClick={() => closeSessions(false)}
          disabled={busy !== null}
          className="h-10 px-4 rounded-full border border-danger/40 text-sm text-danger disabled:opacity-60"
        >
          {busy === "all" ? t("closing") : t("closeAll")}
        </button>
      </div>

      <form onSubmit={changePassword} className="space-y-3 pt-2">
        <div className="font-mono text-[10px] tracking-[0.14em] uppercase text-muted">
          {t("passwordTitle")}
        </div>
        <label className="block">
          <span className="font-mono text-[10px] tracking-[0.14em] uppercase text-muted">
            {t("fieldCurrentPassword")}
          </span>
          <input
            type="password"
            autoComplete="current-password"
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
            className="mt-1 w-full h-10 px-3 rounded-lg border border-hairline bg-ivory focus:outline-none focus:border-terracotta"
          />
        </label>
        <label className="block">
          <span className="font-mono text-[10px] tracking-[0.14em] uppercase text-muted">
            {t("fieldNewPassword")}
          </span>
          <input
            type="password"
            minLength={8}
            autoComplete="new-password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            className="mt-1 w-full h-10 px-3 rounded-lg border border-hairline bg-ivory focus:outline-none focus:border-terracotta"
          />
        </label>
        <p className="text-xs text-muted-2 leading-snug">{t("passwordHint")}</p>
        <button
          type="submit"
          disabled={
            busy !== null || currentPassword.length < 1 || newPassword.length < 8
          }
          className="h-10 px-4 rounded-full bg-ink text-bone text-sm font-medium disabled:opacity-60"
        >
          {busy === "password" ? t("saving") : t("passwordSubmit")}
        </button>
      </form>

      {err && <div className="text-danger text-xs">{err}</div>}
      {msg && <div className="text-[#1E5339] text-xs">{msg}</div>}
    </div>
  );
}
