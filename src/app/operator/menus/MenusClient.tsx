"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";

type Menu = {
  id: string;
  slug: string;
  label: string;
  description: string | null;
  sortOrder: number;
  categoryCount: number;
};

export function MenusClient({ menus: initialMenus }: { menus: Menu[] }) {
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
        alert(j.error ?? "No se pudo crear el menú.");
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
        alert("No se pudo renombrar.");
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
      alert("Debe haber al menos un menú.");
      return;
    }
    const target = menus.find((m) => m.id === menuId);
    if (!target) return;
    const msg =
      target.categoryCount > 0
        ? `¿Borrar "${target.label}"? Sus ${target.categoryCount} ${
            target.categoryCount === 1 ? "categoría" : "categorías"
          } se moverán al primer menú restante.`
        : `¿Borrar "${target.label}"?`;
    if (!window.confirm(msg)) return;
    setBusyId(menuId);
    try {
      const res = await fetch(`/api/operator/menus/${menuId}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        alert(j.error ?? "No se pudo borrar.");
        return;
      }
      setMenus((prev) => prev.filter((m) => m.id !== menuId));
      // Refresh categories of the deleted menu in editor view next time.
      startTx(() => router.refresh());
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="p-6 max-w-3xl mx-auto w-full">
      <div className="font-display text-3xl mb-1">Menús</div>
      <p className="text-sm text-op-muted mb-6">
        Un menú agrupa categorías. La mayoría de restaurantes tiene uno solo
        (<strong>Carta</strong>). Crea otro para vinos, cocteles, brunch — y
        el cliente verá pestañas para alternar entre ellos.
      </p>

      <div className="space-y-2 mb-6">
        {menus.map((m) => (
          <MenuRow
            key={m.id}
            menu={m}
            disabled={busyId !== null}
            busy={busyId === m.id}
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
          className="h-10 px-5 rounded-full bg-ink text-bone text-sm font-medium"
        >
          + Nuevo menú
        </button>
      )}

      <div className="mt-8 text-xs text-op-muted">
        Para mover una categoría a otro menú, abrila desde{" "}
        <Link href="/operator/menu" className="underline">
          Menú
        </Link>{" "}
        y usa el selector “Menú” en el header de la categoría.
      </div>
    </div>
  );
}

function MenuRow({
  menu,
  disabled,
  busy,
  onRename,
  onDelete,
}: {
  menu: Menu;
  disabled: boolean;
  busy: boolean;
  onRename: (label: string) => void;
  onDelete?: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(menu.label);

  return (
    <div className="bg-op-surface border border-op-border rounded-xl p-4 flex items-center gap-4">
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
          {menu.categoryCount}{" "}
          {menu.categoryCount === 1 ? "categoría" : "categorías"} ·{" "}
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
          Eliminar
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
          Nombre del menú
        </span>
        <input
          autoFocus
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          maxLength={40}
          placeholder="Carta de vinos · Cocteles · Brunch…"
          className="h-10 px-3 rounded-lg border border-op-border bg-op-bg text-sm"
        />
      </label>
      <label className="flex flex-col">
        <span className="font-mono text-[10px] tracking-[0.14em] uppercase text-op-muted mb-1">
          Descripción (opcional)
        </span>
        <input
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          maxLength={240}
          placeholder="Más de 180 referencias · Sommelier disponible"
          className="h-10 px-3 rounded-lg border border-op-border bg-op-bg text-sm"
        />
      </label>
      <div className="flex justify-end gap-2 pt-2">
        <button
          type="button"
          onClick={onCancel}
          className="h-9 px-4 rounded-full border border-op-border text-sm"
        >
          Cancelar
        </button>
        <button
          type="submit"
          disabled={busy || !label.trim()}
          className="h-9 px-5 rounded-full bg-ink text-bone text-sm font-medium disabled:opacity-60"
        >
          {busy ? "Creando…" : "Crear menú"}
        </button>
      </div>
    </form>
  );
}
