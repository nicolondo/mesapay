"use client";

import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";

/** Ítems del menú, en orden (para mover el foco con el teclado). */
function menuItems(menu: HTMLElement | null): HTMLElement[] {
  return Array.from(menu?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);
}

export type SplitDownloadItem = {
  label: string;
  /** Enlace de descarga; sin él (o con `disabledReason`) el ítem queda deshabilitado. */
  href?: string;
  /** Motivo, en rojo bajo el rótulo, cuando el formato no se puede descargar. */
  disabledReason?: string;
};

/**
 * Descarga de un reporte en botón dividido: la descarga principal (Excel)
 * y, pegada, una flechita que despliega los demás formatos. Sin `items`
 * no hay flechita. Nació en la exógena (Excel + «Descargar XML», #570) y
 * la comparten los reportes con más de un formato.
 *
 * Teclado: la flechita es un botón de menú (`aria-haspopup`/`aria-expanded`);
 * Enter, Espacio o flecha abajo abren el menú y enfocan su primer ítem;
 * flechas, Inicio y Fin mueven el foco; Esc cierra y devuelve el foco a la
 * flechita; Tab o un click afuera cierran.
 */
export function SplitDownload({
  main,
  items = [],
  moreLabel,
}: {
  main: { href: string; label: string };
  items?: readonly SplitDownloadItem[];
  /** Nombre accesible de la flechita y del menú. */
  moreLabel: string;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const reasonId = useId();
  const hasMenu = items.length > 0;

  useEffect(() => {
    if (!open) return;
    menuItems(menuRef.current)[0]?.focus();
    const onDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!open) return;
    const list = menuItems(menuRef.current);
    const i = list.indexOf(document.activeElement as HTMLElement);
    const focusAt = (n: number) => list[(n + list.length) % list.length]?.focus();
    switch (e.key) {
      case "Escape":
        e.preventDefault();
        setOpen(false);
        toggleRef.current?.focus();
        break;
      case "Tab":
        setOpen(false);
        break;
      case "ArrowDown":
        e.preventDefault();
        focusAt(i + 1);
        break;
      case "ArrowUp":
        e.preventDefault();
        focusAt(i - 1);
        break;
      case "Home":
        e.preventDefault();
        focusAt(0);
        break;
      case "End":
        e.preventDefault();
        focusAt(list.length - 1);
        break;
    }
  };

  const itemCls = "flex w-full flex-col items-start px-3 py-2 text-left text-sm focus:outline-none";

  return (
    <div ref={rootRef} className="mp-split" onKeyDown={onKeyDown}>
      <a
        href={main.href}
        download
        className={`mp-btn mp-btn--secondary mp-btn--sm${hasMenu ? " mp-split__main" : ""}`}
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <path d="M8 2.5v8M4.5 7 8 10.5 11.5 7M3 13.5h10" />
        </svg>
        {main.label}
      </a>
      {hasMenu && (
        <>
          <button
            ref={toggleRef}
            type="button"
            aria-haspopup="menu"
            aria-expanded={open}
            aria-controls={open ? menuId : undefined}
            aria-label={moreLabel}
            title={moreLabel}
            onClick={() => setOpen((v) => !v)}
            onKeyDown={(e) => {
              if (!open && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
                e.preventDefault();
                setOpen(true);
              }
            }}
            className="mp-btn mp-btn--secondary mp-btn--sm mp-split__toggle"
          >
            <svg
              width="12"
              height="12"
              viewBox="0 0 12 12"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
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
              ref={menuRef}
              id={menuId}
              role="menu"
              aria-label={moreLabel}
              className="absolute left-0 right-0 top-full z-30 mt-1 overflow-hidden rounded-xl border border-op-border bg-op-surface py-1 shadow-lg"
            >
              {items.map((item, idx) =>
                !item.href || item.disabledReason ? (
                  <div
                    key={idx}
                    role="menuitem"
                    tabIndex={-1}
                    aria-disabled="true"
                    aria-describedby={item.disabledReason ? `${reasonId}-${idx}` : undefined}
                    className={`${itemCls} cursor-not-allowed text-op-muted focus:bg-op-bg`}
                  >
                    <span>{item.label}</span>
                    {item.disabledReason && (
                      <span id={`${reasonId}-${idx}`} className="mt-0.5 text-[11px] leading-snug text-danger">
                        {item.disabledReason}
                      </span>
                    )}
                  </div>
                ) : (
                  <a
                    key={idx}
                    role="menuitem"
                    tabIndex={-1}
                    href={item.href}
                    download
                    onClick={() => setOpen(false)}
                    onKeyDown={(e) => {
                      if (e.key === " ") {
                        e.preventDefault();
                        e.currentTarget.click();
                      }
                    }}
                    className={`${itemCls} text-op-text hover:bg-op-bg focus:bg-op-bg`}
                  >
                    {item.label}
                  </a>
                ),
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
