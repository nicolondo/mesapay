"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import type { NavEntry } from "./OperatorMobileMenu";
import { AppDialog } from "@/components/ui/AppDialog";
import { Icon, routeIcon } from "@/components/ui/Icon";
import {
  destinationsForNav,
  filterSearchLinks,
  type SearchLink,
} from "@/lib/operatorSearch";

export function NavigationSearch({ items }: { items: NavEntry[] }) {
  const t = useTranslations("workspaceUi");
  // Sin namespace: los destinos del registro traen su clave completa
  // ("opErp.tabUnpaid") porque reusan rótulos de namespaces distintos.
  const tAll = useTranslations();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (
        (e.metaKey || e.ctrlKey) &&
        e.key.toLowerCase() === "k" &&
        !document.querySelector("dialog[open]")
      ) {
        e.preventDefault();
        setQuery("");
        setOpen(true);
      }
    };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, []);
  const navLinks: SearchLink[] = items.flatMap((i) =>
    "children" in i
      ? i.children.map((c) => ({ ...c, group: i.label }))
      : [{ ...i, group: t("workspace") }],
  );
  // Subsecciones (pesta\u00f1as y subp\u00e1ginas) del registro central, s\u00f3lo las que
  // cuelgan de un \u00edtem presente en ESTE men\u00fa (m\u00f3dulos; en el admin, ninguna).
  const subLinks: SearchLink[] = destinationsForNav(
    navLinks.map((l) => l.href),
  ).map((dest) => ({
    href: dest.href,
    label: tAll(dest.labelKey),
    group: tAll(dest.groupKey),
    keywords: dest.keywordsKey ? tAll(dest.keywordsKey) : undefined,
    sub: true,
  }));
  const matches = filterSearchLinks([...navLinks, ...subLinks], query);
  return (
    <>
      <button
        type="button"
        className="mp-workspace-search"
        aria-label={t("findSection")}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={(event) => {
          event.currentTarget.focus({ preventScroll: true });
          setQuery("");
          setOpen(true);
        }}
        aria-keyshortcuts="Control+k Meta+k"
      >
        <Icon name="search" />
        <span>{t("findSection")}</span>
        <kbd aria-hidden="true">⌘ K</kbd>
      </button>
      {open && (
        <AppDialog
          label={t("findSection")}
          onClose={() => setOpen(false)}
          className="mp-command"
        >
          <div className="flex items-center gap-3 border-b border-op-border p-4">
            <Icon name="search" className="shrink-0 text-op-muted" />
            <input
              autoFocus
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                // Browsers may consume Escape to clear a search field before
                // the dialog receives cancel. One press should close search.
                if (e.key === "Escape") {
                  e.preventDefault();
                  e.stopPropagation();
                  setOpen(false);
                }
              }}
              placeholder={t("findSection")}
              aria-label={t("findSection")}
              className="min-w-0 flex-1 bg-transparent text-base outline-none"
            />
            <button
              className="mp-icon-button"
              onClick={() => setOpen(false)}
              aria-label={t("close")}
            >
              <Icon name="close" />
            </button>
          </div>
          <div className="max-h-[55dvh] overflow-y-auto p-2">
            {matches.length === 0 && (
              <p className="p-6 text-sm text-op-muted" role="status">
                {t("noSections")}
              </p>
            )}
            {matches.map((i) => (
              <Link
                key={i.href}
                href={i.href}
                prefetch={false}
                onClick={() => setOpen(false)}
                className="mp-command-result"
              >
                <Icon name={routeIcon(i.href)} />
                <span className="flex-1">
                  {i.label}
                  <span className="block text-xs text-op-muted">{i.group}</span>
                </span>
                <Icon name="arrow" />
              </Link>
            ))}
          </div>
        </AppDialog>
      )}
    </>
  );
}
