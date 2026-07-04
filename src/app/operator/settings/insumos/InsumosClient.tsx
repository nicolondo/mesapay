"use client";

import { useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import {
  BASE_UNIT_SYMBOL,
  DISPLAY_UNITS,
  MEASURE_KINDS,
  type MeasureKind,
} from "@/lib/erp/units";

type Ingredient = {
  id: string;
  name: string;
  category: string | null;
  measureKind: MeasureKind;
  sku: string | null;
  notes: string | null;
  active: boolean;
  _count: { supplierItems: number };
};

// Clave i18n por dimensión — resuelta con t() al render para que el
// label quede trilingüe (el measureKind es el valor de la capa lógica).
const DIM_LABEL_KEYS: Record<MeasureKind, string> = {
  mass: "dimMass",
  volume: "dimVolume",
  count: "dimCount",
};

/** "g/kg", "ml/L", "un" — símbolos de unidad, iguales en es/en/pt. */
function unitSymbols(kind: MeasureKind): string {
  return DISPLAY_UNITS[kind].map((u) => u.symbol).join("/");
}

/** Ej.: "Peso (g)" — label traducido + símbolo de la unidad base. */
function dimLabel(t: (k: string) => string, kind: MeasureKind): string {
  return `${t(DIM_LABEL_KEYS[kind])} (${BASE_UNIT_SYMBOL[kind]})`;
}

/** Búsqueda sin acentos: minúsculas + tildes fuera ("azucar" → "azúcar"). */
function fold(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
}

type ActiveFilter = "active" | "inactive" | "all";
type SheetState = { mode: "create" } | { mode: "edit"; item: Ingredient };

export function InsumosClient({ initial }: { initial: Ingredient[] }) {
  const t = useTranslations("opErp");
  const [items, setItems] = useState<Ingredient[]>(initial);
  const [q, setQ] = useState("");
  const [cat, setCat] = useState<string>("all");
  const [activeFilter, setActiveFilter] = useState<ActiveFilter>("all");
  const [sheet, setSheet] = useState<SheetState | null>(null);
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);

  // Categorías existentes del comercio (sin taxonomía impuesta): alimentan
  // el filtro y el datalist del formulario.
  const categories = useMemo(() => {
    const set = new Set<string>();
    for (const i of items) if (i.category) set.add(i.category);
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [items]);

  const filtered = useMemo(() => {
    const needle = fold(q.trim());
    return items.filter((i) => {
      if (activeFilter === "active" && !i.active) return false;
      if (activeFilter === "inactive" && i.active) return false;
      if (cat !== "all" && i.category !== cat) return false;
      if (needle) {
        const hay = fold(`${i.name} ${i.category ?? ""}`);
        if (!hay.includes(needle)) return false;
      }
      return true;
    });
  }, [items, q, cat, activeFilter]);

  function upsert(saved: Ingredient) {
    setItems((prev) => {
      const exists = prev.some((x) => x.id === saved.id);
      const next = exists
        ? prev.map((x) => (x.id === saved.id ? saved : x))
        : [...prev, saved];
      // Mismo orden que el server: activos primero, luego alfabético.
      return next.sort(
        (a, b) =>
          Number(b.active) - Number(a.active) || a.name.localeCompare(b.name),
      );
    });
  }

  async function toggleActive(item: Ingredient) {
    setTogglingId(item.id);
    setRowError(null);
    const r = await fetch(`/api/operator/ingredients/${item.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ active: !item.active }),
    });
    setTogglingId(null);
    if (!r.ok) {
      setRowError(t("errSaveFailed"));
      return;
    }
    const j = await r.json();
    // El PATCH no incluye _count — se preserva el del row local.
    upsert({ ...(j.ingredient as Ingredient), _count: item._count });
  }

  return (
    <div className="space-y-4">
      {/* Crear + búsqueda + filtros */}
      <button
        type="button"
        onClick={() => setSheet({ mode: "create" })}
        className="w-full min-h-[44px] rounded-full bg-ink text-bone text-sm font-medium hover:bg-ink/90"
      >
        {t("newIngredient")}
      </button>

      <div className="space-y-2">
        <input
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={t("searchPlaceholder")}
          className="w-full min-h-[44px] px-4 rounded-full border border-op-border bg-op-surface text-sm focus:outline-none focus:border-op-text/40"
        />
        <div className="flex items-center gap-2 flex-wrap">
          <select
            value={cat}
            onChange={(e) => setCat(e.target.value)}
            className="min-h-[44px] px-3 rounded-full border border-op-border bg-op-surface text-sm max-w-[220px]"
          >
            <option value="all">{t("allCategories")}</option>
            {categories.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
          <div className="inline-flex rounded-full border border-op-border bg-op-surface overflow-hidden">
            {(
              [
                ["all", t("filterAll")],
                ["active", t("filterActive")],
                ["inactive", t("filterInactive")],
              ] as [ActiveFilter, string][]
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                onClick={() => setActiveFilter(value)}
                className={
                  "min-h-[44px] px-4 text-xs font-medium transition-colors " +
                  (activeFilter === value
                    ? "bg-ink text-bone"
                    : "text-op-muted hover:text-ink")
                }
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {rowError && <div className="text-xs text-danger">{rowError}</div>}

      {/* Lista */}
      {items.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-op-border bg-op-surface/50 p-8 text-center">
          <div className="font-display text-lg mb-1">{t("emptyTitle")}</div>
          <p className="text-sm text-op-muted">{t("emptyBody")}</p>
        </div>
      ) : filtered.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-op-border bg-op-surface/50 p-8 text-center text-sm text-op-muted">
          {t("emptyFiltered")}
        </div>
      ) : (
        <div className="bg-op-surface border border-op-border rounded-2xl overflow-hidden">
          {filtered.map((i) => (
            <div
              key={i.id}
              className="flex items-center gap-3 px-4 py-2 border-b border-op-border last:border-b-0"
            >
              <button
                type="button"
                onClick={() => setSheet({ mode: "edit", item: i })}
                className="flex-1 min-w-0 min-h-[44px] py-1.5 text-left"
              >
                <div className="flex items-center gap-2 min-w-0">
                  <span
                    className={
                      "text-sm font-medium truncate" +
                      (i.active ? "" : " opacity-50")
                    }
                  >
                    {i.name}
                  </span>
                  {!i.active && (
                    <span className="px-2 h-5 inline-flex items-center rounded-full bg-paper text-op-muted text-[10px] font-medium shrink-0">
                      {t("inactiveBadge")}
                    </span>
                  )}
                </div>
                <div className="text-[11px] text-op-muted mt-0.5 truncate">
                  {[
                    i.category ?? t("noCategory"),
                    dimLabel(t, i.measureKind),
                    t("supplierCount", { count: i._count.supplierItems }),
                  ].join(" · ")}
                </div>
              </button>
              <button
                type="button"
                onClick={() => toggleActive(i)}
                disabled={togglingId === i.id}
                className={
                  "min-h-[44px] px-3 rounded-full text-[11px] font-medium shrink-0 disabled:opacity-40 " +
                  (i.active
                    ? "text-danger hover:bg-danger/10"
                    : "text-ok hover:bg-ok/10")
                }
              >
                {i.active ? t("deactivate") : t("reactivate")}
              </button>
            </div>
          ))}
        </div>
      )}

      {sheet && (
        <IngredientSheet
          editing={sheet.mode === "edit" ? sheet.item : null}
          categories={categories}
          onClose={() => setSheet(null)}
          onSaved={(saved) => {
            upsert(saved);
            setSheet(null);
          }}
        />
      )}
    </div>
  );
}

function IngredientSheet({
  editing,
  categories,
  onClose,
  onSaved,
}: {
  editing: Ingredient | null;
  categories: string[];
  onClose: () => void;
  onSaved: (i: Ingredient) => void;
}) {
  const t = useTranslations("opErp");
  const [name, setName] = useState(editing?.name ?? "");
  const [category, setCategory] = useState(editing?.category ?? "");
  const [measureKind, setMeasureKind] = useState<MeasureKind>(
    editing?.measureKind ?? "mass",
  );
  const [sku, setSku] = useState(editing?.sku ?? "");
  const [notes, setNotes] = useState(editing?.notes ?? "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Con referencias (lista de precios hoy; movimientos/recetas mañana) la
  // dimensión queda bloqueada — cambiarla corrompería cantidades históricas.
  const measureLocked = (editing?._count.supplierItems ?? 0) > 0;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    const payload: Record<string, unknown> = {
      name: name.trim(),
      category: category.trim() || null,
      sku: sku.trim() || null,
      notes: notes.trim() || null,
    };
    // Con la dimensión bloqueada ni siquiera se manda el campo.
    if (!measureLocked) payload.measureKind = measureKind;

    const r = await fetch(
      editing
        ? `/api/operator/ingredients/${editing.id}`
        : "/api/operator/ingredients",
      {
        method: editing ? "PATCH" : "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      },
    );
    setBusy(false);
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      setErr(
        j.error === "name_taken"
          ? t("errNameTaken")
          : j.error === "measure_locked"
            ? t("errMeasureLocked")
            : t("errSaveFailed"),
      );
      return;
    }
    const j = await r.json();
    // POST/PATCH no incluyen _count — nuevo insumo arranca sin proveedores.
    onSaved({
      ...(j.ingredient as Ingredient),
      _count: { supplierItems: editing?._count.supplierItems ?? 0 },
    });
  }

  return (
    <div
      className="fixed inset-0 z-50 bg-ink/40 flex items-end md:items-center justify-center p-0 md:p-6"
      onClick={onClose}
    >
      <div
        className="w-full md:max-w-lg bg-op-surface rounded-t-3xl md:rounded-3xl border border-op-border p-5 max-h-[90dvh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3 mb-4">
          <h2 className="font-display text-2xl">
            {editing ? t("editIngredient") : t("newIngredient")}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="text-op-muted text-sm shrink-0 min-h-[44px] min-w-[44px] -mt-2 -mr-2"
            aria-label={t("cancel")}
          >
            {"✕"}
          </button>
        </div>

        <form onSubmit={submit} className="space-y-3">
          <Field label={t("fieldName")} required>
            <input
              type="text"
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t("namePlaceholder")}
              maxLength={120}
              className={inputCls}
            />
          </Field>

          <Field label={t("fieldCategory")}>
            <input
              type="text"
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              placeholder={t("categoryPlaceholder")}
              maxLength={60}
              list="insumo-categories"
              className={inputCls}
            />
            <datalist id="insumo-categories">
              {categories.map((c) => (
                <option key={c} value={c} />
              ))}
            </datalist>
          </Field>

          <Field
            label={t("fieldMeasure")}
            required
            hint={measureLocked ? undefined : t("measureHint")}
          >
            {measureLocked ? (
              <>
                <div className="min-h-[44px] px-3 rounded-lg border border-op-border bg-op-bg/60 text-sm text-op-muted flex items-center">
                  {`${t(DIM_LABEL_KEYS[measureKind])} — ${unitSymbols(measureKind)}`}
                </div>
                <div className="text-[10px] text-op-muted mt-1">
                  {t("measureLockedHint")}
                </div>
              </>
            ) : (
              <div className="grid grid-cols-3 gap-2">
                {MEASURE_KINDS.map((k) => (
                  <button
                    key={k}
                    type="button"
                    onClick={() => setMeasureKind(k)}
                    className={
                      "min-h-[44px] px-2 py-2 rounded-xl border text-center transition-colors " +
                      (measureKind === k
                        ? "border-ink bg-ink text-bone"
                        : "border-op-border bg-op-bg hover:bg-op-surface")
                    }
                  >
                    <div className="text-xs font-medium">
                      {t(DIM_LABEL_KEYS[k])}
                    </div>
                    <div
                      className={
                        "font-mono text-[10px] mt-0.5 " +
                        (measureKind === k ? "text-bone/70" : "text-op-muted")
                      }
                    >
                      {unitSymbols(k)}
                    </div>
                  </button>
                ))}
              </div>
            )}
          </Field>

          <Field label={t("fieldSku")}>
            <input
              type="text"
              value={sku}
              onChange={(e) => setSku(e.target.value)}
              placeholder={t("skuPlaceholder")}
              maxLength={60}
              className={inputCls}
            />
          </Field>

          <Field label={t("fieldNotes")}>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              maxLength={1000}
              rows={3}
              className="w-full px-3 py-2 rounded-lg border border-op-border bg-op-bg text-sm focus:outline-none focus:border-op-text/40"
            />
          </Field>

          {err && <div className="text-xs text-danger">{err}</div>}

          <div className="flex items-center justify-end gap-3 pt-1">
            <button
              type="button"
              onClick={onClose}
              className="min-h-[44px] px-4 rounded-full bg-op-bg border border-op-border text-sm font-medium hover:bg-op-surface"
            >
              {t("cancel")}
            </button>
            <button
              type="submit"
              disabled={busy || name.trim().length === 0}
              className="min-h-[44px] px-5 rounded-full bg-ink text-bone text-sm font-medium disabled:opacity-40"
            >
              {busy ? t("saving") : t("save")}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function Field({
  label,
  required,
  hint,
  children,
}: {
  label: string;
  required?: boolean;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <div className="font-mono text-[10px] tracking-[0.15em] uppercase text-op-muted mb-1">
        {label}
        {required && <span className="text-danger ml-1">{"*"}</span>}
      </div>
      {children}
      {hint && <div className="text-[10px] text-op-muted mt-1">{hint}</div>}
    </label>
  );
}

const inputCls =
  "w-full min-h-[44px] px-3 rounded-lg border border-op-border bg-op-bg text-sm focus:outline-none focus:border-op-text/40";
