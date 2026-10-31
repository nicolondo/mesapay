"use client";
import { useEffect, useRef } from "react";
import { useTranslations } from "next-intl";
import { HelpIcon } from "./HelpIcon";

/**
 * Buscador compacto de las páginas de categoría y de artículo: un formulario
 * GET a la portada de la ayuda (`?q=`), donde vive el índice. Así el índice
 * sólo viaja a la portada. Funciona sin JavaScript; con JavaScript suma el
 * atajo "/".
 */
export function HelpSearchLauncher({ action }: { action: string }) {
  const t = useTranslations("help");
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return;
      const el = e.target as HTMLElement | null;
      if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))) return;
      e.preventDefault();
      ref.current?.focus();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <form role="search" action={action} method="get" className="relative">
      <label htmlFor="help-search-launcher" className="sr-only">
        {t("searchLabel")}
      </label>
      <HelpIcon
        name="search"
        className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-op-muted"
      />
      <input
        id="help-search-launcher"
        ref={ref}
        type="search"
        name="q"
        required
        autoComplete="off"
        enterKeyHint="search"
        placeholder={t("searchPlaceholderShort")}
        className="h-11 w-full rounded-xl border border-op-border bg-op-surface pl-10 pr-10 text-base text-op-text outline-none placeholder:text-op-muted focus:border-op-accent focus:ring-2 focus:ring-op-accent/20 sm:text-sm"
      />
      <kbd
        aria-hidden="true"
        className="pointer-events-none absolute right-3 top-1/2 hidden -translate-y-1/2 rounded-md border border-op-border bg-op-bg px-1.5 font-mono text-[11px] text-op-muted sm:block"
      >
        {"/"}
      </kbd>
    </form>
  );
}
