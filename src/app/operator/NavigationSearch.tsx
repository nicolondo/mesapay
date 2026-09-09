"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import type { NavEntry } from "./OperatorMobileMenu";
import { AppDialog } from "@/components/ui/AppDialog";
import { Icon, routeIcon } from "@/components/ui/Icon";

export function NavigationSearch({ items }: { items: NavEntry[] }) {
  const t = useTranslations("workspaceUi");
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
  const normalize = (s: string) =>
    s
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLocaleLowerCase();
  const links = items.flatMap((i) =>
    "children" in i
      ? i.children.map((c) => ({ ...c, group: i.label }))
      : [{ ...i, group: t("workspace") }],
  );
  const matches = links.filter((i) =>
    normalize(`${i.label} ${i.group}`).includes(normalize(query.trim())),
  );
  return (
    <>
      <button
        type="button"
        className="mp-workspace-search"
        aria-label={t("findSection")}
        onClick={() => {
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
