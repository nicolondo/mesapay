"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";

/**
 * Fixed bottom navigation for the /comercial portal — mobile only (<lg).
 * 4 tabs: Hoy · Pipeline · Calendario · Más.
 * Active state derived from current pathname.
 * Tap targets ≥44px; safe-area-inset-bottom respected.
 */
export function ComercialBottomNav({ role }: { role: string }) {
  // role will be used in future for conditional tab visibility (e.g. team tab)
  void role;
  const t = useTranslations("crm");
  const pathname = usePathname();

  function isActive(prefix: string) {
    return pathname === prefix || pathname.startsWith(prefix + "/");
  }

  return (
    <nav
      className="lg:hidden fixed bottom-0 inset-x-0 bg-op-surface/95 backdrop-blur border-t border-op-border z-40"
      style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
      aria-label={t("navMas")}
    >
      <ul className="grid grid-cols-4 max-w-lg mx-auto">
        <NavTab
          href="/comercial/hoy"
          label={t("navHoy")}
          icon={
            <svg viewBox="0 0 20 20" fill="currentColor" className="w-5 h-5">
              <path
                fillRule="evenodd"
                d="M10 18a8 8 0 100-16 8 8 0 000 16zm1-12a1 1 0 10-2 0v4a1 1 0 00.293.707l2.828 2.829a1 1 0 101.415-1.415L11 9.586V6z"
                clipRule="evenodd"
              />
            </svg>
          }
          active={isActive("/comercial/hoy")}
        />
        <NavTab
          href="/comercial/crm"
          label={t("navPipeline")}
          icon={
            <svg viewBox="0 0 20 20" fill="currentColor" className="w-5 h-5">
              <path d="M2 11a1 1 0 011-1h2a1 1 0 011 1v5a1 1 0 01-1 1H3a1 1 0 01-1-1v-5zM8 7a1 1 0 011-1h2a1 1 0 011 1v9a1 1 0 01-1 1H9a1 1 0 01-1-1V7zM14 4a1 1 0 011-1h2a1 1 0 011 1v12a1 1 0 01-1 1h-2a1 1 0 01-1-1V4z" />
            </svg>
          }
          active={isActive("/comercial/crm")}
        />
        <NavTab
          href="/comercial/calendario"
          label={t("navCalendario")}
          icon={
            <svg viewBox="0 0 20 20" fill="currentColor" className="w-5 h-5">
              <path
                fillRule="evenodd"
                d="M6 2a1 1 0 00-1 1v1H4a2 2 0 00-2 2v10a2 2 0 002 2h12a2 2 0 002-2V6a2 2 0 00-2-2h-1V3a1 1 0 10-2 0v1H7V3a1 1 0 00-1-1zm0 5a1 1 0 000 2h8a1 1 0 100-2H6z"
                clipRule="evenodd"
              />
            </svg>
          }
          active={isActive("/comercial/calendario")}
        />
        <NavTab
          href="/comercial/mas"
          label={t("navMas")}
          icon={
            <svg viewBox="0 0 20 20" fill="currentColor" className="w-5 h-5">
              <path d="M6 10a2 2 0 11-4 0 2 2 0 014 0zM12 10a2 2 0 11-4 0 2 2 0 014 0zM16 12a2 2 0 100-4 2 2 0 000 4z" />
            </svg>
          }
          active={isActive("/comercial/mas")}
        />
      </ul>
    </nav>
  );
}

function NavTab({
  href,
  label,
  icon,
  active,
}: {
  href: string;
  label: string;
  icon: React.ReactNode;
  active: boolean;
}) {
  return (
    <li>
      <Link
        href={href}
        className={
          "flex flex-col items-center justify-center min-h-[44px] py-2 px-1 text-[11px] font-medium transition-colors " +
          (active ? "text-terracotta" : "text-op-muted hover:text-op-text")
        }
      >
        <span aria-hidden className="mb-0.5">
          {icon}
        </span>
        {label}
      </Link>
    </li>
  );
}
