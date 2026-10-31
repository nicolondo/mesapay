"use client";

import { useId, useState } from "react";
import { useTranslations } from "next-intl";
import { PASSWORD_MAX, PASSWORD_MIN } from "@/lib/passwordPolicy";

type Field = "current" | "next" | "confirm";
type FieldErrors = Partial<Record<Field, string>>;

/**
 * "Cambiar mi contraseña" del personal con sesión. Pega a
 * `POST /api/auth/password`, que exige la contraseña actual, cierra las
 * demás sesiones y re-emite la de este navegador. Si el servidor no pudo
 * conservar esta sesión (`sessionKept: false`) se manda al login con aviso.
 *
 * Vive en components/ para que operador y mesero puedan reusarlo el día que
 * tengan su propia pantalla de cuenta; hoy sólo lo monta /admin/cuenta.
 */
export function ChangePasswordForm({ signInPath }: { signInPath: string }) {
  const t = useTranslations("myAccount");
  const ux = useTranslations("workspaceUi");
  const ids = useId();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [show, setShow] = useState<Record<Field, boolean>>({
    current: false,
    next: false,
    confirm: false,
  });
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  function validate(): FieldErrors {
    const e: FieldErrors = {};
    if (!current) e.current = t("errCurrentRequired");
    if (next.length < PASSWORD_MIN) e.next = t("errTooShort", { min: PASSWORD_MIN });
    else if (next.length > PASSWORD_MAX) e.next = t("errTooLong", { max: PASSWORD_MAX });
    else if (current && next === current) e.next = t("errSame");
    if (!e.next && confirm !== next) e.confirm = t("errMismatch");
    return e;
  }

  /** Lleva el foco al primer campo con error (lectores de pantalla y teclado). */
  function showErrors(e: FieldErrors) {
    setErrors(e);
    const first = (["current", "next", "confirm"] as const).find((k) => e[k]);
    if (first) document.getElementById(`${ids}-${first}`)?.focus();
  }

  function goToSignIn() {
    const qs = new URLSearchParams({
      callbackUrl: window.location.pathname,
      notice: "password_changed",
    });
    window.location.assign(`${signInPath}?${qs}`);
  }

  async function onSubmit(ev: React.FormEvent) {
    ev.preventDefault();
    if (busy) return;
    setDone(false);
    setFormError(null);
    const local = validate();
    showErrors(local);
    if (Object.keys(local).length) return;

    setBusy(true);
    try {
      const res = await fetch("/api/auth/password", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ currentPassword: current, newPassword: next }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        error?: string;
        sessionKept?: boolean;
      };
      if (res.ok) {
        setCurrent("");
        setNext("");
        setConfirm("");
        if (body.sessionKept === false) {
          goToSignIn();
          return;
        }
        setDone(true);
        return;
      }
      switch (body.error) {
        case "unauthorized":
          window.location.assign(
            `${signInPath}?${new URLSearchParams({ callbackUrl: window.location.pathname })}`,
          );
          return;
        case "wrong_current_password":
          showErrors({ current: t("errWrongCurrent") });
          return;
        case "same_password":
          showErrors({ next: t("errSame") });
          return;
        case "new_password_too_short":
          showErrors({ next: t("errTooShort", { min: PASSWORD_MIN }) });
          return;
        case "new_password_too_long":
          showErrors({ next: t("errTooLong", { max: PASSWORD_MAX }) });
          return;
        case "rate_limited":
          setFormError(t("errRateLimited"));
          return;
        default:
          setFormError(t("errGeneric"));
      }
    } catch {
      setFormError(ux("networkError"));
    } finally {
      setBusy(false);
    }
  }

  const fields: {
    key: Field;
    label: string;
    value: string;
    set: (v: string) => void;
    autoComplete: string;
    hint?: string;
  }[] = [
    {
      key: "current",
      label: t("fieldCurrent"),
      value: current,
      set: setCurrent,
      autoComplete: "current-password",
    },
    {
      key: "next",
      label: t("fieldNew"),
      value: next,
      set: setNext,
      autoComplete: "new-password",
      hint: t("hint", { min: PASSWORD_MIN, max: PASSWORD_MAX }),
    },
    {
      key: "confirm",
      label: t("fieldConfirm"),
      value: confirm,
      set: setConfirm,
      autoComplete: "new-password",
    },
  ];

  return (
    <form onSubmit={onSubmit} noValidate aria-busy={busy} className="space-y-4">
      {fields.map((f) => {
        const inputId = `${ids}-${f.key}`;
        const errorId = `${inputId}-error`;
        const hintId = `${inputId}-hint`;
        const error = errors[f.key];
        const describedBy = error ? errorId : f.hint ? hintId : undefined;
        return (
          <div key={f.key}>
            <label
              htmlFor={inputId}
              className="block font-mono text-[10px] tracking-wider uppercase text-op-muted mb-1"
            >
              {f.label}
            </label>
            <div className="relative">
              <input
                id={inputId}
                type={show[f.key] ? "text" : "password"}
                autoComplete={f.autoComplete}
                autoCapitalize="none"
                spellCheck={false}
                maxLength={f.key === "current" ? 200 : PASSWORD_MAX}
                aria-invalid={!!error}
                aria-describedby={describedBy}
                value={f.value}
                onChange={(e) => {
                  f.set(e.target.value);
                  if (errors[f.key]) setErrors((prev) => ({ ...prev, [f.key]: undefined }));
                }}
                className={
                  "w-full h-11 px-3 pr-20 rounded-lg border bg-op-bg text-sm focus:outline-none focus:border-terracotta " +
                  (error ? "border-danger" : "border-op-border")
                }
              />
              <button
                type="button"
                aria-label={show[f.key] ? ux("passwordHide") : ux("passwordShow")}
                aria-pressed={show[f.key]}
                aria-controls={inputId}
                onClick={() => setShow((s) => ({ ...s, [f.key]: !s[f.key] }))}
                className="absolute right-1 top-0.5 h-10 px-3 text-xs font-medium text-op-muted hover:text-op-text"
              >
                {show[f.key] ? ux("hide") : ux("show")}
              </button>
            </div>
            {f.hint && !error && (
              <p id={hintId} className="mt-1 text-[11px] text-op-muted">
                {f.hint}
              </p>
            )}
            {error && (
              <p id={errorId} className="mt-1 text-xs text-danger">
                {error}
              </p>
            )}
          </div>
        );
      })}

      {formError && (
        <div role="alert" className="rounded-lg bg-danger/10 px-3 py-3 text-danger text-sm">
          {formError}
        </div>
      )}
      {done && (
        <div role="status" className="rounded-lg bg-op-bg border border-op-border px-3 py-3 text-sm">
          {t("success")}
        </div>
      )}

      <button
        type="submit"
        disabled={busy}
        className="mp-btn mp-btn--primary mp-btn--sm px-4 disabled:opacity-50"
      >
        {busy ? t("saving") : t("submit")}
      </button>
    </form>
  );
}
