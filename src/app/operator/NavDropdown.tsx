"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";

type NavItem = { href: string; label: string };

/**
 * Dropdown de la nav de escritorio del operador — agrupa los módulos
 * administrativos (ERP) en un solo item para que la nav no crezca un
 * item por módulo activado. Click para abrir (hover-only es hostil en
 * touch), cierra con click afuera, Escape o al navegar. El trigger se
 * resalta cuando la ruta actual pertenece a un módulo del grupo.
 */
export function NavDropdown({
  label,
  items,
}: {
  label: string;
  items: NavItem[];
}) {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();
  const rootRef = useRef<HTMLDivElement>(null);

  // Cerrar al navegar — ajuste de estado DURANTE el render (patrón React
  // "derived state"), no en un efecto (react-hooks/set-state-in-effect).
  const [lastPath, setLastPath] = useState(pathname);
  if (pathname !== lastPath) {
    setLastPath(pathname);
    setOpen(false);
  }

  // Click afuera + Escape.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const activeGroup = items.some(
    (it) => pathname === it.href || pathname?.startsWith(it.href + "/"),
  );

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="menu"
        className={
          "px-3 h-8 inline-flex items-center gap-1 rounded-lg text-sm " +
          (activeGroup
            ? "text-op-text bg-op-bg"
            : "text-op-muted hover:text-op-text hover:bg-op-bg")
        }
      >
        {label}
        <svg
          width="12"
          height="12"
          viewBox="0 0 12 12"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          className={"transition-transform " + (open ? "rotate-180" : "")}
          aria-hidden
        >
          <path d="M3 4.5 6 7.5 9 4.5" />
        </svg>
      </button>
      {open && (
        <div
          role="menu"
          className="absolute left-0 top-full mt-1 min-w-44 rounded-xl border border-op-border bg-op-surface shadow-lg py-1 z-30"
        >
          {items.map((it) => {
            const active =
              pathname === it.href || pathname?.startsWith(it.href + "/");
            return (
              <Link
                key={it.href}
                href={it.href}
                role="menuitem"
                className={
                  "block px-4 py-2 text-sm " +
                  (active
                    ? "bg-ink text-bone"
                    : "text-op-text hover:bg-op-bg")
                }
              >
                {it.label}
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
