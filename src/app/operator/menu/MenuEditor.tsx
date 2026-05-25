"use client";

import { useState } from "react";
import { fmtCOP } from "@/lib/format";
import type { MenuTag } from "@/lib/menuTags";

type CategoryKind =
  | "starter"
  | "main"
  | "side"
  | "drink"
  | "dessert"
  | "other";
type PrepStation = "kitchen" | "bar" | "counter";
type Cat = {
  id: string;
  label: string;
  slug: string;
  kind: CategoryKind;
  prepStation: PrepStation;
  menuId: string;
};
type MenuRef = { id: string; label: string; slug: string };

const KIND_OPTIONS: { value: CategoryKind; label: string }[] = [
  { value: "starter", label: "Entradas" },
  { value: "main", label: "Fuertes" },
  { value: "side", label: "Acompañamientos" },
  { value: "drink", label: "Bebidas" },
  { value: "dessert", label: "Postres" },
  { value: "other", label: "Otro" },
];

const STATION_LABEL: Record<PrepStation, string> = {
  kitchen: "Cocina",
  bar: "Bar",
  counter: "Refri / mostrador",
};

type ModOpt = { label: string; priceDeltaCents?: number };
type ModifierDef = {
  id: string;
  label: string;
  type: "radio" | "checkbox";
  opts: ModOpt[];
  default?: string;
};
type Item = {
  id: string;
  categoryId: string;
  name: string;
  description: string;
  priceCents: number;
  available: boolean;
  photoUrl: string | null;
  tags: string[];
  modifiers: ModifierDef[];
  prepMinutes: number;
  prepStation: PrepStation | null;
};

// Tags are now configured per restaurant in /operator/settings/etiquetas
// and arrive via the `menuTags` prop. The hardcoded list that used to
// live here is gone — we render whatever the operator picked.

