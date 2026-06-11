"use client";

import { useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import type { Locale } from "@/i18n/config";
import { formatDate } from "@/lib/format";
import type { MenuTag } from "@/lib/menuTags";
import { MAX_MENU_TAGS, SLUG_REGEX } from "@/lib/menuTags";

type Row = MenuTag & { tmpId: string };

export function TagsClient({ initial }: { initial: MenuTag[] }) {
  const tr = useTranslations("opSettings");
  const locale = useLocale() as Locale;
  const [rows, setRows] = useState<Row[]>(() =>
    initial.map((t, i) => ({ ...t, tmpId: `${t.slug}-${i}` })),
  );
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<Date | null>(null);
  const [error, setError] = useState<string | null>(null);

  function setLabel(tmpId: string, label: string) {
    setRows((prev) =>
      prev.map((r) =>
        r.tmpId === tmpId
          ? {
              ...r,
              label,
              // Auto-derive slug from label only when the slug looks
              // like it was system-generated (matches the slugified
              // label so far). The moment the user types something
              // custom, leave it alone.
              slug:
                r.slug === slugify(r.label) || r.slug === ""
                  ? slugify(label)
                  : r.slug,
            }
          : r,
      ),
    );
  }
  function setEmoji(tmpId: string, emoji: string) {
    setRows((prev) =>
      prev.map((r) => (r.tmpId === tmpId ? { ...r, emoji } : r)),
    );
  }
  function setSlug(tmpId: string, slug: string) {
    setRows((prev) =>
      prev.map((r) =>
        r.tmpId === tmpId ? { ...r, slug: slug.toLowerCase() } : r,
      ),
    );
  }
  function remove(tmpId: string) {
    setRows((prev) => prev.filter((r) => r.tmpId !== tmpId));
  }
  function add() {
    if (rows.length >= MAX_MENU_TAGS) return;
    setRows((prev) => [
      ...prev,
      {
        tmpId: `new-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        slug: "",
        label: "",
        emoji: "",
      },
    ]);
  }
  function move(tmpId: string, dir: -1 | 1) {
    setRows((prev) => {
      const i = prev.findIndex((r) => r.tmpId === tmpId);
      if (i < 0) return prev;
      const j = i + dir;
      if (j < 0 || j >= prev.length) return prev;
      const next = prev.slice();
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  }

  async function save() {
    setSaving(true);
    setError(null);
    setSavedAt(null);
    // Strip empty rows + tmpId before submitting. Empty emoji becomes
    // omitted (server schema treats it as optional).
    const payload = rows
      .map((r) => ({
        slug: r.slug.trim(),
        label: r.label.trim(),
        emoji: r.emoji?.trim() || undefined,
      }))
      .filter((r) => r.slug && r.label);

    // Pre-flight validation so the operator gets a friendly error
    // before the server scolds them.
    for (const t of payload) {
      if (!SLUG_REGEX.test(t.slug)) {
        setError(tr("tagsInvalidSlug", { slug: t.slug }));
        setSaving(false);
        return;
      }
    }
    const slugs = new Set<string>();
    for (const t of payload) {
      if (slugs.has(t.slug)) {
        setError(tr("tagsDuplicateSlug", { slug: t.slug }));
        setSaving(false);
        return;
      }
      slugs.add(t.slug);
    }

    try {
      const r = await fetch("/api/operator/menu-tags", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tags: payload }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        throw new Error(j.error ?? tr("tagsSaveFailed"));
      }
      setSavedAt(new Date());
    } catch (e) {
      setError(e instanceof Error ? e.message : tr("tagsSaveError"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <div className="bg-op-surface border border-op-border rounded-2xl overflow-hidden">
        <div className="grid grid-cols-[40px_70px_1fr_1fr_120px] gap-2 px-4 py-2 border-b border-op-border bg-op-bg/40">
          <div className="font-mono text-[9px] tracking-[0.14em] uppercase text-op-muted">
            {"#"}
          </div>
          <div className="font-mono text-[9px] tracking-[0.14em] uppercase text-op-muted">
            {tr("tagsColEmoji")}
          </div>
          <div className="font-mono text-[9px] tracking-[0.14em] uppercase text-op-muted">
            {tr("tagsColLabel")}
          </div>
          <div className="font-mono text-[9px] tracking-[0.14em] uppercase text-op-muted">
            {tr("tagsColSlug")}
          </div>
          <div />
        </div>
        {rows.length === 0 && (
          <div className="px-4 py-6 text-sm text-op-muted text-center">
            {tr("tagsEmptyRows")}
          </div>
        )}
        {rows.map((r, idx) => (
          <div
            key={r.tmpId}
            className="grid grid-cols-[40px_70px_1fr_1fr_120px] gap-2 px-4 py-2 items-center border-b border-op-border last:border-b-0"
          >
            <div className="flex flex-col">
              <button
                type="button"
                onClick={() => move(r.tmpId, -1)}
                disabled={idx === 0}
                className="text-op-muted hover:text-ink disabled:opacity-30 text-xs leading-none"
                aria-label={tr("tagsMoveUp")}
              >
                {"▲"}
              </button>
              <button
                type="button"
                onClick={() => move(r.tmpId, 1)}
                disabled={idx === rows.length - 1}
                className="text-op-muted hover:text-ink disabled:opacity-30 text-xs leading-none"
                aria-label={tr("tagsMoveDown")}
              >
                {"▼"}
              </button>
            </div>
            <input
              value={r.emoji ?? ""}
              onChange={(e) => setEmoji(r.tmpId, e.target.value)}
              maxLength={4}
              placeholder={tr("tagsEmojiPlaceholder")}
              className="h-9 px-2 rounded-lg border border-op-border bg-op-bg text-center text-base"
            />
            <input
              value={r.label}
              onChange={(e) => setLabel(r.tmpId, e.target.value)}
              maxLength={40}
              placeholder={tr("tagsLabelPlaceholder")}
              className="h-9 px-3 rounded-lg border border-op-border bg-op-bg text-sm"
            />
            <input
              value={r.slug}
              onChange={(e) => setSlug(r.tmpId, e.target.value)}
              maxLength={32}
              placeholder={tr("tagsSlugPlaceholder")}
              className="h-9 px-3 rounded-lg border border-op-border bg-op-bg text-xs font-mono"
            />
            <div className="text-right">
              <button
                type="button"
                onClick={() => remove(r.tmpId)}
                className="text-[11px] text-danger hover:underline"
              >
                {tr("tagsRemove")}
              </button>
            </div>
          </div>
        ))}
      </div>

      <div className="mt-3 flex items-center justify-between flex-wrap gap-3">
        <button
          type="button"
          onClick={add}
          disabled={rows.length >= MAX_MENU_TAGS}
          className="h-10 px-4 rounded-full bg-op-surface border border-op-border text-sm font-medium disabled:opacity-50"
        >
          {tr("tagsAddNew")}
        </button>

        <div className="flex items-center gap-3">
          {error && (
            <span className="text-xs text-danger max-w-[260px]">{error}</span>
          )}
          {savedAt && !error && (
            <span className="text-xs text-op-muted">
              {tr("tagsSavedAt", {
                time: formatDate(savedAt, { locale, timeStyle: "medium" }),
              })}
            </span>
          )}
          <button
            type="button"
            onClick={save}
            disabled={saving}
            className="h-10 px-5 rounded-full bg-ink text-bone text-sm font-medium disabled:opacity-60"
          >
            {saving ? tr("tagsSaving") : tr("tagsSave")}
          </button>
        </div>
      </div>

      <div className="text-[11px] text-op-muted mt-4 space-y-1">
        <p>
          {tr.rich("tagsHelp", {
            strong: (chunks) => <strong>{chunks}</strong>,
          })}
        </p>
        <p>{tr("tagsMaxNote", { max: MAX_MENU_TAGS })}</p>
      </div>
    </div>
  );
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // strip accents
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 32);
}
