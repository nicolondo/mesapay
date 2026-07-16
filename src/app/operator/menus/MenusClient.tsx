"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useTranslations } from "next-intl";

type Menu = {
  id: string;
  slug: string;
  label: string;
  description: string | null;
  sortOrder: number;
  categoryCount: number;
};

export function MenusClient({ menus: initialMenus }: { menus: Menu[] }) {
  const t = useTranslations("opMenus");
  const router = useRouter();
  const [, startTx] = useTransition();
  const [menus, setMenus] = useState(initialMenus);
  const [creating, setCreating] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  async function createMenu(label: string, description: string) {
    setBusyId("__new__");
    try {
      const res = await fetch("/api/operator/menus", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          label,
          description: description || undefined,
        }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        alert(j.error ?? t("errCreate"));
        return;
      }
      const { menu } = await res.json();
      setMenus((prev) => [
        ...prev,
        {
          id: menu.id,
          slug: menu.slug,
          label: menu.label,
          description: menu.description,
          sortOrder: menu.sortOrder,
          categoryCount: 0,
        },
      ]);
      setCreating(false);
    } finally {
      setBusyId(null);
    }
  }

  async function renameMenu(menuId: string, label: string) {
    const trimmed = label.trim();
    if (!trimmed) return;
    setBusyId(menuId);
    try {
      const res = await fetch(`/api/operator/menus/${menuId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ label: trimmed }),
      });
      if (!res.ok) {
        alert(t("errRename"));
        return;
      }
      setMenus((prev) =>
        prev.map((m) => (m.id === menuId ? { ...m, label: trimmed } : m)),
      );
    } finally {
      setBusyId(null);
    }
  }

  async function deleteMenu(menuId: string) {
    if (menus.length <= 1) {
      alert(t("errAtLeastOne"));
      return;
    }
    const target = menus.find((m) => m.id === menuId);
    if (!target) return;
    const msg =
      target.categoryCount > 0
        ? t("confirmDeleteWithCats", {
            label: target.label,
            count: target.categoryCount,
          })
        : t("confirmDelete", { label: target.label });
    if (!window.confirm(msg)) return;
    setBusyId(menuId);
    try {
      const res = await fetch(`/api/operator/menus/${menuId}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        alert(j.error ?? t("errDelete"));
        return;
      }
      setMenus((prev) => prev.filter((m) => m.id !== menuId));
      // Refresh categories of the deleted menu in editor view next time.
      startTx(() => router.refresh());
    } finally {
      setBusyId(null);
    }
  }

  async function moveMenu(index: number, dir: "up" | "down") {
    const j = dir === "up" ? index - 1 : index + 1;
    if (j < 0 || j >= menus.length) return;
    const prev = menus;
    const reordered = [...menus];
    [reordered[index], reordered[j]] = [reordered[j], reordered[index]];
    // Renumeramos por posición y persistimos solo las cartas que cambiaron.
    const withOrder = reordered.map((m, i) => ({ ...m, sortOrder: i }));
    const oldOrder = new Map(prev.map((m) => [m.id, m.sortOrder]));
    const changed = withOrder.filter((m) => oldOrder.get(m.id) !== m.sortOrder);
    setMenus(withOrder); // optimista
    setBusyId("__reorder__");
    try {
      const results = await Promise.all(
        changed.map((m) =>
          fetch(`/api/operator/menus/${m.id}`, {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ sortOrder: m.sortOrder }),
          }),
        ),
      );
      if (results.some((r) => !r.ok)) {
        setMenus(prev); // revertir si algo falló
        alert(t("errReorder"));
      }
    } catch {
      setMenus(prev);
      alert(t("errReorder"));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="p-6 max-w-3xl mx-auto w-full">
      <div className="font-display text-3xl mb-1">{t("title")}</div>
      <p className="text-sm text-op-muted mb-6">
        {t.rich("intro", {
          strong: (chunks) => <strong>{chunks}</strong>,
        })}
      </p>

      <div className="space-y-2 mb-6">
        {menus.map((m, i) => (
          <MenuRow
            key={m.id}
            menu={m}
            disabled={busyId !== null}
            busy={busyId === m.id}
            showArrows={menus.length > 1}
            onMoveUp={i > 0 ? () => moveMenu(i, "up") : undefined}
            onMoveDown={
              i < menus.length - 1 ? () => moveMenu(i, "down") : undefined
            }
            onRename={(label) => renameMenu(m.id, label)}
            onDelete={
              menus.length > 1 ? () => deleteMenu(m.id) : undefined
            }
          />
        ))}
      </div>

      {creating ? (
        <NewMenuForm
          busy={busyId === "__new__"}
          onCancel={() => setCreating(false)}
          onSubmit={createMenu}
        />
      ) : (
        <button
          type="button"
          onClick={() => setCreating(true)}
          className="mp-btn mp-btn--sm mp-btn--primary"
        >
          {t("newMenu")}
        </button>
      )}

      <div className="mt-8 text-xs text-op-muted">
        {t.rich("moveCategoryHint", {
          link: (chunks) => (
            <Link href="/operator/menu" className="underline">
              {chunks}
            </Link>
          ),
        })}
      </div>
    </div>
  );
}

