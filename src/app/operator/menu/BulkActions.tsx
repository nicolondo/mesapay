"use client";

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import type { Cat, Item, PrepStation } from "./types";

// Barra fija inferior + hojas (sheets) de acciones masivas para el editor de
// carta. La selección vive en MenuEditor; acá solo recibimos los platos
// seleccionados y devolvemos los cambios al padre para que parchee su estado
// local (sin recargar la página).

type Sheet = null | "describe" | "category" | "station" | "delete";

export function BulkActionBar({
  selectedItems,
  categories,
  visibleCount,
  allVisibleSelected,
  onSelectAllVisible,
  onClear,
  onDescriptionsApplied,
  onCategoryApplied,
  onStationApplied,
  onDeleted,
}: {
  selectedItems: Item[];
  categories: Cat[];
  visibleCount: number;
  allVisibleSelected: boolean;
  onSelectAllVisible: () => void;
  onClear: () => void;
  onDescriptionsApplied: (updates: { id: string; description: string }[]) => void;
  onCategoryApplied: (itemIds: string[], categoryId: string) => void;
  onStationApplied: (itemIds: string[], prepStation: PrepStation | null) => void;
  onDeleted: (deletedIds: string[], archivedIds: string[]) => void;
}) {
  const tr = useTranslations("opMenuEditor");
  const [sheet, setSheet] = useState<Sheet>(null);
  const count = selectedItems.length;
  const ids = selectedItems.map((i) => i.id);

  if (count === 0) return null;

  const btn =
    "h-9 px-3 rounded-full text-xs font-medium border border-op-border bg-op-bg hover:bg-op-surface whitespace-nowrap";

  return (
    <>
      <div className="fixed inset-x-0 bottom-0 z-40 bg-op-surface border-t border-op-border shadow-[0_-4px_20px_rgba(0,0,0,0.12)]">
        <div className="max-w-5xl mx-auto px-4 py-3 flex items-center gap-2 flex-wrap pb-[max(0.75rem,env(safe-area-inset-bottom))]">
          <span className="text-sm font-semibold">
            {tr("bulkSelected", { count })}
          </span>
          <button onClick={onSelectAllVisible} className="text-xs text-terracotta hover:underline">
            {allVisibleSelected
              ? tr("bulkSelectNone")
              : tr("bulkSelectAll", { count: visibleCount })}
          </button>
          <button onClick={onClear} className="text-xs text-op-muted hover:text-ink">
            {tr("bulkClear")}
          </button>
          <div className="flex-1 min-w-[8px]" />
          <button onClick={() => setSheet("describe")} className={btn}>
            <span aria-hidden>🧠</span> {tr("bulkDescribe")}
          </button>
          <button onClick={() => setSheet("category")} className={btn}>
            {tr("bulkChangeCategory")}
          </button>
          <button onClick={() => setSheet("station")} className={btn}>
            {tr("bulkChangeStation")}
          </button>
          <button
            onClick={() => setSheet("delete")}
            className="h-9 px-3 rounded-full text-xs font-medium border border-danger/40 text-danger hover:bg-danger/10 whitespace-nowrap"
          >
            {tr("bulkDelete")}
          </button>
        </div>
      </div>

      {sheet === "describe" && (
        <DescribeSheet
          items={selectedItems}
          onClose={() => setSheet(null)}
          onApplied={(updates) => {
            onDescriptionsApplied(updates);
            setSheet(null);
            onClear();
          }}
        />
      )}
      {sheet === "category" && (
        <CategorySheet
          count={count}
          categories={categories}
          onClose={() => setSheet(null)}
          onApplied={(categoryId) => {
            onCategoryApplied(ids, categoryId);
            setSheet(null);
            onClear();
          }}
          itemIds={ids}
        />
      )}
      {sheet === "station" && (
        <StationSheet
          count={count}
          itemIds={ids}
          onClose={() => setSheet(null)}
          onApplied={(station) => {
            onStationApplied(ids, station);
            setSheet(null);
            onClear();
          }}
        />
      )}
      {sheet === "delete" && (
        <DeleteSheet
          count={count}
          itemIds={ids}
          onClose={() => setSheet(null)}
          onApplied={(deletedIds, archivedIds) => {
            onDeleted(deletedIds, archivedIds);
            setSheet(null);
            onClear();
          }}
        />
      )}
    </>
  );
}