export function MenuEditor({
  menus,
  menuTags,
  categories: initialCategories,
  items: initialItems,
}: {
  menus: MenuRef[];
  // Lista de etiquetas del restaurante (resuelta server-side desde
  // Restaurant.menuTags). Si el operador no configuró nada llegan los
  // defaults — ver src/lib/menuTags.ts.
  menuTags: MenuTag[];
  categories: Cat[];
  items: Item[];
}) {
  // Local state for items + categories. We mutate on every CRUD op
  // instead of router.refresh() — refreshing re-renders the whole
  // page and bounces the operator's scroll position to the top, which
  // hurts a lot when editing a long menu (every delete/save loses
  // their place in the list).
  const [items, setItems] = useState<Item[]>(initialItems);
  const [categories, setCategories] = useState<Cat[]>(initialCategories);
  const [editingItem, setEditingItem] = useState<Item | null>(null);
  const [addingCategory, setAddingCategory] = useState(false);
  const [addingItemInCat, setAddingItemInCat] = useState<string | null>(null);
  // Active menu tab. Only relevant when the restaurant has >1 menu.
  const [activeMenuId, setActiveMenuId] = useState<string>(
    menus[0]?.id ?? "",
  );

  // CRUD helpers passed to children. They return synchronously — the
  // child has already confirmed with the server before calling us.
  function addItem(item: Item) {
    setItems((prev) => [...prev, item]);
  }
  function replaceItem(item: Item) {
    setItems((prev) => prev.map((i) => (i.id === item.id ? item : i)));
  }
  function removeItem(itemId: string) {
    setItems((prev) => prev.filter((i) => i.id !== itemId));
  }
  function patchItem(itemId: string, patch: Partial<Item>) {
    setItems((prev) =>
      prev.map((i) => (i.id === itemId ? { ...i, ...patch } : i)),
    );
  }
  function addCategory(cat: Cat) {
    setCategories((prev) => [...prev, cat]);
  }
  function replaceCategory(cat: Cat) {
    setCategories((prev) => prev.map((c) => (c.id === cat.id ? cat : c)));
  }
  function removeCategory(catId: string) {
    setCategories((prev) => prev.filter((c) => c.id !== catId));
    // Items belonging to a deleted category go with it — DB cascade
    // does the same on the server.
    setItems((prev) => prev.filter((i) => i.categoryId !== catId));
  }

  const byCat = new Map<string, Item[]>();
  for (const c of categories) byCat.set(c.id, []);
  for (const it of items) byCat.get(it.categoryId)?.push(it);

  // When >1 menu we filter the visible category list by the active tab.
  // With a single menu we skip the tab strip entirely so existing
  // restaurants don't see any new chrome.
  const hasMultipleMenus = menus.length > 1;
  const visibleCategories = hasMultipleMenus
    ? categories.filter((c) => c.menuId === activeMenuId)
    : categories;

  return (
    <div className="p-6 max-w-5xl mx-auto w-full">
      <div className="flex items-center justify-between mb-5 flex-wrap gap-2">
        <div className="font-display text-3xl">Menú</div>
        <div className="flex items-center gap-2">
          <a
            // Pass the active menu so the import wizard lands the new
            // dishes in the tab the operator was looking at. Without
            // this it always defaulted to the first menu (Carta de
            // comida), which is what made the wine list end up under
            // food.
            href={
              hasMultipleMenus
                ? `/operator/menu/import?menu=${encodeURIComponent(activeMenuId)}`
                : "/operator/menu/import"
            }
            className="h-10 px-4 rounded-full border border-op-border text-sm font-medium inline-flex items-center gap-1.5 hover:bg-op-bg"
          >
            <span aria-hidden>🧠</span> Importar con AI
          </a>
          {!addingCategory && (
            <button
              onClick={() => setAddingCategory(true)}
              className="h-10 px-5 rounded-full bg-ink text-bone text-sm font-medium"
            >
              + Nueva categoría
            </button>
          )}
        </div>
      </div>

      {hasMultipleMenus && (
        <div className="mb-5 flex gap-2 flex-wrap">
          {menus.map((m) => {
            const active = m.id === activeMenuId;
            const count = categories.filter((c) => c.menuId === m.id).length;
            return (
              <button
                key={m.id}
                onClick={() => setActiveMenuId(m.id)}
                className={
                  "h-9 px-4 rounded-full text-sm font-medium border " +
                  (active
                    ? "bg-ink text-bone border-ink"
                    : "bg-op-surface text-op-text border-op-border")
                }
              >
                {m.label}
                <span className="ml-1.5 opacity-60 text-xs">{count}</span>
              </button>
            );
          })}
        </div>
      )}

      {addingCategory && (
        <div className="mb-5">
          <NewCategoryForm
            menuId={hasMultipleMenus ? activeMenuId : undefined}
            // The kind enum (Entradas / Fuertes / etc.) only describes
            // food sections, and the only feature reading kind is "Fuertes
            // juntos" — which by definition runs against the food carta.
            // For wine / cocktail / brunch menus the kind selector is
            // pure noise (and its labels look like food category names,
            // which confuses operators). Hide it for non-default menus.
            showKind={!hasMultipleMenus || activeMenuId === menus[0]?.id}
            onSave={(newCat) => {
              // New category lands in the active menu when there are
              // multiple; otherwise the server-side default (Carta) takes it.
              addCategory({
                ...newCat,
                menuId: hasMultipleMenus
                  ? activeMenuId
                  : (newCat.menuId ?? menus[0]?.id ?? ""),
              });
              setAddingCategory(false);
            }}
            onClose={() => setAddingCategory(false)}
          />
        </div>
      )}

      {visibleCategories.length === 0 && !addingCategory && (
        <div className="text-sm text-op-muted border border-dashed border-op-border rounded-xl p-8 text-center">
          {hasMultipleMenus
            ? "Este menú aún no tiene categorías. Crea una o mueve alguna desde otro menú."
            : "Todavía no tienes categorías. Crea la primera — por ejemplo, “Para empezar”, “Principales”, “Postres”."}
        </div>
      )}

      <div className="space-y-8">
        {visibleCategories.map((c) => {
          const rows = byCat.get(c.id) ?? [];
          return (
            <section key={c.id}>
              <div className="flex items-center justify-between mb-3">
                <CategoryHeader
                  cat={c}
                  menus={menus}
                  // Same rationale as NewCategoryForm — kind only makes
                  // sense for the food menu (it drives "Fuertes juntos").
                  showKind={c.menuId === menus[0]?.id}
                  onPatch={(patch) => replaceCategory({ ...c, ...patch })}
                  onDeleted={() => removeCategory(c.id)}
                />
                <div className="flex items-center gap-3">
                  <button
                    onClick={() => setAddingItemInCat(c.id)}
                    className="h-8 px-4 rounded-full bg-op-surface border border-op-border text-xs font-medium"
                  >
                    + Plato
                  </button>
                </div>
              </div>

              {addingItemInCat === c.id && (
                <div className="mb-3">
                  <NewItemForm
                    categoryId={c.id}
                    onSave={(newItem) => {
                      addItem(newItem);
                      setAddingItemInCat(null);
                    }}
                    onClose={() => setAddingItemInCat(null)}
                  />
                </div>
              )}

              <ul className="divide-y divide-op-border border border-op-border rounded-xl bg-op-surface overflow-hidden">
                {rows.length === 0 && addingItemInCat !== c.id && (
                  <li className="p-4 text-sm text-op-muted">
                    Sin platos todavía.
                  </li>
                )}
                {rows.map((it) => (
                  <li
                    key={it.id}
                    className={
                      "p-4 flex items-start gap-3 hover:bg-op-bg/50 " +
                      (it.available ? "" : "opacity-60")
                    }
                  >
                    <div
                      className="w-14 h-14 shrink-0 rounded-lg bg-op-bg bg-cover bg-center"
                      style={
                        it.photoUrl
                          ? { backgroundImage: `url(${it.photoUrl})` }
                          : undefined
                      }
                    />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-start justify-between gap-3">
                        <div className="font-medium truncate">{it.name}</div>
                        <div className="font-mono text-sm tabular shrink-0">
                          {fmtCOP(it.priceCents)}
                        </div>
                      </div>
                      {it.description && (
                        <div className="text-xs text-op-muted line-clamp-1 mt-0.5">
                          {it.description}
                        </div>
                      )}
                    </div>
                    <div className="shrink-0 flex items-center gap-3">
                      <AvailabilityToggle
                        item={it}
                        onChanged={(available) =>
                          patchItem(it.id, { available })
                        }
                      />
                      <button
                        onClick={() => setEditingItem(it)}
                        className="text-xs text-terracotta hover:underline"
                      >
                        Editar
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
      </div>

      {editingItem && (
        <ItemSheet
          item={editingItem}
          categories={categories}
          menuTags={menuTags}
          onClose={() => setEditingItem(null)}
          onSaved={(savedItem) => {
            replaceItem(savedItem);
            setEditingItem(null);
          }}
          onDeleted={(archivedAsUnavailable) => {
            if (archivedAsUnavailable) {
              // Server kept the row but flipped `available` because it
              // still appears in historical orders.
              patchItem(editingItem.id, { available: false });
            } else {
              removeItem(editingItem.id);
            }
            setEditingItem(null);
          }}
        />
      )}
    </div>
  );
}

function AvailabilityToggle({
  item,
  onChanged,
}: {
  item: Item;
  onChanged: (available: boolean) => void;
}) {
  const [available, setAvailable] = useState(item.available);
  const [busy, setBusy] = useState(false);

  async function toggle() {
    const next = !available;
    setAvailable(next);
    setBusy(true);
    const res = await fetch(`/api/operator/menu-items/${item.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ available: next }),
    });
    setBusy(false);
    if (!res.ok) {
      setAvailable(!next);
      alert("No se pudo cambiar la disponibilidad.");
      return;
    }
    onChanged(next);
  }

  return (
    <button
      onClick={toggle}
      disabled={busy}
      title={
        available
          ? "Disponible — click para marcar agotado"
          : "Agotado — click para reponer"
      }
      className={
        "h-7 px-3 rounded-full text-[11px] font-mono uppercase tracking-wider border transition " +
        (available
          ? "bg-ok/10 text-[#1E5339] border-ok/30 hover:bg-ok/20"
          : "bg-danger/10 text-danger border-danger/30 hover:bg-danger/20")
      }
    >
      {available ? "Disponible" : "Agotado"}
    </button>
  );
}

function NewCategoryForm({
  menuId,
  showKind,
  onSave,
  onClose,
}: {
  // Which menu the new category should belong to. Omitted → server
  // drops it into the restaurant's default (Carta).
  menuId: string | undefined;
  // When false the kind selector + Fuertes-juntos hint are hidden and
  // kind silently defaults to "other". Used for non-food menus (vinos,
  // cócteles, etc.) where the kind enum makes no sense.
  showKind: boolean;
  onSave: (newCat: Cat) => void;
  onClose: () => void;
}) {
  const [label, setLabel] = useState("");
  const [kind, setKind] = useState<CategoryKind>("other");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!label.trim()) return;
    setBusy(true);
    setErr(null);
    const res = await fetch("/api/operator/categories", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        label: label.trim(),
        kind,
        // Only include menuId when we've got one. The server's fallback
        // (ensureDefaultMenu) handles the legacy single-menu case.
        ...(menuId ? { menuId } : {}),
      }),
    });
    setBusy(false);
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      setErr(j.error ?? "Error");
      return;
    }
    const j = (await res.json()) as { id: string };
    // Slug isn't returned by the API; the server derives it from the
    // label the same way we do. We'll do an optimistic local copy and
    // accept a tiny mismatch risk — it doesn't drive any logic.
    onSave({
      id: j.id,
      label: label.trim(),
      slug: label
        .trim()
        .toLowerCase()
        .normalize("NFD")
        .replace(/[̀-ͯ]/g, "")
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, ""),
      kind,
      prepStation: "kitchen",
      // Parent overwrites this with the active menu if it has one.
      menuId: menuId ?? "",
    });
  }

  return (
    <form
      onSubmit={submit}
      className="bg-op-surface border border-op-border rounded-xl p-4 space-y-3"
    >
      <div className="flex items-end gap-3">
        <label className="flex-1 flex flex-col">
          <span className="font-mono text-[10px] tracking-[0.14em] uppercase text-op-muted mb-1">
            Nombre de la categoría
          </span>
          <input
            autoFocus
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            maxLength={40}
            placeholder="Para empezar, Principales, Postres…"
            className="h-10 px-3 rounded-lg border border-op-border bg-op-bg text-sm"
          />
        </label>
        {showKind && (
          <label className="w-48 flex flex-col">
            <span className="font-mono text-[10px] tracking-[0.14em] uppercase text-op-muted mb-1">
              Tipo
            </span>
            <select
              value={kind}
              onChange={(e) => setKind(e.target.value as CategoryKind)}
              className="h-10 px-2 rounded-lg border border-op-border bg-op-bg text-sm"
            >
              {KIND_OPTIONS.map((k) => (
                <option key={k.value} value={k.value}>
                  {k.label}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      {showKind && (
        <div className="text-[11px] text-op-muted">
          Marcar como <span className="font-medium">Fuertes</span> activa el modo
          “Fuertes juntos” cuando el comensal lo elige al pedir.
        </div>
      )}
      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={onClose}
          className="h-10 px-4 rounded-full border border-op-border text-sm"
        >
          Cancelar
        </button>
        <button
          type="submit"
          disabled={busy || !label.trim()}
          className="h-10 px-5 rounded-full bg-ink text-bone text-sm font-medium disabled:opacity-60"
        >
          {busy ? "Creando…" : "Crear"}
        </button>
      </div>
      {err && <div className="w-full text-danger text-xs">{err}</div>}
    </form>
  );
}

function CategoryHeader({
  cat,
  menus,
  showKind,
  onPatch,
  onDeleted,
}: {
  cat: Cat;
  menus: MenuRef[];
  // Hide the kind dropdown for categories that live in a non-default
  // menu (vinos, cócteles, etc.). See NewCategoryForm for the why.
  showKind: boolean;
  onPatch: (patch: Partial<Cat>) => void;
  onDeleted: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [label, setLabel] = useState(cat.label);
  const [busy, setBusy] = useState(false);

  async function save() {
    const trimmed = label.trim();
    if (!trimmed || trimmed === cat.label) {
      setEditing(false);
      return;
    }
    setBusy(true);
    const res = await fetch(`/api/operator/categories/${cat.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ label: trimmed }),
    });
    setBusy(false);
    if (!res.ok) {
      alert("No se pudo renombrar.");
      return;
    }
    setEditing(false);
    onPatch({ label: trimmed });
  }

  async function changeKind(kind: CategoryKind) {
    if (kind === cat.kind) return;
    const res = await fetch(`/api/operator/categories/${cat.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind }),
    });
    if (!res.ok) {
      alert("No se pudo cambiar el tipo.");
      return;
    }
    onPatch({ kind });
  }

  async function changeMenu(menuId: string) {
    if (menuId === cat.menuId) return;
    const res = await fetch(`/api/operator/categories/${cat.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ menuId }),
    });
    if (!res.ok) {
      alert("No se pudo cambiar de menú.");
      return;
    }
    // Parent's replaceCategory uses this patch to update local state.
    // The category will disappear from the current tab and appear under
    // the new menu — that's the expected UX when moving categories.
    onPatch({ menuId });
  }

  async function del() {
    const ok = window.confirm(`¿Eliminar la categoría "${cat.label}"?`);
    if (!ok) return;
    const res = await fetch(`/api/operator/categories/${cat.id}`, {
      method: "DELETE",
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      alert(j.error ?? "No se pudo eliminar.");
      return;
    }
    onDeleted();
  }

  if (editing) {
    return (
      <div className="flex items-center gap-2">
        <input
          autoFocus
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          maxLength={40}
          className="h-9 px-2 rounded-lg border border-op-border bg-op-bg text-lg font-display"
        />
        <button
          onClick={save}
          disabled={busy}
          className="text-xs text-terracotta font-medium"
        >
          Guardar
        </button>
        <button
          onClick={() => {
            setEditing(false);
            setLabel(cat.label);
          }}
          className="text-xs text-op-muted"
        >
          Cancelar
        </button>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-3 flex-wrap">
      <div className="font-display text-2xl">{cat.label}</div>
      {showKind && (
        <select
          value={cat.kind}
          onChange={(e) => changeKind(e.target.value as CategoryKind)}
          title="Tipo de categoría — los fuertes controlan el modo ‘Fuertes juntos’"
          className="h-7 px-1.5 rounded border border-op-border bg-op-bg text-[11px]"
        >
          {KIND_OPTIONS.map((k) => (
            <option key={k.value} value={k.value}>
              {k.label}
            </option>
          ))}
        </select>
      )}
      {menus.length > 1 && (
        <select
          value={cat.menuId}
          onChange={(e) => changeMenu(e.target.value)}
          title="Menú al que pertenece esta categoría"
          className="h-7 px-1.5 rounded border border-op-border bg-op-bg text-[11px]"
        >
          {menus.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </select>
      )}
      <button
        onClick={() => setEditing(true)}
        className="text-[11px] text-op-muted hover:text-ink"
      >
        Renombrar
      </button>
      <button
        onClick={del}
        className="text-[11px] text-op-muted hover:text-danger"
      >
        Eliminar
      </button>
    </div>
  );
}

function NewItemForm({
  categoryId,
  onSave,
  onClose,
}: {
  categoryId: string;
  onSave: (newItem: Item) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState("");
  const [price, setPrice] = useState("");
  const [description, setDescription] = useState("");
  const [prepMinutes, setPrepMinutes] = useState("10");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const cents = Math.round(Number(price) * 100);
    const mins = Math.round(Number(prepMinutes));
    if (!name.trim() || !Number.isFinite(cents) || cents < 0) {
      setErr("Revisa el nombre y el precio.");
      return;
    }
    if (!Number.isFinite(mins) || mins < 1 || mins > 120) {
      setErr("Tiempo de preparación entre 1 y 120 minutos.");
      return;
    }
    setErr(null);
    setBusy(true);
    const res = await fetch("/api/operator/menu-items", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        categoryId,
        name: name.trim(),
        priceCents: cents,
        description: description.trim() || undefined,
        prepMinutes: mins,
      }),
    });
    setBusy(false);
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      setErr(j.error ?? "Error");
      return;
    }
    const j = (await res.json()) as { id: string };
    onSave({
      id: j.id,
      categoryId,
      name: name.trim(),
      description: description.trim(),
      priceCents: cents,
      available: true,
      photoUrl: null,
      tags: [],
      modifiers: [],
      prepMinutes: mins,
      prepStation: null,
    });
  }

  return (
    <form
      onSubmit={submit}
      className="bg-op-surface border border-op-border rounded-xl p-4 space-y-3"
    >
      <div className="flex gap-3">
        <label className="flex flex-col flex-1">
          <span className="font-mono text-[10px] tracking-[0.14em] uppercase text-op-muted mb-1">
            Nombre
          </span>
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={60}
            className="h-10 px-3 rounded-lg border border-op-border bg-op-bg text-sm"
          />
        </label>
        <label className="flex flex-col w-32">
          <span className="font-mono text-[10px] tracking-[0.14em] uppercase text-op-muted mb-1">
            Precio (COP)
          </span>
          <input
            type="number"
            value={price}
            onChange={(e) => setPrice(e.target.value)}
            min={0}
            step={100}
            placeholder="25000"
            className="h-10 px-3 rounded-lg border border-op-border bg-op-bg text-sm"
          />
        </label>
        <label className="flex flex-col w-24">
          <span className="font-mono text-[10px] tracking-[0.14em] uppercase text-op-muted mb-1">
            Prep (min)
          </span>
          <input
            type="number"
            value={prepMinutes}
            onChange={(e) => setPrepMinutes(e.target.value)}
            min={1}
            max={120}
            step={1}
            className="h-10 px-3 rounded-lg border border-op-border bg-op-bg text-sm"
          />
        </label>
      </div>
      <label className="flex flex-col">
        <span className="font-mono text-[10px] tracking-[0.14em] uppercase text-op-muted mb-1">
          Descripción (opcional)
        </span>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          maxLength={240}
          rows={2}
          className="px-3 py-2 rounded-lg border border-op-border bg-op-bg text-sm"
        />
      </label>
      {err && <div className="text-danger text-xs">{err}</div>}
      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={onClose}
          className="h-9 px-4 rounded-full border border-op-border text-sm"
        >
          Cancelar
        </button>
        <button
          type="submit"
          disabled={busy}
          className="h-9 px-5 rounded-full bg-ink text-bone text-sm font-medium disabled:opacity-60"
        >
          {busy ? "Creando…" : "Crear plato"}
        </button>
      </div>
    </form>
  );
}

function ItemSheet({
  item,
  categories,
  menuTags,
  onClose,
  onSaved,
  onDeleted,
}: {
  item: Item;
  categories: Cat[];
  menuTags: MenuTag[];
  onClose: () => void;
  onSaved: (saved: Item) => void;
  // The server may "archive" a delete (set available=false) if the item
  // is referenced by past orders. The boolean tells the parent which
  // local mutation to run.
  onDeleted: (archivedAsUnavailable: boolean) => void;
}) {
  const [name, setName] = useState(item.name);
  const [priceCents, setPriceCents] = useState(String(item.priceCents / 100));
  const [description, setDescription] = useState(item.description);
  const [categoryId, setCategoryId] = useState(item.categoryId);
  const [available, setAvailable] = useState(item.available);
  const [photoUrl, setPhotoUrl] = useState(item.photoUrl ?? "");
  const [tags, setTags] = useState<string[]>(item.tags);
  const [modifiers, setModifiers] = useState<ModifierDef[]>(item.modifiers);
  const [prepMinutes, setPrepMinutes] = useState(String(item.prepMinutes));
  // null = "use category default"; otherwise it's the per-item override.
  const [prepStation, setPrepStation] = useState<PrepStation | null>(
    item.prepStation,
  );
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function onPhotoPick(file: File) {
    setUploading(true);
    setErr(null);
    const form = new FormData();
    form.append("file", file);
    const res = await fetch("/api/operator/uploads", { method: "POST", body: form });
    setUploading(false);
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      setErr(j.error ?? "No pudimos subir la foto.");
      return;
    }
    const { url } = await res.json();
    setPhotoUrl(url);
  }

  async function save() {
    const cents = Math.round(Number(priceCents) * 100);
    const mins = Math.round(Number(prepMinutes));
    if (!name.trim() || !Number.isFinite(cents) || cents < 0) {
      setErr("Revisa el nombre y el precio.");
      return;
    }
    if (!Number.isFinite(mins) || mins < 1 || mins > 120) {
      setErr("Tiempo de preparación entre 1 y 120 minutos.");
      return;
    }
    for (const m of modifiers) {
      if (!m.label.trim() || m.opts.length === 0) {
        setErr(`El modificador "${m.label || "(sin nombre)"}" necesita etiqueta y al menos una opción.`);
        return;
      }
    }
    setBusy(true);
    setErr(null);
    const res = await fetch(`/api/operator/menu-items/${item.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: name.trim(),
        priceCents: cents,
        description: description.trim() || null,
        categoryId,
        available,
        photoUrl: photoUrl.trim() || null,
        tags,
        modifiers: modifiers.length > 0 ? modifiers : null,
        prepMinutes: mins,
        prepStation,
      }),
    });
    setBusy(false);
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      setErr(j.error ?? "Error");
      return;
    }
    // Hand the updated item back to the parent — they patch local
    // state without a page refresh.
    onSaved({
      ...item,
      name: name.trim(),
      priceCents: cents,
      description: description.trim(),
      categoryId,
      available,
      photoUrl: photoUrl.trim() || null,
      tags,
      modifiers,
      prepMinutes: mins,
      prepStation,
    });
  }

  async function del() {
    // We tell the operator up-front that historic-orders items will be
    // archived instead of hard-deleted, so the post-delete alert that
    // used to surprise them is no longer needed.
    const ok = window.confirm(
      `¿Eliminar "${item.name}"?\n\n` +
        `Si aparece en pedidos anteriores no se puede borrar del todo — ` +
        `lo dejaremos archivado (deja de mostrarse en la carta del cliente).`,
    );
    if (!ok) return;
    setBusy(true);
    const res = await fetch(`/api/operator/menu-items/${item.id}`, {
      method: "DELETE",
    });
    setBusy(false);
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      alert(j.error ?? "Error");
      return;
    }
    const j = await res.json().catch(() => ({}));
    onDeleted(!!j.archived);
  }

  /**
   * Archivar es el camino explícito para que un plato deje de mostrarse
   * en la carta sin intentar borrarlo (útil para platos de temporada o
   * para los que tienen historial y nunca se podrían hard-delete-ear de
   * todas formas). Internamente sólo apaga `available`. El operador
   * puede volverlo a habilitar con el checkbox "Disponible" más arriba.
   */
  async function archive() {
    setBusy(true);
    const res = await fetch(`/api/operator/menu-items/${item.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ available: false }),
    });
    setBusy(false);
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      alert(j.error ?? "No se pudo archivar.");
      return;
    }
    // Reuse the "archived" branch in the parent — keeps the row in
    // local state with available=false (the operator can find it and
    // re-enable from the Disponible checkbox later).
    onDeleted(true);
  }

  function toggleTag(t: string) {
    setTags((prev) =>
      prev.includes(t) ? prev.filter((x) => x !== t) : [...prev, t],
    );
  }

  return (
    <div
      className="fixed inset-0 z-40 bg-black/50 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-op-surface text-op-text w-full max-w-xl max-h-[92vh] rounded-2xl overflow-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-6 space-y-4">
          <div className="flex items-start justify-between gap-3">
            <div className="font-display text-2xl">Editar plato</div>
            <button
              onClick={onClose}
              className="w-9 h-9 rounded-full border border-op-border"
            >
              ×
            </button>
          </div>

          <div className="flex gap-3">
            <label className="flex-1 flex flex-col">
              <span className="font-mono text-[10px] tracking-[0.14em] uppercase text-op-muted mb-1">
                Nombre
              </span>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={60}
                className="h-10 px-3 rounded-lg border border-op-border bg-op-bg text-sm"
              />
            </label>
            <label className="w-32 flex flex-col">
              <span className="font-mono text-[10px] tracking-[0.14em] uppercase text-op-muted mb-1">
                Precio (COP)
              </span>
              <input
                type="number"
                value={priceCents}
                onChange={(e) => setPriceCents(e.target.value)}
                min={0}
                step={100}
                className="h-10 px-3 rounded-lg border border-op-border bg-op-bg text-sm"
              />
            </label>
            <label className="w-24 flex flex-col">
              <span className="font-mono text-[10px] tracking-[0.14em] uppercase text-op-muted mb-1">
                Prep (min)
              </span>
              <input
                type="number"
                value={prepMinutes}
                onChange={(e) => setPrepMinutes(e.target.value)}
                min={1}
                max={120}
                step={1}
                className="h-10 px-3 rounded-lg border border-op-border bg-op-bg text-sm"
              />
            </label>
          </div>

          <label className="flex flex-col">
            <span className="font-mono text-[10px] tracking-[0.14em] uppercase text-op-muted mb-1">
              Descripción
            </span>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={240}
              rows={3}
              className="px-3 py-2 rounded-lg border border-op-border bg-op-bg text-sm"
            />
          </label>

          <div className="flex flex-col">
            <span className="font-mono text-[10px] tracking-[0.14em] uppercase text-op-muted mb-1">
              Foto
            </span>
            <div className="flex items-center gap-3">
              <div
                className="w-20 h-20 rounded-lg bg-op-bg border border-op-border bg-cover bg-center shrink-0"
                style={
                  photoUrl ? { backgroundImage: `url(${photoUrl})` } : undefined
                }
              />
              <div className="flex flex-col gap-1.5">
                <label className="inline-flex items-center justify-center h-9 px-4 rounded-lg border border-op-border bg-op-bg text-sm font-medium cursor-pointer hover:bg-ink/5">
                  {uploading ? "Subiendo…" : photoUrl ? "Cambiar foto" : "Subir foto"}
                  <input
                    type="file"
                    accept="image/jpeg,image/png,image/webp"
                    disabled={uploading}
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) onPhotoPick(f);
                      e.target.value = "";
                    }}
                    className="hidden"
                  />
                </label>
                {photoUrl && (
                  <button
                    type="button"
                    onClick={() => setPhotoUrl("")}
                    className="text-xs text-danger hover:underline text-left"
                  >
                    Quitar foto
                  </button>
                )}
                <div className="text-[11px] text-op-muted">
                  JPG, PNG o WebP · máx 5MB
                </div>
              </div>
            </div>
          </div>

          <label className="flex flex-col">
            <span className="font-mono text-[10px] tracking-[0.14em] uppercase text-op-muted mb-1">
              Categoría
            </span>
            <select
              value={categoryId}
              onChange={(e) => setCategoryId(e.target.value)}
              className="h-10 px-3 rounded-lg border border-op-border bg-op-bg text-sm"
            >
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </select>
          </label>

          {/* Per-item station override. The default option pulls in the
              current category's station so the operator can see what
              "inherit" actually means right now. */}
          {(() => {
            const inheritedStation =
              categories.find((c) => c.id === categoryId)?.prepStation ??
              "kitchen";
            return (
              <label className="flex flex-col">
                <span className="font-mono text-[10px] tracking-[0.14em] uppercase text-op-muted mb-1">
                  Estación
                </span>
                <select
                  value={prepStation ?? ""}
                  onChange={(e) =>
                    setPrepStation(
                      e.target.value === ""
                        ? null
                        : (e.target.value as PrepStation),
                    )
                  }
                  className="h-10 px-3 rounded-lg border border-op-border bg-op-bg text-sm"
                >
                  <option value="">
                    Usar la de la categoría ({STATION_LABEL[inheritedStation]})
                  </option>
                  <option value="kitchen">Cocina</option>
                  <option value="bar">Bar</option>
                  <option value="counter">Refri / mostrador</option>
                </select>
                <span className="text-[11px] text-op-muted mt-1">
                  Sirve para casos como “jugo natural” en una categoría que en
                  general va al bar pero este específico va a cocina.
                </span>
              </label>
            );
          })()}

          <div>
            <div className="font-mono text-[10px] tracking-[0.14em] uppercase text-op-muted mb-2 flex items-center justify-between">
              <span>Etiquetas</span>
              <a
                href="/operator/settings/etiquetas"
                className="font-sans normal-case tracking-normal text-[11px] text-terracotta hover:underline"
              >
                Editar lista →
              </a>
            </div>
            {menuTags.length === 0 ? (
              <div className="text-[11px] text-op-muted border border-dashed border-op-border rounded-xl px-3 py-2">
                Aún no hay etiquetas configuradas. Crea las primeras en{" "}
                <a
                  href="/operator/settings/etiquetas"
                  className="text-terracotta hover:underline"
                >
                  Configuración → Etiquetas
                </a>
                .
              </div>
            ) : (
              <div className="flex gap-2 flex-wrap">
                {menuTags.map((t) => {
                  const active = tags.includes(t.slug);
                  return (
                    <button
                      key={t.slug}
                      onClick={() => toggleTag(t.slug)}
                      className={
                        "h-8 px-3 rounded-full text-xs border inline-flex items-center gap-1.5 " +
                        (active
                          ? "bg-ink text-bone border-ink"
                          : "bg-op-bg border-op-border text-op-text")
                      }
                    >
                      {t.emoji && <span aria-hidden>{t.emoji}</span>}
                      {t.label}
                    </button>
                  );
                })}
              </div>
            )}
            {/* Show any extra slugs the item carries that aren't in the
                current registry — typically because the operator
                renamed or deleted a tag. The button lets them clear it
                so it stops being sent on save. */}
            {tags
              .filter((t) => !menuTags.some((m) => m.slug === t))
              .map((orphan) => (
                <button
                  key={orphan}
                  onClick={() => toggleTag(orphan)}
                  className="mt-2 mr-2 h-8 px-3 rounded-full text-xs border bg-paper border-dashed border-op-border text-op-muted line-through"
                  title="Etiqueta ya no existe en tu configuración"
                >
                  {orphan} ✕
                </button>
              ))}
          </div>

          <ModifiersEditor modifiers={modifiers} onChange={setModifiers} />

          <label className="flex items-center gap-3">
            <input
              type="checkbox"
              checked={available}
              onChange={(e) => setAvailable(e.target.checked)}
              className="w-4 h-4"
            />
            <span className="text-sm">Disponible (se muestra en el menú)</span>
          </label>

          {err && <div className="text-danger text-sm">{err}</div>}

          <div className="flex items-center justify-between pt-2 border-t border-op-border">
            <div className="flex items-center gap-3">
              <button
                onClick={del}
                disabled={busy}
                className="text-sm text-danger hover:underline disabled:opacity-60"
              >
                Eliminar
              </button>
              {available && (
                <button
                  onClick={archive}
                  disabled={busy}
                  className="text-sm text-op-muted hover:underline disabled:opacity-60"
                  title="Deja de mostrarse en la carta del cliente sin borrarlo"
                >
                  Archivar
                </button>
              )}
            </div>
            <div className="flex gap-2">
              <button
                onClick={onClose}
                disabled={busy}
                className="h-10 px-4 rounded-full border border-op-border text-sm"
              >
                Cancelar
              </button>
              <button
                onClick={save}
                disabled={busy}
                className="h-10 px-5 rounded-full bg-ink text-bone text-sm font-medium disabled:opacity-60"
              >
                {busy ? "Guardando…" : "Guardar"}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function slugifyMod(s: string) {
  return (
    s
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 40) || "mod"
  );
}

