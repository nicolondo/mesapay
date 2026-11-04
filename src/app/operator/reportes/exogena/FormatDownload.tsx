"use client";

import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { useTranslations } from "next-intl";

/** Ítems del menú, en orden (para mover el foco con el teclado). */
function menuItems(menu: HTMLElement | null): HTMLElement[] {
  return Array.from(menu?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);
}

/**
 * Descarga de un formato de la exógena: botón principal «Descargar Excel»
 * y, pegada, una flechita que despliega «Descargar XML» (botón dividido).
 * El Excel se descarga siempre (con incidencias trae las filas marcadas);
 * con incidencias bloqueantes el XML queda deshabilitado con el motivo.
 * Sin XML (`xml` null, el 2276) no hay flechita.
 *
 * Teclado: la flechita es un botón de menú (`aria-haspopup`/`aria-expanded`);
 * Enter, Espacio o flecha abajo abren el menú y enfocan su primer ítem;
 * flechas, Inicio y Fin mueven el foco; Esc cierra y devuelve el foco a la
 * flechita; Tab o un click afuera cierran.
 */
export function FormatDownload({
  excelHref,
  xml,
}: {
  excelHref: string;
  xml: { href: string; blocked: boolean } | null;
}) {
  const t = useTranslations("opExogena");
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const reasonId = useId();

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
        href={excelHref}
        download
        className={`mp-btn mp-btn--secondary mp-btn--sm${xml ? " mp-split__main" : ""}`}
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
        {t("downloadExcel")}
      </a>
      {xml && (
        <>
          <button
            ref={toggleRef}
            type="button"
            aria-haspopup="menu"
            aria-expanded={open}
            aria-controls={open ? menuId : undefined}
            aria-label={t("downloadMore")}
            title={t("downloadMore")}
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
              aria-label={t("downloadMore")}
              className="absolute left-0 right-0 top-full z-30 mt-1 overflow-hidden rounded-xl border border-op-border bg-op-surface py-1 shadow-lg"
            >
              {xml.blocked ? (
                <div
                  role="menuitem"
                  tabIndex={-1}
                  aria-disabled="true"
                  aria-describedby={reasonId}
                  className={`${itemCls} cursor-not-allowed text-op-muted focus:bg-op-bg`}
                >
                  <span>{t("downloadXml")}</span>
                  <span id={reasonId} className="mt-0.5 text-[11px] leading-snug text-danger">
                    {t("downloadBlocked")}
                  </span>
                </div>
              ) : (
                <a
                  role="menuitem"
                  tabIndex={-1}
                  href={xml.href}
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
                  {t("downloadXml")}
                </a>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