function Overlay({
  children,
  onClose,
}: {
  children: React.ReactNode;
  onClose: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-op-surface text-op-text w-full max-w-lg rounded-2xl p-6 space-y-4 max-h-[85vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}

type Proposal = { id: string; name: string; description: string; include: boolean };

function DescribeSheet({
  items,
  onClose,
  onApplied,
}: {
  items: Item[];
  onClose: () => void;
  onApplied: (updates: { id: string; description: string }[]) => void;
}) {
  const tr = useTranslations("opMenuEditor");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [saving, setSaving] = useState(false);
  // Evita doble disparo en StrictMode / re-render.
  const startedRef = useRef(false);

  async function generate() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/operator/menu-items/bulk", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "generate-descriptions",
          itemIds: items.map((i) => i.id),
        }),
      });
      if (!res.ok) {
        setError(tr("describeError"));
        setLoading(false);
        return;
      }
      const j = (await res.json()) as {
        results: { id: string; name: string; description: string }[];
      };
      setProposals(
        j.results.map((r) => ({
          id: r.id,
          name: r.name,
          description: r.description,
          // No tildamos los que la IA dejó vacíos.
          include: r.description.trim().length > 0,
        })),
      );
      setLoading(false);
    } catch {
      setError(tr("describeError"));
      setLoading(false);
    }
  }

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    void generate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const includedCount = proposals.filter(
    (p) => p.include && p.description.trim().length > 0,
  ).length;

  async function save() {
    const updates = proposals
      .filter((p) => p.include && p.description.trim().length > 0)
      .map((p) => ({ id: p.id, description: p.description.trim() }));
    if (updates.length === 0) return;
    setSaving(true);
    setError(null);
    const res = await fetch("/api/operator/menu-items/bulk", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "set-descriptions", items: updates }),
    });
    setSaving(false);
    if (!res.ok) {
      setError(tr("bulkErr"));
      return;
    }
    onApplied(updates);
  }

  return (
    <Overlay onClose={saving ? () => {} : onClose}>
      <div className="font-display text-2xl shrink-0">{tr("describeTitle")}</div>

      {loading && (
        <div className="text-sm text-op-muted py-8 text-center">
          {tr("describeLoading", { count: items.length })}
        </div>
      )}

      {!loading && error && (
        <div className="space-y-3">
          <p className="text-sm text-danger">{error}</p>
          <button
            onClick={() => void generate()}
            className="h-10 px-4 rounded-full border border-op-border text-sm font-medium"
          >
            {tr("describeRetry")}
          </button>
        </div>
      )}

      {!loading && !error && (
        <>
          <p className="text-sm text-op-muted shrink-0">{tr("describeIntro")}</p>
          <div className="flex-1 overflow-y-auto -mx-2 px-2 space-y-3">
            {proposals.map((p, idx) => (
              <div
                key={p.id}
                className="rounded-xl border border-op-border p-3 space-y-2"
              >
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={p.include}
                    onChange={(e) =>
                      setProposals((prev) =>
                        prev.map((x, i) =>
                          i === idx ? { ...x, include: e.target.checked } : x,
                        ),
                      )
                    }
                    className="w-4 h-4"
                  />
                  <span className="font-medium text-sm truncate">{p.name}</span>
                </label>
                <textarea
                  value={p.description}
                  onChange={(e) =>
                    setProposals((prev) =>
                      prev.map((x, i) =>
                        i === idx ? { ...x, description: e.target.value } : x,
                      ),
                    )
                  }
                  maxLength={500}
                  rows={2}
                  placeholder={tr("describeEmptyRow")}
                  className="w-full px-3 py-2 rounded-lg border border-op-border bg-op-bg text-sm"
                />
              </div>
            ))}
          </div>
          <div className="flex items-center justify-end gap-2 pt-1 shrink-0">
            <button
              onClick={onClose}
              disabled={saving}
              className="h-10 px-4 rounded-full border border-op-border text-sm font-medium disabled:opacity-50"
            >
              {tr("cancel")}
            </button>
            <button
              onClick={save}
              disabled={saving || includedCount === 0}
              className="h-10 px-5 rounded-full bg-ink text-bone text-sm font-medium disabled:opacity-50"
            >
              {saving
                ? tr("describeSaving")
                : tr("describeSave", { count: includedCount })}
            </button>
          </div>
        </>
      )}
    </Overlay>
  );
}

function CategorySheet({
  count,
  categories,
  itemIds,
  onClose,
  onApplied,
}: {
  count: number;
  categories: Cat[];
  itemIds: string[];
  onClose: () => void;
  onApplied: (categoryId: string) => void;
}) {
  const tr = useTranslations("opMenuEditor");
  const [categoryId, setCategoryId] = useState(categories[0]?.id ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Opciones ordenadas jerárquicamente (principal y debajo sus subcategorías,
  // etiquetadas "Principal › Subcategoría") para distinguirlas en el selector.
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

  async function apply() {
    if (!categoryId) return;
    setBusy(true);
    setError(null);
    const res = await fetch("/api/operator/menu-items/bulk", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "set-category", itemIds, categoryId }),
    });
    setBusy(false);
    if (!res.ok) {
      setError(tr("bulkErr"));
      return;
    }
    onApplied(categoryId);
  }

  return (
    <Overlay onClose={busy ? () => {} : onClose}>
      <div className="font-display text-2xl">{tr("catSheetTitle")}</div>
      <label className="flex flex-col gap-1">
        <span className="font-mono text-[10px] tracking-[0.14em] uppercase text-op-muted">
          {tr("catSheetLabel")}
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
      {error && <p className="text-sm text-danger">{error}</p>}
      <div className="flex items-center justify-end gap-2 pt-1">
        <button
          onClick={onClose}
          disabled={busy}
          className="h-10 px-4 rounded-full border border-op-border text-sm font-medium disabled:opacity-50"
        >
          {tr("cancel")}
        </button>
        <button
          onClick={apply}
          disabled={busy || !categoryId}
          className="h-10 px-5 rounded-full bg-ink text-bone text-sm font-medium disabled:opacity-50"
        >
          {tr("catSheetApply", { count })}
        </button>
      </div>
    </Overlay>
  );
}