function ModifiersEditor({
  modifiers,
  onChange,
}: {
  modifiers: ModifierDef[];
  onChange: (m: ModifierDef[]) => void;
}) {
  function add() {
    const base = "opcion";
    let id = base;
    let n = 2;
    while (modifiers.some((m) => m.id === id)) id = `${base}-${n++}`;
    onChange([
      ...modifiers,
      { id, label: "", type: "radio", opts: [], default: undefined },
    ]);
  }

  function update(ix: number, patch: Partial<ModifierDef>) {
    onChange(modifiers.map((m, i) => (i === ix ? { ...m, ...patch } : m)));
  }

  function remove(ix: number) {
    onChange(modifiers.filter((_, i) => i !== ix));
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <div className="font-mono text-[10px] tracking-[0.14em] uppercase text-op-muted">
          Modificadores
        </div>
        <button
          type="button"
          onClick={add}
          className="text-xs text-terracotta hover:underline"
        >
          + Añadir
        </button>
      </div>
      {modifiers.length === 0 && (
        <div className="text-xs text-op-muted">
          Sin modificadores. Por ejemplo: nivel de picante, tamaño, guarnición.
        </div>
      )}
      <div className="space-y-3">
        {modifiers.map((m, i) => (
          <div
            key={i}
            className="border border-op-border rounded-lg p-3 bg-op-bg/50 space-y-2"
          >
            <div className="flex gap-2 items-end">
              <label className="flex-1 flex flex-col">
                <span className="font-mono text-[9px] tracking-[0.14em] uppercase text-op-muted mb-1">
                  Etiqueta
                </span>
                <input
                  value={m.label}
                  onChange={(e) => {
                    const label = e.target.value;
                    update(i, {
                      label,
                      id: m.id || slugifyMod(label),
                    });
                  }}
                  onBlur={(e) => {
                    if (!m.id && e.target.value) {
                      update(i, { id: slugifyMod(e.target.value) });
                    }
                  }}
                  maxLength={60}
                  placeholder="Nivel de picante, Tamaño…"
                  className="h-9 px-2 rounded border border-op-border bg-op-surface text-sm"
                />
              </label>
              <label className="flex flex-col">
                <span className="font-mono text-[9px] tracking-[0.14em] uppercase text-op-muted mb-1">
                  Tipo
                </span>
                <select
                  value={m.type}
                  onChange={(e) =>
                    update(i, { type: e.target.value as "radio" | "checkbox" })
                  }
                  className="h-9 px-2 rounded border border-op-border bg-op-surface text-sm"
                >
                  <option value="radio">Uno solo</option>
                  <option value="checkbox">Varias</option>
                </select>
              </label>
              <button
                type="button"
                onClick={() => remove(i)}
                className="h-9 px-2 text-xs text-op-muted hover:text-danger"
              >
                ×
              </button>
            </div>

            <OptionsEditor
              opts={m.opts}
              defaultOpt={m.default}
              canDefault={m.type === "radio"}
              onChange={(opts, def) =>
                update(i, {
                  opts,
                  default:
                    m.type === "radio"
                      ? def && opts.some((o) => o.label === def)
                        ? def
                        : undefined
                      : undefined,
                })
              }
            />
          </div>
        ))}
      </div>
    </div>
  );
}

