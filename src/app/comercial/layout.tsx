import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { auth, signOut } from "@/auth";
import { ComercialBottomNav } from "./ComercialBottomNav";
import { PushSetup } from "@/app/mesero/PushSetup";

/**
 * Layout server-gated para /comercial/*.
 * Roles: `comercial`, `gerente_comercial`, `platform_admin`.
 *
 * Mobile-first: bottom nav fija <lg, sidebar links en desktop.
 * PWA: manifest "MP COMERCIAL" (per-role pattern).
 */
export const metadata: Metadata = {
  title: "MP COMERCIAL",
  applicationName: "MP COMERCIAL",
  manifest: "/api/manifest/comercial",
  appleWebApp: {
    capable: true,
    title: "MP COMERCIAL",
    statusBarStyle: "black-translucent",
  },
};

const CRM_ROLES = new Set(["comercial", "gerente_comercial", "platform_admin"]);

export default async function ComercialLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await auth();
  if (!session?.user) redirect("/signin?callbackUrl=/comercial");

  const { role } = session.user;
  if (!CRM_ROLES.has(role ?? "")) {
    redirect("/");
  }

  const t = await getTranslations("comercialPortal");
  const tc = await getTranslations("crm");

  const signOutAction = async () => {
    "use server";
    await signOut({ redirectTo: "/" });
  };

  return (
    <div className="flex flex-col min-h-screen bg-op-bg text-op-text">
      {/* Compact header */}
      <header
        className="staff-safe-top sticky top-0 z-30 border-b border-op-border bg-op-surface flex items-center justify-between px-4 pb-3 lg:px-6"
        style={{ "--staff-safe-base-pt": "0.75rem" } as React.CSSProperties}
      >
        <div className="shrink-0">
          <div className="font-mono text-[9px] tracking-[0.18em] uppercase text-terracotta">
            {t("shellTag")}
          </div>
          <div className="font-display text-xl tracking-[-0.015em]">
            {"MESAPAY"}
          </div>
        </div>

        {/* Desktop nav links (lg+) */}
        <nav className="hidden lg:flex items-center gap-6 text-sm">
          <Link
            href="/comercial/hoy"
            className="font-mono text-[11px] tracking-wider uppercase text-op-muted hover:text-op-text transition-colors"
          >
            {tc("navHoy")}
          </Link>
          <Link
            href="/comercial/crm"
            className="font-mono text-[11px] tracking-wider uppercase text-op-muted hover:text-op-text transition-colors"
          >
            {tc("navPipeline")}
          </Link>
          <Link
            href="/comercial/calendario"
            className="font-mono text-[11px] tracking-wider uppercase text-op-muted hover:text-op-text transition-colors"
          >
            {tc("navCalendario")}
          </Link>
          <Link
            href="/comercial/mas"
            className="font-mono text-[11px] tracking-wider uppercase text-op-muted hover:text-op-text transition-colors"
          >
            {tc("navMas")}
          </Link>
        </nav>

        <div className="flex items-center gap-3 text-sm">
          {role === "platform_admin" && (
            <Link
              href="/admin"
              className="font-mono text-[10px] tracking-wider uppercase text-op-muted hover:text-op-text hidden sm:inline"
            >
              {"Admin"}
            </Link>
          )}
          <span className="hidden md:inline text-op-muted text-xs">
            {session.user.email}
          </span>
          <form action={signOutAction}>
            <button
              type="submit"
              className="text-terracotta hover:underline text-sm"
            >
              {t("signOut")}
            </button>
          </form>
        </div>
      </header>

      {/* Push opt-in — same unobtrusive banner as mesero PWA. */}
      <PushSetup />

      {/* Content — bottom-padded on mobile to clear fixed nav */}
      <main
        className="flex flex-1 flex-col"
        style={{
          paddingBottom: "calc(env(safe-area-inset-bottom, 0px) + 4.5rem)",
        }}
      >
        {children}
      </main>

      {/* Bottom nav — mobile only (<lg) */}
      <ComercialBottomNav role={role ?? ""} />
    </div>
  );
}