function StationSheet({
  count,
  itemIds,
  onClose,
  onApplied,
}: {
  count: number;
  itemIds: string[];
  onClose: () => void;
  onApplied: (station: PrepStation | null) => void;
}) {
  const tr = useTranslations("opMenuEditor");
  // "inherit" = null (usa la estación de la categoría).
  const [choice, setChoice] = useState<"inherit" | PrepStation>("kitchen");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const options: { value: "inherit" | PrepStation; label: string }[] = [
    { value: "kitchen", label: tr("stationKitchen") },
    { value: "bar", label: tr("stationBar") },
    { value: "counter", label: tr("stationCounter") },
    { value: "inherit", label: tr("stationInherit") },
  ];

  async function apply() {
    setBusy(true);
    setError(null);
    const prepStation = choice === "inherit" ? null : choice;
    const res = await fetch("/api/operator/menu-items/bulk", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "set-station", itemIds, prepStation }),
    });
    setBusy(false);
    if (!res.ok) {
      setError(tr("bulkErr"));
      return;
    }
    onApplied(prepStation);
  }

  return (
    <Overlay onClose={busy ? () => {} : onClose}>
      <div className="font-display text-2xl">{tr("stationSheetTitle")}</div>
      <div className="space-y-2">
        {options.map((o) => (
          <label
            key={o.value}
            className="flex items-center gap-3 cursor-pointer rounded-lg border border-op-border px-3 py-2"
          >
            <input
              type="radio"
              name="bulk-station"
              checked={choice === o.value}
              onChange={() => setChoice(o.value)}
              className="w-4 h-4"
            />
            <span className="text-sm">{o.label}</span>
          </label>
        ))}
      </div>
      {error && <p className="text-sm text-danger">{error}</p>}
      <div className="flex items-center justify-end gap-2 pt-1">
        <button
          onClick={onClose}
          disabled={busy}
          className="h-10 px-4 rounded-full border border-op-border text-sm font-medium disabled:opacity-50"
        >
          {tr("cancel")}
        </button>
        <button
          onClick={apply}
          disabled={busy}
          className="h-10 px-5 rounded-full bg-ink text-bone text-sm font-medium disabled:opacity-50"
        >
          {tr("stationApply", { count })}
        </button>
      </div>
    </Overlay>
  );
}

function DeleteSheet({
  count,
  itemIds,
  onClose,
  onApplied,
}: {
  count: number;
  itemIds: string[];
  onClose: () => void;
  onApplied: (deletedIds: string[], archivedIds: string[]) => void;
}) {
  const tr = useTranslations("opMenuEditor");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function confirm() {
    setBusy(true);
    setError(null);
    const res = await fetch("/api/operator/menu-items/bulk", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "delete", itemIds }),
    });
    setBusy(false);
    if (!res.ok) {
      setError(tr("bulkErr"));
      return;
    }
    const j = (await res.json()) as {
      deletedIds: string[];
      archivedIds: string[];
    };
    onApplied(j.deletedIds ?? [], j.archivedIds ?? []);
  }

  return (
    <Overlay onClose={busy ? () => {} : onClose}>
      <div className="font-display text-2xl">{tr("deleteSheetTitle")}</div>
      <p className="text-sm text-op-muted">{tr("deleteSheetBody", { count })}</p>
      {error && <p className="text-sm text-danger">{error}</p>}
      <div className="flex items-center justify-end gap-2 pt-1">
        <button
          onClick={onClose}
          disabled={busy}
          className="h-10 px-4 rounded-full border border-op-border text-sm font-medium disabled:opacity-50"
        >
          {tr("cancel")}
        </button>
        <button
          onClick={confirm}
          disabled={busy}
          className="h-10 px-5 rounded-full bg-danger text-bone text-sm font-medium disabled:opacity-50"
        >
          {tr("deleteSheetConfirm", { count })}
        </button>
      </div>
    </Overlay>
  );
}
