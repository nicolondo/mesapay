"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useTranslations } from "next-intl";

/**
 * Alta de cuenta del comensal: nombre completo, cédula, correo y contraseña.
 *
 * La cédula queda como identificador de login ALTERNO al correo — una
 * persona recuerda su documento aunque no recuerde con cuál de sus correos
 * se registró.
 *
 * Ya no pasa por `signIn("credentials")` de NextAuth: el endpoint abre
 * directamente la sesión permanente y revocable del comensal (ver
 * lib/customerSession.ts). El staff sigue con NextAuth en /signin.
 */
export default function SignUp() {
  const t = useTranslations("customerAuth");
  const router = useRouter();
  const [name, setName] = useState("");
  const [cedula, setCedula] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [password, setPassword] = useState("");
  const [marketingOptIn, setMarketingOptIn] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // El servidor devuelve códigos, no texto: el copy sale del catálogo
  // trilingüe, no de la respuesta HTTP.
  function messageFor(code: string | undefined): string {
    switch (code) {
      case "email_taken":
        return t("errEmailTaken");
      case "cedula_taken":
        return t("errCedulaTaken");
      case "invalid_cedula":
        return t("errInvalidCedula");
      case "invalid":
        return t("errInvalid");
      default:
        return t("errGeneric");
    }
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch("/api/customer/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          cedula: cedula.trim(),
          email: email.trim(),
          phone: phone.trim() || undefined,
          password,
          marketingOptIn,
        }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        setErr(messageFor(j.error));
        return;
      }
      router.push("/me");
      router.refresh();
    } catch {
      setErr(t("errGeneric"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="flex flex-1 items-center justify-center px-6 py-16 bg-bone">
      <form
        onSubmit={onSubmit}
        className="w-full max-w-sm bg-paper rounded-2xl p-7 border border-hairline"
      >
        <div className="font-mono text-[10px] tracking-[0.18em] uppercase text-muted mb-2">
          {"MESAPAY"}
        </div>
        <h1 className="font-display text-3xl tracking-[-0.015em] mb-2">
          {t("signupTitle")}
        </h1>
        <p className="text-sm text-muted mb-6">{t("signupSubtitle")}</p>

        <label
          htmlFor="name"
          className="block font-mono text-[10px] tracking-[0.14em] uppercase text-muted mb-1"
        >
          {t("fieldName")}
        </label>
        <input
          id="name"
          type="text"
          required
          minLength={2}
          maxLength={80}
          autoComplete="name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="w-full h-11 px-3 rounded-lg border border-hairline bg-ivory mb-4 focus:outline-none focus:border-terracotta"
        />

        <label
          htmlFor="cedula"
          className="block font-mono text-[10px] tracking-[0.14em] uppercase text-muted mb-1"
        >
          {t("fieldCedula")}
        </label>
        <input
          id="cedula"
          type="text"
          required
          inputMode="numeric"
          maxLength={40}
          autoComplete="off"
          value={cedula}
          onChange={(e) => setCedula(e.target.value)}
          className="w-full h-11 px-3 rounded-lg border border-hairline bg-ivory focus:outline-none focus:border-terracotta"
        />
        <p className="text-xs text-muted-2 mt-1 mb-4">{t("cedulaHint")}</p>

        <label
          htmlFor="email"
          className="block font-mono text-[10px] tracking-[0.14em] uppercase text-muted mb-1"
        >
          {t("fieldEmail")}
        </label>
        <input
          id="email"
          type="email"
          required
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="w-full h-11 px-3 rounded-lg border border-hairline bg-ivory mb-4 focus:outline-none focus:border-terracotta"
        />

        <label
          htmlFor="phone"
          className="block font-mono text-[10px] tracking-[0.14em] uppercase text-muted mb-1"
        >
          {t("fieldPhone")}
        </label>
        <input
          id="phone"
          type="tel"
          autoComplete="tel"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          className="w-full h-11 px-3 rounded-lg border border-hairline bg-ivory mb-4 focus:outline-none focus:border-terracotta"
        />

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
          minLength={8}
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="w-full h-11 px-3 rounded-lg border border-hairline bg-ivory focus:outline-none focus:border-terracotta"
        />
        <p className="text-xs text-muted-2 mt-1 mb-4">{t("passwordHint")}</p>

        <label className="flex items-start gap-2 mb-5 text-sm cursor-pointer">
          <input
            type="checkbox"
            checked={marketingOptIn}
            onChange={(e) => setMarketingOptIn(e.target.checked)}
            className="mt-0.5 accent-terracotta"
          />
          <span className="text-muted leading-snug">{t("marketingOptIn")}</span>
        </label>

        {err && <div className="text-danger text-sm mb-4">{err}</div>}

        <button
          type="submit"
          disabled={busy}
          className="w-full h-11 rounded-lg bg-ink text-bone font-medium disabled:opacity-60"
        >
          {busy ? t("signupSubmitting") : t("signupSubmit")}
        </button>
        <p className="text-xs text-muted-2 mt-3 text-center">
          {t("sessionNote")}
        </p>

        <div className="mt-5 text-sm text-muted text-center">
          {t("haveAccount")}{" "}
          <Link href="/cuenta/entrar" className="text-terracotta underline">
            {t("goLogin")}
          </Link>
        </div>
      </form>
    </main>
  );
}
