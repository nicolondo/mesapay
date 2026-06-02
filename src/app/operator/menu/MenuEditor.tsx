"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
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

// CategoryKind enum survives in the schema and the API, but the editor
// only exposes the one distinction that drives product behaviour: is
// this the category of platos fuertes (used by Fuertes-juntos mode)?
// The other slugs (starter / side / drink / dessert) are accepted by
// the API for historical reasons but no longer surfaced anywhere — the
// editor only writes "main" or "other".

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
  const tr = useTranslations("opMenuEditor");
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
        <div className="font-display text-3xl">{tr("title")}</div>
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
            <span aria-hidden>🧠</span> {tr("importWithAi")}
          </a>
          {!addingCategory && (
            <button
              onClick={() => setAddingCategory(true)}
              className="h-10 px-5 rounded-full bg-ink text-bone text-sm font-medium"
            >
              {tr("newCategory")}
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
            ? tr("emptyMultiMenu")
            : tr("emptySingleMenu")}
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
                    {tr("addDish")}
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
                    {tr("noDishesYet")}
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
                        {tr("edit")}
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
  const tr = useTranslations("opMenuEditor");
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
      alert(tr("errToggleAvailability"));
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
          ? tr("availableTitle")
          : tr("soldOutTitle")
      }
      className={
        "h-7 px-3 rounded-full text-[11px] font-mono uppercase tracking-wider border transition " +
        (available
          ? "bg-ok/10 text-[#1E5339] border-ok/30 hover:bg-ok/20"
          : "bg-danger/10 text-danger border-danger/30 hover:bg-danger/20")
      }
    >
      {available ? tr("available") : tr("soldOut")}
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
  // When false the "platos fuertes" toggle is hidden (non-food menus
  // like vinos / cócteles never use the Fuertes-juntos serving flow).
  showKind: boolean;
  onSave: (newCat: Cat) => void;
  onClose: () => void;
}) {
  const tr = useTranslations("opMenuEditor");
  const [label, setLabel] = useState("");
  // Internally we still write to CategoryKind. Only "main" vs "other"
  // matters in product behaviour (drives Fuertes juntos), so we expose
  // a simple boolean and translate at submit time.
  const [isMainCourse, setIsMainCourse] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!label.trim()) return;
    setBusy(true);
    setErr(null);
    const kindToSave: CategoryKind = isMainCourse ? "main" : "other";
    const res = await fetch("/api/operator/categories", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        label: label.trim(),
        kind: kindToSave,
        // Only include menuId when we've got one. The server's fallback
        // (ensureDefaultMenu) handles the legacy single-menu case.
        ...(menuId ? { menuId } : {}),
      }),
    });
    setBusy(false);
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      setErr(j.error ?? tr("errGeneric"));
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
      kind: kindToSave,
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
            {tr("categoryNameLabel")}
          </span>
          <input
            autoFocus
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            maxLength={40}
            placeholder={tr("categoryNamePlaceholder")}
            className="h-10 px-3 rounded-lg border border-op-border bg-op-bg text-sm"
          />
        </label>
      </div>
      {showKind && (
        <label className="flex items-start gap-3 cursor-pointer">
          <input
            type="checkbox"
            checked={isMainCourse}
            onChange={(e) => setIsMainCourse(e.target.checked)}
            className="w-4 h-4 mt-0.5"
          />
          <span className="text-sm">
            <span className="font-medium">{tr("mainCourseLabel")}</span>
            <span className="block text-[11px] text-op-muted mt-0.5">
              {tr("mainCourseHelp")}
            </span>
          </span>
        </label>
      )}
      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={onClose}
          className="h-10 px-4 rounded-full border border-op-border text-sm"
        >
          {tr("cancel")}
        </button>
        <button
          type="submit"
          disabled={busy || !label.trim()}
          className="h-10 px-5 rounded-full bg-ink text-bone text-sm font-medium disabled:opacity-60"
        >
          {busy ? tr("creating") : tr("create")}
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
  const tr = useTranslations("opMenuEditor");
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
      alert(tr("errRename"));
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
      alert(tr("errChangeKind"));
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
      alert(tr("errChangeMenu"));
      return;
    }
    // Parent's replaceCategory uses this patch to update local state.
    // The category will disappear from the current tab and appear under
    // the new menu — that's the expected UX when moving categories.
    onPatch({ menuId });
  }

  async function del() {
    const ok = window.confirm(tr("confirmDeleteCategory", { label: cat.label }));
    if (!ok) return;
    const res = await fetch(`/api/operator/categories/${cat.id}`, {
      method: "DELETE",
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      alert(j.error ?? tr("errDeleteCategory"));
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
          {tr("save")}
        </button>
        <button
          onClick={() => {
            setEditing(false);
            setLabel(cat.label);
          }}
          className="text-xs text-op-muted"
        >
          {tr("cancel")}
        </button>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-3 flex-wrap">
      <div className="font-display text-2xl">{cat.label}</div>
      {showKind && (
        <label
          className="inline-flex items-center gap-1.5 h-7 px-2 rounded-full border border-op-border bg-op-bg text-[11px] cursor-pointer hover:bg-op-surface"
          title={tr("mainCourseTitle")}
        >
          <input
            type="checkbox"
            checked={cat.kind === "main"}
            onChange={(e) => changeKind(e.target.checked ? "main" : "other")}
            className="w-3 h-3"
          />
          <span>{tr("mainCourses")}</span>
        </label>
      )}
      {menus.length > 1 && (
        <select
          value={cat.menuId}
          onChange={(e) => changeMenu(e.target.value)}
          title={tr("categoryMenuTitle")}
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
        {tr("rename")}
      </button>
      <button
        onClick={del}
        className="text-[11px] text-op-muted hover:text-danger"
      >
        {tr("delete")}
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
  const tr = useTranslations("opMenuEditor");
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
      setErr(tr("errCheckNamePrice"));
      return;
    }
    if (!Number.isFinite(mins) || mins < 1 || mins > 120) {
      setErr(tr("errPrepRange"));
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
      setErr(j.error ?? tr("errGeneric"));
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
            {tr("fieldName")}
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
            {tr("fieldPrice")}
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
            {tr("fieldPrep")}
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
          {tr("fieldDescriptionOptional")}
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
          {tr("cancel")}
        </button>
        <button
          type="submit"
          disabled={busy}
          className="h-9 px-5 rounded-full bg-ink text-bone text-sm font-medium disabled:opacity-60"
        >
          {busy ? tr("creating") : tr("createDish")}
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
  const tr = useTranslations("opMenuEditor");
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
      setErr(j.error ?? tr("errPhotoUpload"));
      return;
    }
    const { url } = await res.json();
    setPhotoUrl(url);
  }

  async function save() {
    const cents = Math.round(Number(priceCents) * 100);
    const mins = Math.round(Number(prepMinutes));
    if (!name.trim() || !Number.isFinite(cents) || cents < 0) {
      setErr(tr("errCheckNamePrice"));
      return;
    }
    if (!Number.isFinite(mins) || mins < 1 || mins > 120) {
      setErr(tr("errPrepRange"));
      return;
    }
    for (const m of modifiers) {
      if (!m.label.trim() || m.opts.length === 0) {
        setErr(
          tr("errModifierIncomplete", {
            label: m.label || tr("unnamed"),
          }),
        );
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
      setErr(j.error ?? tr("errGeneric"));
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
    const ok = window.confirm(tr("confirmDeleteItem", { name: item.name }));
    if (!ok) return;
    setBusy(true);
    const res = await fetch(`/api/operator/menu-items/${item.id}`, {
      method: "DELETE",
    });
    setBusy(false);
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      alert(j.error ?? tr("errGeneric"));
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
      alert(j.error ?? tr("errArchive"));
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
            <div className="font-display text-2xl">{tr("editDish")}</div>
            <button
              onClick={onClose}
              aria-label={tr("close")}
              className="w-9 h-9 rounded-full border border-op-border"
            >
              <span aria-hidden>{"×"}</span>
            </button>
          </div>

          <div className="flex gap-3">
            <label className="flex-1 flex flex-col">
              <span className="font-mono text-[10px] tracking-[0.14em] uppercase text-op-muted mb-1">
                {tr("fieldName")}
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
                {tr("fieldPrice")}
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
                {tr("fieldPrep")}
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
              {tr("fieldDescription")}
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
              {tr("fieldPhoto")}
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
                  {uploading
                    ? tr("uploading")
                    : photoUrl
                      ? tr("changePhoto")
                      : tr("uploadPhoto")}
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
                    {tr("removePhoto")}
                  </button>
                )}
                <div className="text-[11px] text-op-muted">
                  {tr("photoHint")}
                </div>
              </div>
            </div>
          </div>

          <label className="flex flex-col">
            <span className="font-mono text-[10px] tracking-[0.14em] uppercase text-op-muted mb-1">
              {tr("fieldCategory")}
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
            const stationLabel: Record<PrepStation, string> = {
              kitchen: tr("stationKitchen"),
              bar: tr("stationBar"),
              counter: tr("stationCounter"),
            };
            return (
              <label className="flex flex-col">
                <span className="font-mono text-[10px] tracking-[0.14em] uppercase text-op-muted mb-1">
                  {tr("fieldStation")}
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
                    {tr("stationUseCategory", {
                      station: stationLabel[inheritedStation],
                    })}
                  </option>
                  <option value="kitchen">{tr("stationKitchen")}</option>
                  <option value="bar">{tr("stationBar")}</option>
                  <option value="counter">{tr("stationCounter")}</option>
                </select>
                <span className="text-[11px] text-op-muted mt-1">
                  {tr("stationHelp")}
                </span>
              </label>
            );
          })()}

          <div>
            <div className="font-mono text-[10px] tracking-[0.14em] uppercase text-op-muted mb-2 flex items-center justify-between">
              <span>{tr("tagsTitle")}</span>
              <a
                href="/operator/settings/etiquetas"
                className="font-sans normal-case tracking-normal text-[11px] text-terracotta hover:underline"
              >
                {tr("editList")}
              </a>
            </div>
            {menuTags.length === 0 ? (
              <div className="text-[11px] text-op-muted border border-dashed border-op-border rounded-xl px-3 py-2">
                {tr.rich("tagsEmpty", {
                  link: (chunks) => (
                    <a
                      href="/operator/settings/etiquetas"
                      className="text-terracotta hover:underline"
                    >
                      {chunks}
                    </a>
                  ),
                })}
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
                  title={tr("orphanTagTitle")}
                >
                  {orphan} <span aria-hidden>{"✕"}</span>
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
            <span className="text-sm">{tr("availableInMenu")}</span>
          </label>

          {err && <div className="text-danger text-sm">{err}</div>}

          <div className="flex items-center justify-between pt-2 border-t border-op-border">
            <div className="flex items-center gap-3">
              <button
                onClick={del}
                disabled={busy}
                className="text-sm text-danger hover:underline disabled:opacity-60"
              >
                {tr("delete")}
              </button>
              {available && (
                <button
                  onClick={archive}
                  disabled={busy}
                  className="text-sm text-op-muted hover:underline disabled:opacity-60"
                  title={tr("archiveTitle")}
                >
                  {tr("archive")}
                </button>
              )}
            </div>
            <div className="flex gap-2">
              <button
                onClick={onClose}
                disabled={busy}
                className="h-10 px-4 rounded-full border border-op-border text-sm"
              >
                {tr("cancel")}
              </button>
              <button
                onClick={save}
                disabled={busy}
                className="h-10 px-5 rounded-full bg-ink text-bone text-sm font-medium disabled:opacity-60"
              >
                {busy ? tr("saving") : tr("save")}
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
  const tr = useTranslations("opMenuEditor");
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
          {tr("modifiers")}
        </div>
        <button
          type="button"
          onClick={add}
          className="text-xs text-terracotta hover:underline"
        >
          {tr("addModifier")}
        </button>
      </div>
      {modifiers.length === 0 && (
        <div className="text-xs text-op-muted">
          {tr("modifiersEmpty")}
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
                  {tr("modifierLabel")}
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
                  placeholder={tr("modifierLabelPlaceholder")}
                  className="h-9 px-2 rounded border border-op-border bg-op-surface text-sm"
                />
              </label>
              <label className="flex flex-col">
                <span className="font-mono text-[9px] tracking-[0.14em] uppercase text-op-muted mb-1">
                  {tr("modifierType")}
                </span>
                <select
                  value={m.type}
                  onChange={(e) =>
                    update(i, { type: e.target.value as "radio" | "checkbox" })
                  }
                  className="h-9 px-2 rounded border border-op-border bg-op-surface text-sm"
                >
                  <option value="radio">{tr("modifierTypeSingle")}</option>
                  <option value="checkbox">{tr("modifierTypeMultiple")}</option>
                </select>
              </label>
              <button
                type="button"
                onClick={() => remove(i)}
                aria-label={tr("removeModifier")}
                className="h-9 px-2 text-xs text-op-muted hover:text-danger"
              >
                <span aria-hidden>{"×"}</span>
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
  const tr = useTranslations("opMenuEditor");
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
                <span aria-hidden>{"+"}</span>
                <input
                  type="number"
                  value={deltaPesos}
                  onChange={(e) => setOptPrice(i, e.target.value)}
                  placeholder="0"
                  step={100}
                  className="w-20 h-7 px-2 rounded border border-op-border bg-op-bg text-right tabular text-xs"
                  title={tr("optionPriceTitle")}
                />
              </div>
              {canDefault && !isDefault && (
                <button
                  type="button"
                  onClick={() => onChange(opts, o.label)}
                  className="text-[9px] uppercase tracking-wider text-op-muted hover:text-ink px-1.5 shrink-0"
                  title={tr("setDefaultTitle")}
                >
                  {tr("default")}
                </button>
              )}
              {isDefault && (
                <span className="text-[9px] uppercase tracking-wider text-ink shrink-0 px-1.5">
                  {tr("default")}
                </span>
              )}
              <button
                type="button"
                onClick={() => removeAt(i)}
                className="w-6 h-6 rounded-full hover:bg-op-border/40 inline-flex items-center justify-center text-op-muted shrink-0"
                aria-label={tr("removeOption", { label: o.label })}
              >
                <span aria-hidden>{"×"}</span>
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
          placeholder={tr("addOptionPlaceholder")}
          className="flex-1 h-8 px-2 rounded border border-op-border bg-op-surface text-xs"
        />
        <button
          type="button"
          onClick={addDraft}
          className="h-8 px-3 rounded-full bg-op-border/40 text-xs"
        >
          {tr("add")}
        </button>
      </div>
    </div>
  );
}
