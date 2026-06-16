"use client";

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { fmtCOP } from "@/lib/format";
import type { MenuTag } from "@/lib/menuTags";
import { BulkActionBar } from "./BulkActions";
import type {
  Cat,
  CategoryKind,
  Item,
  MenuRef,
  ModifierDef,
  ModOpt,
  PrepStation,
} from "./types";

// CategoryKind enum survives in the schema and the API, but the editor
// only exposes the one distinction that drives product behaviour: is
// this the category of platos fuertes (used by Fuertes-juntos mode)?
// The other slugs (starter / side / drink / dessert) are accepted by
// the API for historical reasons but no longer surfaced anywhere — the
// editor only writes "main" or "other". The shared shapes live in ./types
// so the bulk-actions UI uses the same definitions.

// Tags are now configured per restaurant in /operator/settings/etiquetas
// and arrive via the `menuTags` prop. The hardcoded list that used to
// live here is gone — we render whatever the operator picked.

// Normalización para la búsqueda del editor: minúsculas + sin acentos +
// espacios colapsados. Misma transformación sobre query y texto, así "cafe"
// matchea "Café". (Equivalente al fuzzyNormalize del menú del comensal.)
function searchNormalize(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

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
  // Categoría que se está convirtiendo en modificador (sheet abierto).
  const [convertingCat, setConvertingCat] = useState<Cat | null>(null);
  const [categories, setCategories] = useState<Cat[]>(initialCategories);
  // Mientras se persiste un reordenamiento de categorías, deshabilitamos las
  // flechas para evitar swaps encimados.
  const [reordering, setReordering] = useState(false);
  // Búsqueda de platos por nombre/descripción (sin acentos). Vacía = vista
  // normal; con texto, filtra los platos y oculta categorías sin coincidencias.
  const [query, setQuery] = useState("");
  const [editingItem, setEditingItem] = useState<Item | null>(null);
  const [addingCategory, setAddingCategory] = useState(false);
  const [addingItemInCat, setAddingItemInCat] = useState<string | null>(null);
  // Active menu tab. Only relevant when the restaurant has >1 menu.
  const [activeMenuId, setActiveMenuId] = useState<string>(
    menus[0]?.id ?? "",
  );

  // Selección para acciones masivas (descripción IA, mover, estación, borrar).
  // Guardamos ids; los platos reales se resuelven contra `items`.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(
    () => new Set<string>(),
  );
  function toggleItemSelected(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  function setManySelected(ids: string[], value: boolean) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      for (const id of ids) {
        if (value) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  }
  function clearSelection() {
    setSelectedIds(new Set<string>());
  }

  // Aplicación local de los resultados de cada acción masiva (sin recargar).
  function applyBulkDescriptions(updates: { id: string; description: string }[]) {
    const map = new Map(updates.map((u) => [u.id, u.description]));
    setItems((prev) =>
      prev.map((i) =>
        map.has(i.id) ? { ...i, description: map.get(i.id) ?? i.description } : i,
      ),
    );
  }
  function applyBulkCategory(ids: string[], categoryId: string) {
    const set = new Set(ids);
    setItems((prev) =>
      prev.map((i) => (set.has(i.id) ? { ...i, categoryId } : i)),
    );
  }
  function applyBulkStation(ids: string[], prepStation: PrepStation | null) {
    const set = new Set(ids);
    setItems((prev) =>
      prev.map((i) => (set.has(i.id) ? { ...i, prepStation } : i)),
    );
  }
  function applyBulkDelete(deletedIds: string[], archivedIds: string[]) {
    const del = new Set(deletedIds);
    const arch = new Set(archivedIds);
    setItems((prev) =>
      prev
        .filter((i) => !del.has(i.id))
        .map((i) => (arch.has(i.id) ? { ...i, available: false } : i)),
    );
  }
  function applyBulkModifiers(results: { id: string; modifiers: ModifierDef[] }[]) {
    const map = new Map(results.map((r) => [r.id, r.modifiers]));
    setItems((prev) =>
      prev.map((i) =>
        map.has(i.id) ? { ...i, modifiers: map.get(i.id) ?? i.modifiers } : i,
      ),
    );
  }
  function applyConvert(r: {
    targetItemId: string;
    modifiers: ModifierDef[];
    deletedItemIds: string[];
    archivedItemIds: string[];
    deletedCategoryId: string | null;
  }) {
    const del = new Set(r.deletedItemIds);
    const arch = new Set(r.archivedItemIds);
    setItems((prev) =>
      prev
        .filter((i) => !del.has(i.id))
        .map((i) => {
          let it = i;
          if (i.id === r.targetItemId) it = { ...it, modifiers: r.modifiers };
          if (arch.has(i.id)) it = { ...it, available: false };
          return it;
        }),
    );
    if (r.deletedCategoryId) {
      const removed = r.deletedCategoryId;
      setCategories((prev) => prev.filter((c) => c.id !== removed));
    }
    setConvertingCat(null);
  }

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
    setCategories((prev) => {
      // El servidor crea la categoría al final (max sortOrder + 10). Replicamos
      // ese valor localmente entre las top-level de la misma carta para que el
      // orden optimista coincida con el que tendrá tras recargar.
      const siblingMax = prev
        .filter((c) => c.menuId === cat.menuId && !c.parentId)
        .reduce((m, c) => Math.max(m, c.sortOrder), 0);
      return [...prev, { ...cat, sortOrder: siblingMax + 10 }];
    });
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

  // Platos visibles en la pestaña activa — base de "seleccionar toda la carta"
  // y de los platos que la barra de acciones masivas opera.
  const visibleItems = visibleCategories.flatMap((c) => byCat.get(c.id) ?? []);
  const visibleItemIds = visibleItems.map((i) => i.id);
  const selectedItems = items.filter((i) => selectedIds.has(i.id));

  // Búsqueda: filtra por nombre + descripción (sin acentos). Cuando hay query,
  // las categorías sin coincidencias no se muestran (ver el map de abajo).
  const searching = query.trim().length > 0;
  const nq = searchNormalize(query);
  const matchesItem = (it: Item) =>
    searchNormalize(`${it.name} ${it.description ?? ""}`).includes(nq);
  const searchHasResults = searching && visibleItems.some(matchesItem);
  const allVisibleSelected =
    visibleItemIds.length > 0 &&
    visibleItemIds.every((id) => selectedIds.has(id));

  // Orden jerárquico: cada categoría top-level seguida de sus subcategorías
  // (un solo nivel). Una subcategoría siempre vive en el mismo menú que su
  // padre, así que si la hija es visible su padre también lo es.
  const orderedVisible: { c: Cat; isChild: boolean }[] = [];
  for (const top of visibleCategories.filter((x) => !x.parentId)) {
    orderedVisible.push({ c: top, isChild: false });
    for (const child of visibleCategories.filter((x) => x.parentId === top.id)) {
      orderedVisible.push({ c: child, isChild: true });
    }
  }
  // Defensivo: cualquier categoría visible que no quedó incluida (no debería
  // pasar) se muestra al nivel superior para no perder sus platos.
  const seenOrdered = new Set(orderedVisible.map((o) => o.c.id));
  for (const c of visibleCategories) {
    if (!seenOrdered.has(c.id)) orderedVisible.push({ c, isChild: false });
  }
  // Posibles padres de una categoría: top-level del mismo menú, excepto ella.
  function parentOptionsFor(cat: Cat): Cat[] {
    return categories.filter(
      (x) => !x.parentId && x.menuId === cat.menuId && x.id !== cat.id,
    );
  }
  function categoryHasChildren(catId: string): boolean {
    return categories.some((x) => x.parentId === catId);
  }

  // Hermanas de una categoría = mismas que comparten nivel: las top-level entre
  // sí, o las hijas de un mismo padre. visibleCategories ya está filtrado por la
  // carta activa, así que el orden del array es el orden mostrado.
  function siblingsOf(cat: Cat): Cat[] {
    return visibleCategories.filter(
      (x) => (x.parentId ?? null) === (cat.parentId ?? null),
    );
  }

  // Mueve una categoría dentro de su grupo de hermanas (↑/↓). Reordena de forma
  // optimista (reubica las dos en el array, que es lo que define el orden
  // mostrado) y persiste el sortOrder de las que cambiaron. Si algún PATCH
  // falla, revierte y avisa.
  async function moveCategory(cat: Cat, dir: "up" | "down") {
    const sibs = siblingsOf(cat);
    const idx = sibs.findIndex((s) => s.id === cat.id);
    const j = dir === "up" ? idx - 1 : idx + 1;
    if (j < 0 || j >= sibs.length) return;
    const other = sibs[j];

    // Renumeramos el grupo por su nuevo orden y vemos cuáles cambian.
    const swapped = [...sibs];
    [swapped[idx], swapped[j]] = [swapped[j], swapped[idx]];
    const newOrder = new Map(swapped.map((s, i) => [s.id, i]));
    const changed = sibs.filter((s) => newOrder.get(s.id) !== s.sortOrder);

    const prev = categories;
    const next = (() => {
      const arr = prev.map((c) =>
        newOrder.has(c.id) ? { ...c, sortOrder: newOrder.get(c.id)! } : c,
      );
      const ia = arr.findIndex((x) => x.id === cat.id);
      const ib = arr.findIndex((x) => x.id === other.id);
      [arr[ia], arr[ib]] = [arr[ib], arr[ia]];
      return arr;
    })();
    setCategories(next); // optimista
    setReordering(true);
    try {
      const results = await Promise.all(
        changed.map((s) =>
          fetch(`/api/operator/categories/${s.id}`, {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ sortOrder: newOrder.get(s.id) }),
          }),
        ),
      );
      if (results.some((r) => !r.ok)) {
        setCategories(prev);
        alert(tr("errReorderCat"));
      }
    } catch {
      setCategories(prev);
      alert(tr("errReorderCat"));
    } finally {
      setReordering(false);
    }
  }

  return (
    <div
      className={
        "op-menu-editor px-4 py-5 sm:p-6 max-w-5xl mx-auto w-full " +
        // Espacio extra abajo para que la barra fija de acciones no tape los
        // últimos platos.
        (selectedIds.size > 0 ? "pb-28" : "")
      }
    >
      {/* Móvil: título arriba; los botones envuelven naturalmente (cada pill a
          su ancho, sin partir el texto) → quedan compactos en ~2 filas en vez
          de ocupar 3 filas a ancho completo. Desktop: en línea. */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-5">
        <div className="font-display text-2xl sm:text-3xl">{tr("title")}</div>
        <div className="flex flex-wrap items-center gap-2">
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
            className="h-10 px-4 rounded-full border border-op-border text-sm font-medium inline-flex items-center gap-1.5 hover:bg-op-bg whitespace-nowrap"
          >
            <span aria-hidden>🧠</span> {tr("importWithAi")}
          </a>
          {!addingCategory && (
            <button
              onClick={() => setAddingCategory(true)}
              className="h-10 px-5 rounded-full bg-ink text-bone text-sm font-medium whitespace-nowrap"
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
                onClick={() => {
                  setActiveMenuId(m.id);
                  // La selección es por pestaña; al cambiar de carta la
                  // limpiamos para no operar sobre platos que no se ven.
                  clearSelection();
                }}
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

      {/* Búsqueda de platos. Filtra por nombre/descripción sin acentos y oculta
          las categorías sin coincidencias. */}
      {(items.length > 0 || searching) && (
        <div className="mb-5 relative">
          <svg
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-op-muted"
            width="16"
            height="16"
            viewBox="0 0 20 20"
            fill="none"
            aria-hidden
          >
            <circle cx="9" cy="9" r="6" stroke="currentColor" strokeWidth="1.75" />
            <path
              d="M14 14l4 4"
              stroke="currentColor"
              strokeWidth="1.75"
              strokeLinecap="round"
            />
          </svg>
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={tr("searchPlaceholder")}
            className="w-full h-11 pl-9 pr-10 rounded-xl border border-op-border bg-op-surface text-sm"
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery("")}
              aria-label={tr("clearSearch")}
              className="absolute right-2 top-1/2 -translate-y-1/2 h-7 w-7 rounded-full inline-flex items-center justify-center text-op-muted hover:bg-op-border/40 hover:text-ink"
            >
              <svg width="14" height="14" viewBox="0 0 20 20" fill="none" aria-hidden>
                <path
                  d="M5 5l10 10M15 5L5 15"
                  stroke="currentColor"
                  strokeWidth="1.75"
                  strokeLinecap="round"
                />
              </svg>
            </button>
          )}
        </div>
      )}

      {/* Mientras se busca, ocultamos los formularios de alta para no mezclar
          con los resultados filtrados. */}
      {addingCategory && !searching && (
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

      {visibleCategories.length === 0 && !addingCategory && !searching && (
        <div className="text-sm text-op-muted border border-dashed border-op-border rounded-xl p-8 text-center">
          {hasMultipleMenus
            ? tr("emptyMultiMenu")
            : tr("emptySingleMenu")}
        </div>
      )}

      {searching && !searchHasResults && (
        <div className="text-sm text-op-muted border border-dashed border-op-border rounded-xl p-8 text-center">
          {tr("searchNoResults", { query: query.trim() })}
        </div>
      )}

      <div className="space-y-8">
        {orderedVisible.map(({ c, isChild }) => {
          const allRows = byCat.get(c.id) ?? [];
          // Al buscar, filtramos los platos de la categoría; si no queda
          // ninguno, la categoría no se muestra.
          const rows = searching ? allRows.filter(matchesItem) : allRows;
          if (searching && rows.length === 0) return null;
          // Flechas de orden: solo dentro del grupo de hermanas (top-level
          // entre sí, o hijas de un mismo padre). La primera no sube, la
          // última no baja. Mientras se busca no tiene sentido reordenar.
          const sibs = siblingsOf(c);
          const sibIdx = sibs.findIndex((s) => s.id === c.id);
          const showArrows = !searching && sibs.length > 1;
          return (
            <section
              key={c.id}
              className={
                isChild ? "ml-4 sm:ml-6 border-l-2 border-op-border/60 pl-4" : ""
              }
            >
              {/* En desktop el encabezado de categoría es de 2 filas (título +
                  controles inline), así que alineamos check/flechas al tope
                  (lg:items-start) para que queden con el título; en chicas es
                  una sola fila → items-center. */}
              <div className="flex items-center lg:items-start mb-3 gap-2">
                {showArrows && (
                  <div className="flex flex-col -my-1 shrink-0 lg:mt-1">
                    <button
                      type="button"
                      aria-label={tr("moveCatUp")}
                      onClick={() => moveCategory(c, "up")}
                      disabled={reordering || sibIdx <= 0}
                      className="h-7 w-9 sm:h-5 sm:w-6 leading-none text-lg sm:text-base text-op-muted hover:text-ink disabled:opacity-25"
                    >
                      <span aria-hidden>↑</span>
                    </button>
                    <button
                      type="button"
                      aria-label={tr("moveCatDown")}
                      onClick={() => moveCategory(c, "down")}
                      disabled={reordering || sibIdx >= sibs.length - 1}
                      className="h-7 w-9 sm:h-5 sm:w-6 leading-none text-lg sm:text-base text-op-muted hover:text-ink disabled:opacity-25"
                    >
                      <span aria-hidden>↓</span>
                    </button>
                  </div>
                )}
                <CategorySelectCheckbox
                  rows={rows}
                  selectedIds={selectedIds}
                  onToggleAll={(value) =>
                    setManySelected(
                      rows.map((r) => r.id),
                      value,
                    )
                  }
                  // En desktop el encabezado es de 2 filas y la fila se alinea
                  // al tope; bajamos el check para centrarlo con el título
                  // (text-2xl ≈ 32px de alto, check 16px → ~8px).
                  className="lg:mt-2"
                />
                <CategoryHeader
                  cat={c}
                  menus={menus}
                  isChild={isChild}
                  parentOptions={parentOptionsFor(c)}
                  hasChildren={categoryHasChildren(c.id)}
                  itemCount={rows.length}
                  onAddDish={() => setAddingItemInCat(c.id)}
                  // El toggle "plato fuerte" se muestra para TODA categoría,
                  // incluidas las de cartas no-default (vinos, cócteles).
                  // Antes se ocultaba ahí, lo que dejaba trabadas categorías
                  // mal clasificadas como "plato fuerte" (p.ej. importadas):
                  // sin forma de corregirlas. El kind igual se ve en
                  // Estaciones y afecta "Fuertes juntos", así que hay que
                  // poder editarlo siempre.
                  showKind
                  onPatch={(patch) => replaceCategory({ ...c, ...patch })}
                  onDeleted={() => removeCategory(c.id)}
                  onConvert={
                    items.some((i) => i.categoryId === c.id)
                      ? () => setConvertingCat(c)
                      : undefined
                  }
                />
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
                      // Móvil: grid de 3 columnas (check · foto · contenido) con
                      // las acciones bajando a una 2ª fila a la derecha, así el
                      // nombre y el precio usan todo el ancho. Desktop: una sola
                      // fila (flex) como siempre.
                      "p-3 sm:p-4 grid grid-cols-[auto_auto_1fr] items-start gap-x-3 gap-y-2 sm:flex hover:bg-op-bg/50 " +
                      (selectedIds.has(it.id) ? "bg-terracotta/5 " : "") +
                      (it.available ? "" : "opacity-60")
                    }
                  >
                    <input
                      type="checkbox"
                      checked={selectedIds.has(it.id)}
                      onChange={() => toggleItemSelected(it.id)}
                      aria-label={tr("selectDishAria")}
                      className="w-4 h-4 mt-1 shrink-0"
                    />
                    {/* Foto + contenido: tocar abre la edición del plato. */}
                    <button
                      type="button"
                      onClick={() => setEditingItem(it)}
                      aria-label={tr("edit")}
                      className="w-12 h-12 sm:w-14 sm:h-14 shrink-0 rounded-lg bg-op-bg bg-cover bg-center"
                      style={
                        it.photoUrl
                          ? { backgroundImage: `url(${it.photoUrl})` }
                          : undefined
                      }
                    />
                    <div
                      role="button"
                      tabIndex={0}
                      onClick={() => setEditingItem(it)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          setEditingItem(it);
                        }
                      }}
                      className="min-w-0 sm:flex-1 cursor-pointer"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="font-medium leading-snug line-clamp-2 sm:truncate">
                          {it.name}
                        </div>
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
                    <div className="col-span-3 justify-self-end sm:col-auto sm:justify-self-auto shrink-0 flex items-center gap-2">
                      <AvailabilityToggle
                        item={it}
                        onChanged={(available) =>
                          patchItem(it.id, { available })
                        }
                      />
                      {/* Chevron: afford­ancia explícita de "abrir/editar". */}
                      <button
                        type="button"
                        onClick={() => setEditingItem(it)}
                        aria-label={tr("edit")}
                        className="h-9 w-9 -mr-1 rounded-full inline-flex items-center justify-center text-op-muted hover:bg-op-border/40 hover:text-ink"
                      >
                        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
                          <path
                            d="M6 3.5L10.5 8L6 12.5"
                            stroke="currentColor"
                            strokeWidth="1.75"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          />
                        </svg>
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

      <BulkActionBar
        selectedItems={selectedItems}
        allItems={items}
        categories={categories}
        visibleCount={visibleItemIds.length}
        allVisibleSelected={allVisibleSelected}
        onSelectAllVisible={() =>
          setManySelected(visibleItemIds, !allVisibleSelected)
        }
        onClear={clearSelection}
        onDescriptionsApplied={applyBulkDescriptions}
        onCategoryApplied={applyBulkCategory}
        onStationApplied={applyBulkStation}
        onModifiersApplied={applyBulkModifiers}
        onDeleted={applyBulkDelete}
      />

      {convertingCat && (
        <ConvertCategorySheet
          category={convertingCat}
          sourceItems={items.filter((i) => i.categoryId === convertingCat.id)}
          targets={items.filter((i) => i.categoryId !== convertingCat.id)}
          onClose={() => setConvertingCat(null)}
          onApplied={applyConvert}
        />
      )}
    </div>
  );
}

/**
 * Parsea el tiempo de preparación que escribe el operador (en MINUTOS).
 * Acepta coma o punto como separador decimal (locales es-CO/es-MX) y redondea
 * a décimas de minuto: 0.5 = 30 s, 0.1 = 6 s. Devuelve null si no es un número
 * positivo (la validación de la UI lo rechaza con un mensaje claro).
 */
function parsePrepMinutes(raw: string): number | null {
  const n = Number(raw.trim().replace(/,/g, "."));
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n * 10) / 10;
}

/**
 * Muestra el equivalente en segundos/minutos del valor escrito, para que el
 * operador vea que "0.5" = 30 s sin tener que adivinar.
 */
function PrepHint({ raw }: { raw: string }) {
  const tr = useTranslations("opMenuEditor");
  const mins = parsePrepMinutes(raw);
  if (mins == null) return null;
  const totalSec = Math.round(mins * 60);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  const text =
    m === 0
      ? tr("prepEqSeconds", { seconds: s })
      : s === 0
        ? tr("prepEqMinutes", { minutes: m })
        : tr("prepEqMinSec", { minutes: m, seconds: s });
  return (
    <span className="mt-1 font-mono text-[10px] text-op-muted">{text}</span>
  );
}

function CategorySelectCheckbox({
  rows,
  selectedIds,
  onToggleAll,
  className,
}: {
  rows: Item[];
  selectedIds: Set<string>;
  onToggleAll: (value: boolean) => void;
  className?: string;
}) {
  const tr = useTranslations("opMenuEditor");
  const ref = useRef<HTMLInputElement>(null);
  const total = rows.length;
  const selected = rows.filter((r) => selectedIds.has(r.id)).length;
  const allSelected = total > 0 && selected === total;
  const someSelected = selected > 0 && selected < total;
  // El estado "indeterminado" (algunos, no todos) es una propiedad del DOM,
  // no del HTML, así que se setea por ref.
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = someSelected;
  }, [someSelected]);
  if (total === 0) return null;
  return (
    <input
      ref={ref}
      type="checkbox"
      checked={allSelected}
      onChange={(e) => onToggleAll(e.target.checked)}
      title={tr("selectCategoryAria")}
      aria-label={tr("selectCategoryAria")}
      className={"w-4 h-4 shrink-0 " + (className ?? "")}
    />
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
        "h-9 sm:h-7 px-3.5 sm:px-3 rounded-full text-[11px] font-mono uppercase tracking-wider border transition " +
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
      // El padre (addCategory) recalcula el sortOrder real al final del grupo;
      // este valor es solo para satisfacer el tipo Cat.
      sortOrder: 0,
      // Las categorías nuevas se crean al nivel superior; se pueden anidar
      // después con el selector "Subcat. de" en el encabezado.
      parentId: null,
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
  isChild,
  parentOptions,
  hasChildren,
  itemCount,
  onAddDish,
  onPatch,
  onDeleted,
  onConvert,
}: {
  cat: Cat;
  menus: MenuRef[];
  // Cantidad de platos en la categoría (para el contador del encabezado).
  itemCount: number;
  // Abre el formulario para agregar un plato a esta categoría.
  onAddDish: () => void;
  // Hide the kind dropdown for categories that live in a non-default
  // menu (vinos, cócteles, etc.). See NewCategoryForm for the why.
  showKind: boolean;
  // Es una subcategoría (cuelga de otra). Render más chico + indentado.
  isChild: boolean;
  // Posibles padres (top-level del mismo menú). Si vacío, no se muestra el
  // selector "Subcategoría de".
  parentOptions: Cat[];
  // Si esta categoría ya tiene subcategorías, no puede volverse hija (un solo
  // nivel) → el selector queda deshabilitado.
  hasChildren: boolean;
  onPatch: (patch: Partial<Cat>) => void;
  onDeleted: () => void;
  // Convierte la categoría en un modificador para asignar a un producto. Solo
  // se pasa cuando la categoría tiene productos (si no, no hay qué convertir).
  onConvert?: () => void;
}) {
  const tr = useTranslations("opMenuEditor");
  const [editing, setEditing] = useState(false);
  const [label, setLabel] = useState(cat.label);
  const [busy, setBusy] = useState(false);
  // Menú de acciones secundarias (•••). Antes estaban todas inline y
  // amontonaban el encabezado (sobre todo en móvil).
  const [menuOpen, setMenuOpen] = useState(false);

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

  // Anidar/desanidar como subcategoría. parentId null = volver a top-level.
  async function changeParent(parentId: string | null) {
    const res = await fetch(`/api/operator/categories/${cat.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ parentId }),
    });
    if (!res.ok) {
      alert(tr("errChangeParent"));
      return;
    }
    // Al anidar, la hija hereda el menú del padre — reflejamos ambos para que
    // el reordenamiento jerárquico sea inmediato (sin recargar).
    const parentMenuId = parentId
      ? parentOptions.find((p) => p.id === parentId)?.menuId
      : undefined;
    onPatch({ parentId, ...(parentMenuId ? { menuId: parentMenuId } : {}) });
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

  // Filas de selectores que viven dentro del menú (mover de carta, subcat de).
  const showMenuSelect = menus.length > 1 && !isChild;
  const showParentSelect = parentOptions.length > 0;

  return (
    <div className="flex flex-col gap-1.5 min-w-0 flex-1">
      {/* Línea 1: título + contador (izq) y acción primaria + overflow (der) */}
      <div className="flex items-center gap-2 min-w-0">
        <div className="flex items-baseline gap-2 min-w-0 flex-1">
          <div
            className={
              "font-display truncate " +
              (isChild ? "text-base sm:text-lg" : "text-xl sm:text-2xl")
            }
          >
            {cat.label}
          </div>
          <span className="text-xs text-op-muted shrink-0 whitespace-nowrap">
            {tr("categoryDishCount", { count: itemCount })}
          </span>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <button
            onClick={onAddDish}
            className="h-9 sm:h-8 px-3.5 sm:px-4 rounded-full bg-op-surface border border-op-border text-xs font-medium"
          >
            {tr("addDish")}
          </button>
          {/* Overflow "•••": solo en pantallas chicas. En desktop los controles
              viven inline en la línea 2 de abajo. */}
          <div className="relative lg:hidden">
            <button
              type="button"
              aria-label={tr("moreActions")}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen((v) => !v)}
              className="h-9 w-9 rounded-full inline-flex items-center justify-center text-op-muted hover:bg-op-border/40 hover:text-ink"
            >
              <svg width="18" height="18" viewBox="0 0 20 20" fill="currentColor" aria-hidden>
                <circle cx="10" cy="4" r="1.6" />
                <circle cx="10" cy="10" r="1.6" />
                <circle cx="10" cy="16" r="1.6" />
              </svg>
            </button>
            {menuOpen && (
            <>
              {/* Backdrop para cerrar al tocar afuera (confiable en móvil). */}
              <div
                className="fixed inset-0 z-40"
                onClick={() => setMenuOpen(false)}
              />
              <div
                role="menu"
                className="absolute right-0 top-full mt-1 z-50 w-64 max-w-[calc(100vw-2rem)] rounded-xl border border-op-border bg-op-surface shadow-xl p-1.5 text-sm"
              >
                {showKind && !isChild && (
                  <label className="flex items-center gap-2.5 px-2.5 py-2.5 rounded-lg hover:bg-op-bg cursor-pointer">
                    <input
                      type="checkbox"
                      checked={cat.kind === "main"}
                      onChange={(e) =>
                        changeKind(e.target.checked ? "main" : "other")
                      }
                      className="w-4 h-4"
                    />
                    <span>{tr("mainCourses")}</span>
                  </label>
                )}
                {showMenuSelect && (
                  <div className="px-2.5 py-2">
                    <div className="font-mono text-[9px] tracking-[0.14em] uppercase text-op-muted mb-1">
                      {tr("categoryMenuTitle")}
                    </div>
                    <select
                      value={cat.menuId}
                      onChange={(e) => changeMenu(e.target.value)}
                      className="w-full h-9 px-2 rounded-lg border border-op-border bg-op-bg text-sm"
                    >
                      {menus.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.label}
                        </option>
                      ))}
                    </select>
                  </div>
                )}
                {showParentSelect && (
                  <div className="px-2.5 py-2">
                    <div className="font-mono text-[9px] tracking-[0.14em] uppercase text-op-muted mb-1">
                      {tr("subcategoryOfLabel")}
                    </div>
                    <select
                      value={cat.parentId ?? ""}
                      onChange={(e) => changeParent(e.target.value || null)}
                      disabled={hasChildren}
                      className="w-full h-9 px-2 rounded-lg border border-op-border bg-op-bg text-sm disabled:opacity-50"
                    >
                      <option value="">{tr("subcategoryNone")}</option>
                      {parentOptions.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.label}
                        </option>
                      ))}
                    </select>
                  </div>
                )}
                {(showKind || showMenuSelect || showParentSelect) && (
                  <div className="my-1 border-t border-op-border" />
                )}
                <button
                  onClick={() => {
                    setMenuOpen(false);
                    setEditing(true);
                  }}
                  className="w-full text-left px-2.5 py-2.5 rounded-lg hover:bg-op-bg"
                >
                  {tr("rename")}
                </button>
                {onConvert && (
                  <button
                    onClick={() => {
                      setMenuOpen(false);
                      onConvert();
                    }}
                    className="w-full text-left px-2.5 py-2.5 rounded-lg hover:bg-op-bg"
                  >
                    {tr("convertToModifier")}
                  </button>
                )}
                <div className="my-1 border-t border-op-border" />
                <button
                  onClick={() => {
                    setMenuOpen(false);
                    del();
                  }}
                  className="w-full text-left px-2.5 py-2.5 rounded-lg text-danger hover:bg-danger/10"
                >
                  {tr("delete")}
                </button>
              </div>
            </>
          )}
          </div>
        </div>
      </div>

      {/* Línea 2 (lg+): controles inline en su propia fila, así el título de
          arriba nunca se aplasta. En pantallas chicas estas acciones viven en
          el menú "•••" de la línea 1. */}
      <div className="hidden lg:flex flex-wrap items-center gap-x-3 gap-y-1.5">
        {showKind && !isChild && (
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
        {showMenuSelect && (
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
        {showParentSelect && (
          <label className="inline-flex items-center gap-1 text-[11px] text-op-muted">
            <span>{tr("subcategoryOfLabel")}</span>
            <select
              value={cat.parentId ?? ""}
              onChange={(e) => changeParent(e.target.value || null)}
              disabled={hasChildren}
              title={tr("subcategoryOfTitle")}
              className="h-7 px-1.5 rounded border border-op-border bg-op-bg text-[11px] disabled:opacity-50"
            >
              <option value="">{tr("subcategoryNone")}</option>
              {parentOptions.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>
        )}
        {onConvert && (
          <button
            onClick={onConvert}
            className="text-xs text-op-muted hover:text-terracotta"
          >
            {tr("convertToModifier")}
          </button>
        )}
        <button
          onClick={() => setEditing(true)}
          className="text-xs text-op-muted hover:text-ink"
        >
          {tr("rename")}
        </button>
        <button
          onClick={del}
          className="text-xs text-op-muted hover:text-danger"
        >
          {tr("delete")}
        </button>
      </div>
    </div>
  );
}

type ConvertResult = {
  targetItemId: string;
  modifiers: ModifierDef[];
  deletedItemIds: string[];
  archivedItemIds: string[];
  deletedCategoryId: string | null;
};

function ConvertCategorySheet({
  category,
  sourceItems,
  targets,
  onClose,
  onApplied,
}: {
  category: Cat;
  sourceItems: Item[];
  targets: Item[];
  onClose: () => void;
  onApplied: (r: ConvertResult) => void;
}) {
  const tr = useTranslations("opMenuEditor");
  const [label, setLabel] = useState(() =>
    tr("convertLabelDefault", { category: category.label }),
  );
  const [type, setType] = useState<"radio" | "checkbox">("checkbox");
  const [opts, setOpts] = useState(() =>
    sourceItems.map((it) => ({
      id: it.id,
      include: true,
      name: it.name,
      priceCop: String(Math.round(it.priceCents / 100)),
    })),
  );
  const [query, setQuery] = useState("");
  const [targetId, setTargetId] = useState<string | null>(null);
  const [deleteSource, setDeleteSource] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const filteredTargets = (() => {
    const norm = (s: string) =>
      s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
    const q = norm(query.trim());
    const list = q ? targets.filter((t) => norm(t.name).includes(q)) : targets;
    return [...list].sort((a, b) => a.name.localeCompare(b.name));
  })();
  const target = targets.find((t) => t.id === targetId) ?? null;
  const includedOpts = opts.filter((o) => o.include && o.name.trim());

  function updateOpt(
    id: string,
    patch: Partial<{ include: boolean; name: string; priceCop: string }>,
  ) {
    setOpts((prev) => prev.map((o) => (o.id === id ? { ...o, ...patch } : o)));
  }

  async function apply() {
    if (!target || includedOpts.length === 0) return;
    setBusy(true);
    setErr(null);
    const options = includedOpts.map((o) => {
      const pesos = Number(o.priceCop.trim().replace(/,/g, "."));
      return {
        label: o.name.trim().slice(0, 60),
        priceDeltaCents: Number.isFinite(pesos) ? Math.round(pesos * 100) : 0,
      };
    });
    const res = await fetch(
      `/api/operator/categories/${category.id}/to-modifier`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          targetItemId: target.id,
          label: label.trim().slice(0, 60) || category.label,
          type,
          options,
          deleteSource,
        }),
      },
    );
    setBusy(false);
    if (!res.ok) {
      // Mostramos el motivo concreto cuando lo conocemos; el resto cae al
      // mensaje genérico (auth, sin restaurante, ids inválidos, red).
      const code = await res
        .json()
        .then((b) => (b && typeof b.error === "string" ? b.error : null))
        .catch(() => null);
      setErr(
        code === "too_many_modifiers"
          ? tr("convertErrTooMany")
          : code === "invalid"
            ? tr("convertErrInvalid")
            : tr("bulkErr"),
      );
      return;
    }
    const j = (await res.json()) as ConvertResult;
    onApplied({
      targetItemId: j.targetItemId,
      modifiers: j.modifiers,
      deletedItemIds: j.deletedItemIds ?? [],
      archivedItemIds: j.archivedItemIds ?? [],
      deletedCategoryId: j.deletedCategoryId ?? null,
    });
  }

  return (
    <div
      className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4"
      onClick={busy ? undefined : onClose}
    >
      <div
        className="bg-op-surface text-op-text w-full max-w-lg rounded-2xl p-6 space-y-4 max-h-[88vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="font-display text-2xl shrink-0">
          {tr("convertTitle")}
        </div>

        <div className="flex-1 overflow-y-auto -mx-2 px-2 space-y-4">
          <label className="flex flex-col">
            <span className="font-mono text-[10px] tracking-[0.14em] uppercase text-op-muted mb-1">
              {tr("convertLabelField")}
            </span>
            <input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              maxLength={60}
              className="h-10 px-3 rounded-lg border border-op-border bg-op-bg text-sm"
            />
          </label>

          <label className="flex flex-col">
            <span className="font-mono text-[10px] tracking-[0.14em] uppercase text-op-muted mb-1">
              {tr("modifierType")}
            </span>
            <select
              value={type}
              onChange={(e) => setType(e.target.value as "radio" | "checkbox")}
              className="h-10 px-3 rounded-lg border border-op-border bg-op-bg text-sm"
            >
              <option value="checkbox">{tr("modifierTypeMultiple")}</option>
              <option value="radio">{tr("modifierTypeSingle")}</option>
            </select>
          </label>

          <div>
            <div className="font-mono text-[10px] tracking-[0.14em] uppercase text-op-muted mb-1">
              {tr("convertOptionsHeading")}
            </div>
            <div className="space-y-1.5">
              {opts.map((o) => (
                <div
                  key={o.id}
                  className={
                    "flex items-center gap-2 rounded-lg border px-2 py-1.5 " +
                    (o.include
                      ? "bg-op-bg border-op-border"
                      : "bg-op-bg/40 border-op-border/50 opacity-60")
                  }
                >
                  <input
                    type="checkbox"
                    checked={o.include}
                    onChange={(e) => updateOpt(o.id, { include: e.target.checked })}
                    className="w-4 h-4 shrink-0"
                  />
                  <input
                    value={o.name}
                    onChange={(e) => updateOpt(o.id, { name: e.target.value })}
                    maxLength={60}
                    className="flex-1 h-8 px-2 rounded border border-op-border bg-op-surface text-sm min-w-0"
                  />
                  <div className="flex items-center gap-1 text-xs text-op-muted shrink-0">
                    <span aria-hidden>{"+"}</span>
                    <input
                      type="number"
                      value={o.priceCop}
                      onChange={(e) => updateOpt(o.id, { priceCop: e.target.value })}
                      step={100}
                      className="w-20 h-8 px-2 rounded border border-op-border bg-op-surface text-right tabular text-xs"
                    />
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div>
            <div className="font-mono text-[10px] tracking-[0.14em] uppercase text-op-muted mb-1">
              {tr("convertTargetHeading")}
            </div>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={tr("convertSearch")}
              className="h-9 px-3 rounded-lg border border-op-border bg-op-bg text-sm w-full mb-2"
            />
            <div className="max-h-40 overflow-y-auto space-y-1">
              {filteredTargets.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setTargetId(t.id)}
                  className={
                    "w-full text-left px-3 py-2 rounded-lg border text-sm " +
                    (t.id === targetId
                      ? "border-terracotta bg-terracotta/5"
                      : "border-op-border hover:bg-op-bg")
                  }
                >
                  {t.name}
                </button>
              ))}
            </div>
          </div>

          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={deleteSource}
              onChange={(e) => setDeleteSource(e.target.checked)}
              className="w-4 h-4"
            />
            <span className="text-sm">{tr("convertDeleteSource")}</span>
          </label>
        </div>

        {err && <p className="text-sm text-danger shrink-0">{err}</p>}
        <div className="flex items-center justify-end gap-2 pt-1 shrink-0">
          <button
            onClick={onClose}
            disabled={busy}
            className="h-10 px-4 rounded-full border border-op-border text-sm font-medium disabled:opacity-50"
          >
            {tr("cancel")}
          </button>
          <button
            onClick={apply}
            disabled={busy || !target || includedOpts.length === 0}
            className="h-10 px-5 rounded-full bg-ink text-bone text-sm font-medium disabled:opacity-50"
          >
            {busy
              ? tr("convertApplying")
              : target
                ? tr("convertApply", { name: target.name })
                : tr("convertApplyNoTarget")}
          </button>
        </div>
      </div>
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
    // Acepta coma o punto y redondea a décimas de minuto (6 s). null si está
    // vacío o no es válido — la validación de abajo lo rechaza.
    const mins = parsePrepMinutes(prepMinutes);
    if (!name.trim() || !Number.isFinite(cents) || cents < 0) {
      setErr(tr("errCheckNamePrice"));
      return;
    }
    if (mins == null || mins < 0.1 || mins > 120) {
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
            type="text"
            inputMode="decimal"
            value={prepMinutes}
            onChange={(e) => setPrepMinutes(e.target.value)}
            placeholder="0.5"
            className="h-10 px-3 rounded-lg border border-op-border bg-op-bg text-sm"
          />
          <PrepHint raw={prepMinutes} />
        </label>
      </div>
      <label className="flex flex-col">
        <span className="font-mono text-[10px] tracking-[0.14em] uppercase text-op-muted mb-1">
          {tr("fieldDescriptionOptional")}
        </span>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          maxLength={500}
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

// Formatos de imagen que aceptamos al subir/soltar una foto de producto.
// Debe coincidir con el `accept` del input y con la validación del endpoint
// /api/operator/uploads.
const ACCEPTED_PHOTO_TYPES = ["image/jpeg", "image/png", "image/webp"];

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
  const [dragOver, setDragOver] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Opciones de categoría ordenadas jerárquicamente: cada categoría principal
  // seguida de sus subcategorías, etiquetadas "Principal › Subcategoría" para
  // que se vea cuál es cuál en el selector.
  const categoryOptions: { id: string; label: string }[] = [];
  for (const top of categories.filter((c) => !c.parentId)) {
    categoryOptions.push({ id: top.id, label: top.label });
    for (const child of categories.filter((c) => c.parentId === top.id)) {
      categoryOptions.push({
        id: child.id,
        label: tr("categoryWithParent", {
          parent: top.label,
          child: child.label,
        }),
      });
    }
  }
  // Defensivo: cualquier categoría no incluida (no debería pasar) al final.
  const seenCatOpt = new Set(categoryOptions.map((o) => o.id));
  for (const c of categories) {
    if (seenCatOpt.has(c.id)) continue;
    const parent = c.parentId
      ? categories.find((x) => x.id === c.parentId)
      : null;
    categoryOptions.push({
      id: c.id,
      label: parent
        ? tr("categoryWithParent", { parent: parent.label, child: c.label })
        : c.label,
    });
  }

  async function onPhotoPick(file: File) {
    // Validamos el tipo en el cliente para no gastar una subida con un PDF u
    // otro archivo arrastrado por error; el endpoint igual lo revalida.
    if (!ACCEPTED_PHOTO_TYPES.includes(file.type)) {
      setErr(tr("errPhotoType"));
      return;
    }
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

  function onPhotoDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(false);
    if (uploading) return;
    const file = e.dataTransfer.files?.[0];
    if (file) onPhotoPick(file);
  }

  async function save() {
    const cents = Math.round(Number(priceCents) * 100);
    // Acepta coma o punto y redondea a décimas de minuto (6 s). null si está
    // vacío o no es válido — la validación de abajo lo rechaza.
    const mins = parsePrepMinutes(prepMinutes);
    if (!name.trim() || !Number.isFinite(cents) || cents < 0) {
      setErr(tr("errCheckNamePrice"));
      return;
    }
    if (mins == null || mins < 0.1 || mins > 120) {
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
      const j = (await res.json().catch(() => ({}))) as {
        error?: string;
        field?: string | null;
      };
      setErr(
        j.field
          ? tr("errInvalidField", { field: j.field })
          : (j.error ?? tr("errGeneric")),
      );
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
      {/* Tarjeta centrada en todos los tamaños. (Antes era hoja inferior con
          items-end, pero en iOS `fixed inset-0` usa el viewport "grande", así
          que la hoja quedaba anclada por debajo de la barra de Safari y se veía
          un hueco abajo.) max-h en dvh para que iOS no la corte con la barra. */}
      <div
        className="bg-op-surface text-op-text w-full sm:max-w-xl max-h-[92dvh] rounded-2xl overflow-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-4 sm:p-6 space-y-4">
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

          {/* Móvil: nombre en su propia fila; precio y tiempo comparten una
              fila debajo. Desktop: los tres en línea. */}
          <div className="flex flex-col sm:flex-row gap-3">
            <label className="flex flex-col sm:flex-1">
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
            <div className="flex gap-3">
              <label className="flex-1 sm:w-32 sm:flex-none flex flex-col">
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
              <label className="w-24 shrink-0 flex flex-col">
                <span className="font-mono text-[10px] tracking-[0.14em] uppercase text-op-muted mb-1">
                  {tr("fieldPrep")}
                </span>
                <input
                  type="text"
                  inputMode="decimal"
                  value={prepMinutes}
                  onChange={(e) => setPrepMinutes(e.target.value)}
                  placeholder="0.5"
                  className="h-10 px-3 rounded-lg border border-op-border bg-op-bg text-sm"
                />
                <PrepHint raw={prepMinutes} />
              </label>
            </div>
          </div>

          <label className="flex flex-col">
            <span className="font-mono text-[10px] tracking-[0.14em] uppercase text-op-muted mb-1">
              {tr("fieldDescription")}
            </span>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={500}
              rows={3}
              className="px-3 py-2 rounded-lg border border-op-border bg-op-bg text-sm"
            />
          </label>

          <div className="flex flex-col">
            <span className="font-mono text-[10px] tracking-[0.14em] uppercase text-op-muted mb-1">
              {tr("fieldPhoto")}
            </span>
            {/* Toda la fila es zona de drop: se puede arrastrar una imagen
                desde el escritorio y soltarla encima. El botón de click sigue
                disponible como alternativa. */}
            <div
              onDragOver={(e) => {
                e.preventDefault();
                if (!uploading) setDragOver(true);
              }}
              onDragLeave={() => setDragOver(false)}
              onDrop={onPhotoDrop}
              className={
                "relative flex items-center gap-3 rounded-lg -m-2 p-2 transition-colors " +
                (dragOver ? "ring-2 ring-terracotta bg-terracotta/5" : "")
              }
            >
              <div
                className={
                  "w-20 h-20 rounded-lg bg-op-bg bg-cover bg-center shrink-0 border " +
                  (photoUrl ? "border-op-border" : "border-dashed border-op-border")
                }
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
              {dragOver && (
                <div className="pointer-events-none absolute inset-0 rounded-lg bg-op-surface/85 flex items-center justify-center text-sm font-medium text-terracotta">
                  {tr("dropPhotoHere")}
                </div>
              )}
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
              {categoryOptions.map((c) => (
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

  // Reordena los grupos de modificadores (↑/↓). El orden se refleja tal cual en
  // la carta del comensal. Es estado local: se persiste al guardar el plato.
  function move(ix: number, dir: "up" | "down") {
    const j = dir === "up" ? ix - 1 : ix + 1;
    if (j < 0 || j >= modifiers.length) return;
    const next = [...modifiers];
    [next[ix], next[j]] = [next[j], next[ix]];
    onChange(next);
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
            key={m.id}
            className="border border-op-border rounded-lg p-3 bg-op-bg/50 space-y-2"
          >
            {/* Móvil: la etiqueta ocupa toda la fila y tipo/flechas/✕ caen a la
                siguiente; desktop: todo en línea. */}
            <div className="flex flex-wrap gap-2 items-end">
              <label className="basis-full sm:basis-auto sm:flex-1 flex flex-col">
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
              {modifiers.length > 1 && (
                <div className="flex flex-col shrink-0 self-end mb-1">
                  <button
                    type="button"
                    aria-label={tr("moveModifierUp")}
                    onClick={() => move(i, "up")}
                    disabled={i <= 0}
                    className="h-4 w-5 leading-none text-sm text-op-muted hover:text-ink disabled:opacity-25"
                  >
                    <span aria-hidden>↑</span>
                  </button>
                  <button
                    type="button"
                    aria-label={tr("moveModifierDown")}
                    onClick={() => move(i, "down")}
                    disabled={i >= modifiers.length - 1}
                    className="h-4 w-5 leading-none text-sm text-op-muted hover:text-ink disabled:opacity-25"
                  >
                    <span aria-hidden>↓</span>
                  </button>
                </div>
              )}
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

function NoteIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M3 3.5h10M3 7h10M3 10.5h6"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
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
  // Qué opciones tienen abierto el campo de descripción (por label, que es
  // estable — la etiqueta no se renombra inline). Las que ya tienen
  // descripción se muestran abiertas igual.
  const [openDesc, setOpenDesc] = useState<Set<string>>(new Set());
  function toggleDesc(label: string) {
    setOpenDesc((prev) => {
      const next = new Set(prev);
      if (next.has(label)) next.delete(label);
      else next.add(label);
      return next;
    });
  }

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

  // Reordena las opciones dentro del modificador (↑/↓). Mantiene el default.
  function moveOpt(ix: number, dir: "up" | "down") {
    const j = dir === "up" ? ix - 1 : ix + 1;
    if (j < 0 || j >= opts.length) return;
    const next = [...opts];
    [next[ix], next[j]] = [next[j], next[ix]];
    onChange(next, defaultOpt);
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
    const next = opts.map((o, i): ModOpt => {
      if (i !== ix) return o;
      const opt: ModOpt = { label: o.label };
      if (delta !== undefined) opt.priceDeltaCents = delta;
      if (o.description) opt.description = o.description; // preservar
      return opt;
    });
    onChange(next, defaultOpt);
  }

  function setOptDescription(ix: number, raw: string) {
    const next = opts.map((o, i): ModOpt => {
      if (i !== ix) return o;
      const opt: ModOpt = { label: o.label };
      if (o.priceDeltaCents != null) opt.priceDeltaCents = o.priceDeltaCents;
      if (raw.trim()) opt.description = raw;
      return opt;
    });
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
                "rounded-lg border " +
                (isDefault
                  ? "bg-ink/5 border-ink/30"
                  : "bg-op-surface border-op-border")
              }
            >
              <div className="flex items-center gap-2 px-2 py-1.5">
                {opts.length > 1 && (
                  <div className="flex flex-col shrink-0 -my-0.5">
                    <button
                      type="button"
                      aria-label={tr("moveOptionUp")}
                      onClick={() => moveOpt(i, "up")}
                      disabled={i <= 0}
                      className="h-3.5 w-4 leading-none text-[11px] text-op-muted hover:text-ink disabled:opacity-25"
                    >
                      <span aria-hidden>↑</span>
                    </button>
                    <button
                      type="button"
                      aria-label={tr("moveOptionDown")}
                      onClick={() => moveOpt(i, "down")}
                      disabled={i >= opts.length - 1}
                      className="h-3.5 w-4 leading-none text-[11px] text-op-muted hover:text-ink disabled:opacity-25"
                    >
                      <span aria-hidden>↓</span>
                    </button>
                  </div>
                )}
                <span className="flex-1 text-sm truncate">{o.label}</span>
                {/* Ícono para agregar/editar la descripción de la opción
                    (se muestra al comensal). Si ya hay descripción, queda
                    resaltado y el campo aparece abierto. */}
                <button
                  type="button"
                  onClick={() => toggleDesc(o.label)}
                  aria-label={tr("optionDescAdd")}
                  title={tr("optionDescAdd")}
                  className={
                    "w-7 h-7 rounded-full inline-flex items-center justify-center shrink-0 hover:bg-op-border/40 " +
                    (o.description ? "text-terracotta" : "text-op-muted")
                  }
                >
                  <NoteIcon />
                </button>
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
              {(openDesc.has(o.label) || !!o.description) && (
                <div className="px-2 pb-2">
                  <input
                    value={o.description ?? ""}
                    onChange={(e) => setOptDescription(i, e.target.value)}
                    maxLength={200}
                    placeholder={tr("optionDescPlaceholder")}
                    className="w-full h-8 px-2 rounded border border-op-border bg-op-bg text-xs"
                  />
                </div>
              )}
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
