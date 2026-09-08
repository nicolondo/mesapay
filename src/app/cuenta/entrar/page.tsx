"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { useTranslations } from "next-intl";

/**
 * Login del COMENSAL — separado de /signin (que es el del staff).
 *
 * Dos diferencias que justifican la página aparte:
 *   1. Acepta cédula O correo en un solo campo (el `@` decide cuál es).
 *   2. Abre una sesión permanente pero revocable (fila en DB), no el JWT
 *      de NextAuth. Ver lib/customerSession.ts para el porqué.
 *
 * Además ofrece el enlace mágico para quien no recuerda la contraseña —
 * que en la práctica va a ser el camino más usado.
 */
export default function CustomerLoginPage() {
  return (
    <Suspense fallback={null}>
      <CustomerLogin />
    </Suspense>
  );
}

type Mode = "password" | "magic" | "magic_sent";

function CustomerLogin() {
  const t = useTranslations("customerAuth");
  const router = useRouter();
  const search = useSearchParams();
  const callbackUrl = search.get("callbackUrl") ?? "/me";

  const [mode, setMode] = useState<Mode>("password");
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Los endpoints devuelven CÓDIGOS de error, no texto: la app es
  // trilingüe y el copy sale del catálogo, no del servidor.
  function messageFor(code: string | undefined): string {
    switch (code) {
      case "invalid_credentials":
        return t("errInvalidCredentials");
      case "invalid":
        return t("errInvalid");
      default:
        return t("errGeneric");
    }
  }

  async function onSubmitPassword(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch("/api/customer/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ identifier, password }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        setErr(messageFor(j.error));
        return;
      }
      router.push(callbackUrl);
      router.refresh();
    } catch {
      setErr(t("errGeneric"));
    } finally {
      setBusy(false);
    }
  }

  async function onSubmitMagic(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      // El endpoint siempre responde ok — no revela si la cuenta existe.
      await fetch("/api/customer/magic-link", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ identifier }),
      });
      setMode("magic_sent");
    } catch {
      setErr(t("errGeneric"));
    } finally {
      setBusy(false);
    }
  }

  const identifierField = (
    <>
      <label
        htmlFor="identifier"
        className="block font-mono text-[10px] tracking-[0.14em] uppercase text-muted mb-1"
      >
        {t("fieldIdentifier")}
      </label>
      <input
        id="identifier"
        type="text"
        required
        autoComplete="username"
        autoCapitalize="none"
        value={identifier}
        onChange={(e) => setIdentifier(e.target.value)}
        className="w-full h-11 px-3 rounded-lg border border-hairline bg-ivory text-ink mb-4 focus:outline-none focus:border-terracotta"
      />
    </>
  );

  return (
    <main className="flex flex-1 items-center justify-center px-6 py-16 bg-bone">
      <div className="w-full max-w-sm bg-paper rounded-2xl p-7 border border-hairline">
        <div className="font-mono text-[10px] tracking-[0.18em] uppercase text-muted mb-2">
          {"MESAPAY"}
        </div>

        {mode === "magic_sent" ? (
          <>
            <h1 className="font-display text-3xl tracking-[-0.015em] mb-2">
              {t("magicSentTitle")}
            </h1>
            <p className="text-sm text-muted mb-6">{t("magicSentBody")}</p>
            <button
              type="button"
              onClick={() => setMode("password")}
              className="w-full h-11 rounded-lg border border-hairline text-ink font-medium"
            >
              {t("passwordToggle")}
            </button>
          </>
        ) : mode === "magic" ? (
          <form onSubmit={onSubmitMagic}>
            <h1 className="font-display text-3xl tracking-[-0.015em] mb-2">
              {t("magicTitle")}
            </h1>
            <p className="text-sm text-muted mb-6">{t("magicSubtitle")}</p>
            {identifierField}
            {err && <div className="text-danger text-sm mb-4">{err}</div>}
            <button
              type="submit"
              disabled={busy}
              className="w-full h-11 rounded-lg bg-ink text-bone font-medium disabled:opacity-60"
            >
              {busy ? t("magicSubmitting") : t("magicSubmit")}
            </button>
            <button
              type="button"
              onClick={() => {
                setMode("password");
                setErr(null);
              }}
              className="w-full mt-3 text-sm text-terracotta underline"
            >
              {t("passwordToggle")}
            </button>
          </form>
        ) : (
          <form onSubmit={onSubmitPassword}>
            <h1 className="font-display text-3xl tracking-[-0.015em] mb-2">
              {t("loginTitle")}
            </h1>
            <p className="text-sm text-muted mb-6">{t("loginSubtitle")}</p>
            {identifierField}

            <label
              htmlFor="password"
              className="block font-mono text-[10px] tracking-[0.14em] uppercase text-muted mb-1"
            >
              {t("fieldPassword")}
            </label>
            <input
              id="password"
              type="password"
              required
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full h-11 px-3 rounded-lg border border-hairline bg-ivory text-ink mb-5 focus:outline-none focus:border-terracotta"
            />

            {err && <div className="text-danger text-sm mb-4">{err}</div>}

            <button
              type="submit"
              disabled={busy}
              className="w-full h-11 rounded-lg bg-ink text-bone font-medium disabled:opacity-60"
            >
              {busy ? t("loginSubmitting") : t("loginSubmit")}
            </button>
            <p className="text-xs text-muted-2 mt-3 text-center">
              {t("sessionNote")}
            </p>
            <button
              type="button"
              onClick={() => {
                setMode("magic");
                setErr(null);
              }}
              className="w-full mt-3 text-sm text-terracotta underline"
            >
              {t("magicToggle")}
            </button>
          </form>
        )}

        <div className="mt-5 text-sm text-muted text-center space-y-1">
          <div>
            {t("noAccount")}{" "}
            <Link href="/signup" className="text-terracotta underline">
              {t("goSignup")}
            </Link>
          </div>
          <div>
            {t("staffQuestion")}{" "}
            <Link href="/signin" className="text-terracotta underline">
              {t("staffLink")}
            </Link>
          </div>
        </div>
      </div>
    </main>
  );
}
