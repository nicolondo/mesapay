"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { Icon } from "@/components/ui/Icon";
import { LocaleSwitcher } from "@/components/LocaleSwitcher";
import { signIn, getSession } from "next-auth/react";

/**
 * Login del STAFF (operator / mesero / cocina / bar / terminal / admin).
 *
 * Sigue siendo NextAuth con sesión JWT — intacto. El comensal ya no entra
 * por acá: su cuenta es de UN comercio y entra por
 * /t/[slug]/cuenta/entrar, con cédula-o-correo y sesión permanente
 * revocable. Las dos estrategias conviven a propósito (ver
 * lib/dinerSession.ts): una sesión que no vence tiene sentido en el
 * celular de una persona, no en la caja compartida de un restaurante.
 */
export default function SignInPage() {
  return (
    <Suspense fallback={null}>
      <SignIn />
    </Suspense>
  );
}

function SignIn() {
  const t = useTranslations("signin");
  const ux = useTranslations("workspaceUi");
  const nav = useTranslations("operator");
  const [showPassword, setShowPassword] = useState(false);
  const router = useRouter();
  const search = useSearchParams();
  const requestedCallback = search.get("callbackUrl") ?? "/";
  const callbackUrl =
    requestedCallback.startsWith("/") &&
    !requestedCallback.startsWith("//") &&
    !/[\\\r\n]/.test(requestedCallback)
      ? requestedCallback
      : "/";
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await signIn("credentials", {
        email,
        password,
        redirect: false,
      });
      if (res?.error) {
        setErr(t("error"));
        return;
      }
      // Decide where to land based on role. Honour an explicit ?callbackUrl=
      // (e.g. the customer was bounced from /me to /signin and we want them
      // back where they were); otherwise pick the dashboard that matches the
      // user's role — terminal users should never see the marketing home.
      let dest = callbackUrl;
      if (callbackUrl === "/" || !callbackUrl) {
        const session = await getSession();
        const role = session?.user?.role;
        if (role === "terminal") dest = "/terminal";
        else if (role === "mesero") dest = "/mesero/salon";
        else if (role === "kitchen") dest = "/cocina";
        else if (role === "bar") dest = "/bar";
        else if (role === "operator") dest = "/operator";
        else if (role === "group_admin") dest = "/group";
        else if (role === "platform_admin") dest = "/admin";
        else if (role === "comercial" || role === "gerente_comercial")
          dest = "/comercial";
      }
      router.push(dest);
      router.refresh();
    } catch {
      setErr(ux("networkError"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mp-signin">
      <section className="mp-signin-story" aria-label={ux("signinKicker")}>
        <Link href="/" className="font-display text-3xl">
          {"MESA"}
          <span className="text-rail-accent">{"PAY"}</span>
        </Link>
        <div>
          <p className="mp-eyebrow">{ux("workspace")}</p>
          <h2>{ux("signinKicker")}</h2>
          <p>{ux("signinBody")}</p>
          <div className="mp-signin-steps">
            {(
              [
                { icon: "menu", label: nav("navMenu") },
                { icon: "orders", label: nav("navOrders") },
                { icon: "business", label: nav("navPayments") },
              ] as const
            ).map((step) => (
              <span key={step.icon}>
                <Icon name={step.icon} />
                {step.label}
              </span>
            ))}
          </div>
        </div>
        <span className="text-sm text-white/50">{ux("signinDescription")}</span>
      </section>
      <div className="mp-signin-form-area">
        <div className="mp-signin-locale">
          <LocaleSwitcher />
        </div>
        <form onSubmit={onSubmit} className="w-full max-w-sm" aria-busy={busy}>
          <div className="font-mono text-[10px] tracking-[0.18em] uppercase text-muted mb-2">
            {"MESAPAY"}
          </div>
          <h1 className="text-3xl font-semibold tracking-[-0.04em] mb-2">
            {t("title")}
          </h1>
          <p className="text-sm text-muted leading-relaxed mb-8">
            {ux("signinDescription")}
          </p>

          <label
            htmlFor="email"
            className="block text-sm font-medium text-ink mb-2"
          >
            {t("fieldEmail")}
          </label>
          <input
            id="email"
            type="email"
            required
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
            aria-invalid={!!err}
            aria-describedby={err ? "signin-error" : undefined}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="w-full h-12 px-3 rounded-lg border border-hairline bg-ivory text-ink mb-4 focus:outline-none focus:border-terracotta"
          />

          <label
            htmlFor="password"
            className="block text-sm font-medium text-ink mb-2"
          >
            {t("fieldPassword")}
          </label>
          <div className="relative mb-5">
            <input
              id="password"
              type={showPassword ? "text" : "password"}
              aria-invalid={!!err}
              aria-describedby={err ? "signin-error" : undefined}
              required
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full h-12 px-3 rounded-lg border border-hairline bg-ivory text-ink pr-24 focus:outline-none focus:border-terracotta"
            />

            <button
              type="button"
              aria-label={
                showPassword ? ux("passwordHide") : ux("passwordShow")
              }
              aria-pressed={showPassword}
              onClick={() => setShowPassword((v) => !v)}
              className="absolute right-2 top-1 h-10 px-2 text-xs font-medium text-muted"
            >
              {showPassword ? ux("hide") : ux("show")}
            </button>
          </div>
          {err && (
            <div
              id="signin-error"
              role="alert"
              className="rounded-lg bg-danger/10 px-3 py-3 text-danger text-sm mb-4"
            >
              {err}
            </div>
          )}

          <button
            type="submit"
            disabled={busy}
            className="mp-btn mp-btn--primary w-full rounded-lg!"
          >
            {busy ? t("submitting") : t("submit")}
          </button>

          <div className="mt-5 text-sm text-muted text-center space-y-1">
            <div>
              {t("customerQuestion")}{" "}
              <Link href="/cuenta/entrar" className="text-terracotta underline">
                {t("customerLink")}
              </Link>
            </div>
            <div>
              {t("restaurantQuestion")}{" "}
              <Link
                href="/signup/restaurant"
                className="text-terracotta underline"
              >
                {t("restaurantLink")}
              </Link>
            </div>
          </div>
        </form>
      </div>
    </main>
  );
}