function OptionsEditor({
  opts,
  defaultOpt,
  canDefault,
  onChange,
}: {
  opts: ModOpt[];
  defaultOpt: string | undefined;
  canDefault: boolean;
  onChange: (opts: ModOpt[], defaultOpt: string | undefined) => void;
}) {
  const [draft, setDraft] = useState("");

  function addDraft() {
    const v = draft.trim();
    if (!v || opts.some((o) => o.label === v)) {
      setDraft("");
      return;
    }
    onChange([...opts, { label: v }], defaultOpt);
    setDraft("");
  }

  function removeAt(ix: number) {
    const next = opts.filter((_, i) => i !== ix);
    const nextDefault =
      defaultOpt && next.some((o) => o.label === defaultOpt)
        ? defaultOpt
        : undefined;
    onChange(next, nextDefault);
  }

  function setOptPrice(ix: number, raw: string) {
    // The price field is in COP-pesos (whole numbers), to match the
    // dish-price input above it. Empty / non-numeric clears the delta.
    const pesos = raw.trim() === "" ? null : Number(raw);
    let delta: number | undefined;
    if (pesos === null || !Number.isFinite(pesos) || pesos === 0) {
      delta = undefined;
    } else {
      delta = Math.round(pesos * 100);
    }
    const next = opts.map((o, i) =>
      i === ix
        ? delta === undefined
          ? { label: o.label }
          : { label: o.label, priceDeltaCents: delta }
        : o,
    );
    onChange(next, defaultOpt);
  }

  return (
    <div>
      <div className="space-y-1.5">
        {opts.map((o, i) => {
          const isDefault = canDefault && o.label === defaultOpt;
          const deltaPesos =
            o.priceDeltaCents != null ? o.priceDeltaCents / 100 : "";
          return (
            <div
              key={o.label}
              className={
                "flex items-center gap-2 rounded-lg border px-2 py-1.5 " +
                (isDefault
                  ? "bg-ink/5 border-ink/30"
                  : "bg-op-surface border-op-border")
              }
            >
              <span className="flex-1 text-sm truncate">{o.label}</span>
              <div className="flex items-center gap-1 text-xs text-op-muted shrink-0">
                <span>+</span>
                <input
                  type="number"
                  value={deltaPesos}
                  onChange={(e) => setOptPrice(i, e.target.value)}
                  placeholder="0"
                  step={100}
                  className="w-20 h-7 px-2 rounded border border-op-border bg-op-bg text-right tabular text-xs"
                  title="Costo adicional (COP). Vacío = sin recargo."
                />
              </div>
              {canDefault && !isDefault && (
                <button
                  type="button"
                  onClick={() => onChange(opts, o.label)}
                  className="text-[9px] uppercase tracking-wider text-op-muted hover:text-ink px-1.5 shrink-0"
                  title="Marcar como opción por defecto"
                >
                  default
                </button>
              )}
              {isDefault && (
                <span className="text-[9px] uppercase tracking-wider text-ink shrink-0 px-1.5">
                  default
                </span>
              )}
              <button
                type="button"
                onClick={() => removeAt(i)}
                className="w-6 h-6 rounded-full hover:bg-op-border/40 inline-flex items-center justify-center text-op-muted shrink-0"
                aria-label={`Quitar ${o.label}`}
              >
                ×
              </button>
            </div>
          );
        })}
      </div>
      <div className="mt-2 flex gap-2">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              addDraft();
            }
          }}
          maxLength={60}
          placeholder="Añadir opción y Enter"
          className="flex-1 h-8 px-2 rounded border border-op-border bg-op-surface text-xs"
        />
        <button
          type="button"
          onClick={addDraft}
          className="h-8 px-3 rounded-full bg-op-border/40 text-xs"
        >
          Añadir
        </button>
      </div>
    </div>
  );
}