function MenuRow({
  menu,
  disabled,
  busy,
  showArrows,
  onMoveUp,
  onMoveDown,
  onRename,
  onDelete,
}: {
  menu: Menu;
  disabled: boolean;
  busy: boolean;
  showArrows: boolean;
  onMoveUp?: () => void;
  onMoveDown?: () => void;
  onRename: (label: string) => void;
  onDelete?: () => void;
}) {
  const t = useTranslations("opMenus");
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(menu.label);

  return (
    <div className="bg-op-surface border border-op-border rounded-xl p-4 flex items-center gap-4">
      {showArrows && (
        <div className="flex flex-col -my-1 shrink-0">
          <button
            type="button"
            aria-label={t("moveUp")}
            onClick={onMoveUp}
            disabled={disabled || !onMoveUp}
            className="h-5 w-6 leading-none text-base text-op-muted hover:text-ink disabled:opacity-25"
          >
            <span aria-hidden>↑</span>
          </button>
          <button
            type="button"
            aria-label={t("moveDown")}
            onClick={onMoveDown}
            disabled={disabled || !onMoveDown}
            className="h-5 w-6 leading-none text-base text-op-muted hover:text-ink disabled:opacity-25"
          >
            <span aria-hidden>↓</span>
          </button>
        </div>
      )}
      <div className="flex-1 min-w-0">
        {editing ? (
          <input
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => {
              if (draft.trim() && draft !== menu.label) onRename(draft);
              else setDraft(menu.label);
              setEditing(false);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                (e.target as HTMLInputElement).blur();
              } else if (e.key === "Escape") {
                setDraft(menu.label);
                setEditing(false);
              }
            }}
            maxLength={40}
            className="font-display text-lg w-full bg-transparent border-b border-op-border focus:outline-none focus:border-ink"
          />
        ) : (
          <button
            type="button"
            onClick={() => !disabled && setEditing(true)}
            className="font-display text-lg text-left hover:text-terracotta"
          >
            {menu.label}
          </button>
        )}
        <div className="text-xs text-op-muted mt-0.5 truncate">
          {t("categoryCount", { count: menu.categoryCount })} ·{" "}
          <code className="font-mono">/{menu.slug}</code>
        </div>
      </div>
      {busy && (
        <span className="font-mono text-[10px] uppercase tracking-wider text-op-muted">
          …
        </span>
      )}
      {onDelete && (
        <button
          type="button"
          onClick={onDelete}
          disabled={disabled}
          className="text-xs text-op-muted hover:text-danger disabled:opacity-50"
        >
          {t("delete")}
        </button>
      )}
    </div>
  );
}

function NewMenuForm({
  busy,
  onCancel,
  onSubmit,
}: {
  busy: boolean;
  onCancel: () => void;
  onSubmit: (label: string, description: string) => void;
}) {
  const t = useTranslations("opMenus");
  const [label, setLabel] = useState("");
  const [description, setDescription] = useState("");

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (!label.trim()) return;
        onSubmit(label.trim(), description.trim());
      }}
      className="bg-op-surface border border-op-border rounded-xl p-4 space-y-3"
    >
      <label className="flex flex-col">
        <span className="font-mono text-[10px] tracking-[0.14em] uppercase text-op-muted mb-1">
          {t("formNameLabel")}
        </span>
        <input
          autoFocus
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          maxLength={40}
          placeholder={t("formNamePlaceholder")}
          className="h-10 px-3 rounded-lg border border-op-border bg-op-bg text-sm"
        />
      </label>
      <label className="flex flex-col">
        <span className="font-mono text-[10px] tracking-[0.14em] uppercase text-op-muted mb-1">
          {t("formDescLabel")}
        </span>
        <input
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          maxLength={240}
          placeholder={t("formDescPlaceholder")}
          className="h-10 px-3 rounded-lg border border-op-border bg-op-bg text-sm"
        />
      </label>
      <div className="flex justify-end gap-2 pt-2">
        <button
          type="button"
          onClick={onCancel}
          className="mp-btn mp-btn--sm mp-btn--secondary"
        >
          {t("cancel")}
        </button>
        <button
          type="submit"
          disabled={busy || !label.trim()}
          className="mp-btn mp-btn--sm mp-btn--primary"
        >
          {busy ? t("creating") : t("createMenu")}
        </button>
      </div>
    </form>
  );
}
