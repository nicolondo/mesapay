"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";

/**
 * Mobile-only hamburger drawer for the admin layout. The desktop nav
 * shows links + identity inline in the header; on small screens we hide
 * those and surface a single button that opens this drawer. We do the
 * server-action signout via a child form passed from the layout —
 * client components can't import server actions directly without
 * crossing the boundary awkwardly.
 */
export function AdminMobileMenu({
  userEmail,
  signOutAction,
}: {
  userEmail: string;
  // The form-action server function gets cloned into the menu's
  // signout button so the menu can fire it without re-implementing
  // the signOut() server-side logic.
  signOutAction: React.ReactNode;
}) {
  const t = useTranslations("opAdmin");
  const [open, setOpen] = useState(false);
  const pathname = usePathname();

  // Close the drawer automatically when the route changes — otherwise
  // tapping a link leaves the overlay covering the page you just
  // navigated to.
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  // Lock body scroll while the drawer is open so the page underneath
  // doesn't slide around with the menu.
  useEffect(() => {
    if (!open) return;
    const original = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = original;
    };
  }, [open]);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={t("openMenu")}
        className="md:hidden inline-flex items-center justify-center w-10 h-10 rounded-lg border border-op-border bg-op-surface text-op-text active:scale-95 transition-transform"
      >
        <svg
          width="20"
          height="20"
          viewBox="0 0 20 20"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.75"
          strokeLinecap="round"
        >
          <line x1="3" y1="6" x2="17" y2="6" />
          <line x1="3" y1="10" x2="17" y2="10" />
          <line x1="3" y1="14" x2="17" y2="14" />
        </svg>
      </button>

      {open && (
        <div
          className="md:hidden fixed inset-0 z-50 bg-black/40"
          onClick={() => setOpen(false)}
          role="dialog"
          aria-modal="true"
        >
          <div
            className="absolute top-0 right-0 bottom-0 w-[min(20rem,85vw)] bg-op-surface border-l border-op-border shadow-xl flex flex-col"
            onClick={(e) => e.stopPropagation()}
            style={{ paddingTop: "env(safe-area-inset-top)" }}
          >
            <div className="flex items-center justify-between px-5 py-4 border-b border-op-border">
              <div>
                <div className="font-mono text-[9px] tracking-[0.18em] uppercase text-terracotta">
                  {t("shellTag")}
                </div>
                <div className="font-display text-lg tracking-[-0.015em]">
                  {"MESAPAY"}
                </div>
              </div>
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label={t("closeMenu")}
                className="w-9 h-9 inline-flex items-center justify-center rounded-lg text-op-muted hover:text-op-text"
              >
                <svg
                  width="20"
                  height="20"
                  viewBox="0 0 20 20"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.75"
                  strokeLinecap="round"
                >
                  <line x1="5" y1="5" x2="15" y2="15" />
                  <line x1="15" y1="5" x2="5" y2="15" />
                </svg>
              </button>
            </div>

            <nav className="flex flex-col p-3 gap-1">
              <DrawerLink href="/admin" pathname={pathname}>
                {t("navSummary")}
              </DrawerLink>
              <DrawerLink href="/admin/restaurants" pathname={pathname}>
                {t("navRestaurants")}
              </DrawerLink>
              <DrawerLink href="/admin/groups" pathname={pathname}>
                {t("navGroups")}
              </DrawerLink>
              <DrawerLink href="/admin/plans" pathname={pathname}>
                {t("navPlans")}
              </DrawerLink>
              <DrawerLink href="/admin/audit" pathname={pathname}>
                {t("navAuditLog")}
              </DrawerLink>
              <DrawerLink href="/admin/comisiones" pathname={pathname}>
                {t("navComisiones")}
              </DrawerLink>
              <DrawerLink href="/comercial" pathname={pathname}>
                {t("navCrm")}
              </DrawerLink>
              <DrawerLink href="/admin/configuracion" pathname={pathname}>
                {t("navConfig")}
              </DrawerLink>
              <DrawerLink href="/operator" pathname={pathname}>
                {t("backToOperatorFull")}
              </DrawerLink>
            </nav>

            <div className="mt-auto border-t border-op-border p-5">
              <div className="text-[11px] text-op-muted mb-2">
                {t("loggedInAs")}
              </div>
              <div className="text-sm font-medium mb-4 break-all">
                {userEmail}
              </div>
              {/* signOutAction is the server-action form from layout */}
              {signOutAction}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function DrawerLink({
  href,
  pathname,
  children,
}: {
  href: string;
  pathname: string | null;
  children: React.ReactNode;
}) {
  const active = pathname === href || pathname?.startsWith(href + "/");
  return (
    <Link
      href={href}
      className={
        "px-4 h-11 inline-flex items-center rounded-xl text-sm transition-colors " +
        (active
          ? "bg-ink text-bone"
          : "text-op-text hover:bg-op-bg")
      }
    >
      {children}
    </Link>
  );
}
