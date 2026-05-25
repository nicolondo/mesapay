"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";

type NavItem = { href: string; label: string };

/**
 * Mobile-only hamburger drawer for the operator layout. Mirrors the
 * admin pattern: tiny button on the header that opens a right-side
 * drawer with every nav link + identity bits. The desktop top-nav
 * stays inline on md+; on smaller screens the inline nav + email +
 * Salir are hidden and replaced by this trigger.
 */
export function OperatorMobileMenu({
  tenantName,
  userEmail,
  isAdmin,
  items,
  signOutAction,
}: {
  tenantName: string;
  userEmail: string;
  // Platform admin gets an extra link back to /admin.
  isAdmin: boolean;
  items: NavItem[];
  // Server-action form rendered by the layout (cannot define a server
  // action inside a client component, so the parent passes it as JSX).
  signOutAction: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();

  // Close on navigation so the overlay doesn't linger.
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  // Lock body scroll while open.
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
        aria-label="Abrir menú"
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
              <div className="min-w-0">
                <div className="font-mono text-[9px] tracking-[0.18em] uppercase text-op-muted truncate">
                  Operador · {tenantName}
                </div>
                <div className="font-display text-lg tracking-[-0.015em]">
                  MESAPAY
                </div>
              </div>
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="Cerrar menú"
                className="w-9 h-9 inline-flex items-center justify-center rounded-lg text-op-muted hover:text-op-text shrink-0"
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

            <nav className="flex flex-col p-3 gap-1 overflow-y-auto">
              {items.map((it) => (
                <DrawerLink
                  key={it.href}
                  href={it.href}
                  pathname={pathname}
                >
                  {it.label}
                </DrawerLink>
              ))}
              {isAdmin && (
                <DrawerLink href="/admin" pathname={pathname}>
                  Admin de plataforma →
                </DrawerLink>
              )}
            </nav>

            <div className="mt-auto border-t border-op-border p-5">
              <div className="text-[11px] text-op-muted mb-2">
                Sesión iniciada como
              </div>
              <div className="text-sm font-medium mb-4 break-all">
                {userEmail}
              </div>
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
  // Match by exact path or as a parent prefix (so /operator/menu/import
  // still highlights "Menú"). The root "/operator" exact-only — otherwise
  // it would match everything under it and stay always-active.
  const active =
    pathname === href ||
    (href !== "/operator" && pathname?.startsWith(href + "/"));
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
