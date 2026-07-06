"use client";

import { useEffect, useMemo, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import type { Locale } from "@/i18n/config";
import { formatMoney } from "@/lib/format";
import { grossQty, MAX_WASTE_PCT } from "@/lib/erp/recipes";
import {
  BASE_UNIT_SYMBOL,
  DISPLAY_UNITS,
  formatBaseQty,
  toBaseQty,
  type MeasureKind,
} from "@/lib/erp/units";

/* ───────────────────────────── Tipos ───────────────────────────────── */
// Espejo de GET /api/operator/recipes (el tab Sub-recetas llega en el PR
// siguiente — acá solo se consumen dishes + ingredients).

type CostSource = "stock" | "subrecipe" | "supplier" | null;

type RecipeItemDto = {
  ingredientId: string;
  qtyBase: number;
  wastePct: number;
  ingredientName: string;
  measureKind: MeasureKind;
};

type RecipeDto = {
  id: string;
  notes: string | null;
  items: RecipeItemDto[];
};

type CostLineDto = {
  ingredientId: string;
  qtyBase: number;
  wastePct: number;
  grossQtyBase: number;
  costPerBase: number | null;
  source: CostSource;
  lineCostCents: number | null;
};

type CostDto = {
  costCents: number;
  complete: boolean;
  lines: CostLineDto[];
};

type DishRow = {
  menuItemId: string;
  name: string;
  category: { id: string; label: string };
  priceCents: number;
  available: boolean;
  recipe: RecipeDto | null;
  cost: CostDto | null;
};

type IngredientOption = {
  id: string;
  name: string;
  measureKind: MeasureKind;
  /** Centavos por unidad base (float) o null = sin fuente de costo (D3). */
  costPerBase: number | null;
  costSource: CostSource;
};

/* ─────────────────────────── Helpers ───────────────────────────────── */

/** Búsqueda sin acentos: minúsculas + tildes fuera ("azucar" → "azúcar"). */
function fold(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
}

/** "g/kg", "ml/L", "un" — símbolos de unidad, iguales en es/en/pt. */
function unitSymbols(kind: MeasureKind): string {
  return DISPLAY_UNITS[kind].map((u) => u.symbol).join("/");
}

/** 2500 g → { qty: "2.5", unit: "kg" } — para precargar inputs de cantidad. */
function baseToInputQty(
  base: number,
  kind: MeasureKind,
): { qty: string; unit: string } {
  const units = DISPLAY_UNITS[kind];
  const big = units[units.length - 1];
  if (big.factor > 1 && base >= big.factor) {
    return { qty: String(base / big.factor), unit: big.symbol };
  }
  return { qty: String(base), unit: units[0].symbol };
}

/** "32,5%" con separador decimal del idioma. */
function formatPct(pct: number, locale: string): string {
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(pct)}%`;
}

// Semáforo food cost (spec D6, umbrales estándar fijos en A3):
// ≤30% ok · 30-40% atención (ámbar, mismos tokens del chip "parcial" de
// compras) · >40% rojo.
function foodCostCls(pct: number): string {
  if (pct <= 30) return "text-ok";
  if (pct <= 40) return "text-[#7F5A1F]";
  return "text-danger";
}

// Errores del PUT de receta → clave i18n (fallback errSaveFailed).
const API_ERROR_KEYS: Record<string, string> = {
  invalid: "errLineInvalid",
  duplicate_ingredient: "errDuplicateIngredient",
  ingredient_not_found: "errIngredientNotFound",
  menu_item_not_found: "errMenuItemNotFound",
};

type Tab = "dishes" | "subs" | "engineering";

/* ───────────────────────────── Lista ───────────────────────────────── */

export function RecetasClient({ currency }: { currency: string }) {
  const t = useTranslations("opErp");
  const locale = useLocale() as Locale;

  const [tab, setTab] = useState<Tab>("dishes");
  // null = cargando (fetch inicial al montar — ver comentario en page.tsx).
  const [dishes, setDishes] = useState<DishRow[] | null>(null);
  const [ingredients, setIngredients] = useState<IngredientOption[]>([]);
  const [loadErr, setLoadErr] = useState(false);
  const [q, setQ] = useState("");
  const [cat, setCat] = useState<string>("all");
  const [openDish, setOpenDish] = useState<DishRow | null>(null);

  useEffect(() => {
    if (dishes !== null || loadErr) return;
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch("/api/operator/recipes");
        if (!r.ok) throw new Error("load_failed");
        const j = await r.json();
        if (cancelled) return;
        setDishes((j.dishes ?? []) as DishRow[]);
        setIngredients((j.ingredients ?? []) as IngredientOption[]);
      } catch {
        if (!cancelled) setLoadErr(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [dishes, loadErr]);

  // Categorías en el orden del server (sortOrder de la carta).
  const categories = useMemo(() => {
    const map = new Map<string, string>();
    for (const d of dishes ?? []) {
      if (!map.has(d.category.id)) map.set(d.category.id, d.category.label);
    }
    return [...map.entries()].map(([id, label]) => ({ id, label }));
  }, [dishes]);

  const filtered = useMemo(() => {
    const needle = fold(q.trim());
    return (dishes ?? []).filter((d) => {
      if (cat !== "all" && d.category.id !== cat) return false;
      if (needle) {
        const hay = fold(`${d.name} ${d.category.label}`);
        if (!hay.includes(needle)) return false;
      }
      return true;
    });
  }, [dishes, q, cat]);

  // Receta guardada/borrada: el server devuelve receta + costo recalculado
  // (fuente de verdad) → se actualiza el row local y se cierra el sheet.
  function handleSaved(
    menuItemId: string,
    recipe: RecipeDto | null,
    cost: CostDto | null,
  ) {
    setDishes((prev) =>
      prev
        ? prev.map((d) =>
            d.menuItemId === menuItemId ? { ...d, recipe, cost } : d,
          )
        : prev,
    );
    setOpenDish(null);
  }

  return (
    <div className="space-y-4">
      {/* Segmentos Platos / Sub-recetas / Ingeniería */}
      <div className="inline-flex rounded-full border border-op-border bg-op-surface overflow-hidden">
        {(
          [
            ["dishes", t("tabDishes")],
            ["subs", t("tabSubRecipes")],
            ["engineering", t("tabEngineering")],
          ] as [Tab, string][]
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            onClick={() => setTab(value)}
            className={
              "min-h-[44px] px-5 text-xs font-medium transition-colors " +
              (tab === value ? "bg-ink text-bone" : "text-op-muted hover:text-ink")
            }
          >
            {label}
          </button>
        ))}
      </div>

      {tab !== "dishes" ? (
        // Placeholder neutro — el PR de Sub-recetas + Ingeniería lo reemplaza.
        <div className="rounded-2xl border border-dashed border-op-border bg-op-surface/50 p-8 text-center text-sm text-op-muted">
          {t("recipesTabEmpty")}
        </div>
      ) : loadErr ? (
        <div className="text-xs text-danger">{t("errLoadFailed")}</div>
      ) : dishes === null ? (
        <div className="py-6 text-center text-sm text-op-muted">
          {t("loading")}
        </div>
      ) : dishes.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-op-border bg-op-surface/50 p-8 text-center">
          <div className="font-display text-lg mb-1">
            {t("emptyDishesTitle")}
          </div>
          <p className="text-sm text-op-muted">{t("emptyDishesBody")}</p>
        </div>
      ) : (
        <>
          {/* Búsqueda + filtro por categoría */}
          <div className="space-y-2">
            <input
              type="search"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={t("searchDishesPlaceholder")}
              className="w-full min-h-[44px] px-4 rounded-full border border-op-border bg-op-surface text-sm focus:outline-none focus:border-op-text/40"
            />
            {categories.length > 0 && (
              <select
                value={cat}
                onChange={(e) => setCat(e.target.value)}
                className="min-h-[44px] px-3 rounded-full border border-op-border bg-op-surface text-sm max-w-[220px]"
              >
                <option value="all">{t("allCategories")}</option>
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.label}
                  </option>
                ))}
              </select>
            )}
          </div>

          {filtered.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-op-border bg-op-surface/50 p-8 text-center text-sm text-op-muted">
              {t("emptyFilteredDishes")}
            </div>
          ) : (
            <div className="bg-op-surface border border-op-border rounded-2xl overflow-hidden">
              {filtered.map((d) => {
                // Food cost/margen solo con costo COMPLETO — un costo a
                // medias mentiría (spec: nunca $0); incompleto → badge.
                const complete = d.cost !== null && d.cost.complete;
                const fc =
                  complete && d.priceCents > 0
                    ? (d.cost!.costCents / d.priceCents) * 100
                    : null;
                const margin = complete
                  ? d.priceCents - d.cost!.costCents
                  : null;
                return (
                  <button
                    key={d.menuItemId}
                    type="button"
                    onClick={() => setOpenDish(d)}
                    className="w-full text-left px-4 py-2.5 border-b border-op-border last:border-b-0 hover:bg-op-bg"
                  >
                    <div className="flex items-center gap-3">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 min-w-0">
                          <span
                            className={
                              "text-sm font-medium truncate" +
                              (d.available ? "" : " opacity-50")
                            }
                          >
                            {d.name}
                          </span>
                          {!d.available && (
                            <span className="px-2 h-5 inline-flex items-center rounded-full bg-paper text-op-muted text-[10px] font-medium shrink-0">
                              {t("unavailableBadge")}
                            </span>
                          )}
                          {d.recipe === null ? (
                            <span className="px-2 h-5 inline-flex items-center rounded-full bg-paper text-op-muted text-[10px] font-medium shrink-0">
                              {t("noRecipeBadge")}
                            </span>
                          ) : !complete ? (
                            <span className="px-2 h-5 inline-flex items-center rounded-full bg-[#C98A2E]/15 text-[#7F5A1F] text-[10px] font-medium shrink-0">
                              {t("incompleteCostBadge")}
                            </span>
                          ) : null}
                        </div>
                        <div className="text-[11px] text-op-muted mt-0.5 truncate">
                          {d.category.label}
                        </div>
                      </div>
                      <div className="text-right shrink-0">
                        <div className="text-sm font-medium tabular-nums">
                          {formatMoney(d.priceCents, { currency, locale })}
                        </div>
                        {complete && (
                          <>
                            <div className="text-[11px] mt-0.5 tabular-nums">
                              {fc != null && (
                                <span
                                  className={"font-medium " + foodCostCls(fc)}
                                >
                                  {formatPct(fc, locale)}
                                </span>
                              )}
                              <span className="text-op-muted">
                                {(fc != null ? " · " : "") +
                                  formatMoney(d.cost!.costCents, {
                                    currency,
                                    locale,
                                  })}
                              </span>
                            </div>
                            <div
                              className={
                                "text-[11px] mt-0.5 tabular-nums " +
                                (margin != null && margin < 0
                                  ? "text-danger"
                                  : "text-op-muted")
                              }
                            >
                              {`${t("marginLabel")} ${formatMoney(margin ?? 0, {
                                currency,
                                locale,
                              })}`}
                            </div>
                          </>
                        )}
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </>
      )}

      {openDish && (
        <RecipeSheet
          dish={openDish}
          ingredients={ingredients}
          currency={currency}
          onClose={() => setOpenDish(null)}
          onSaved={handleSaved}
        />
      )}
    </div>
  );
}

/* ─────────────────── Editor de receta (sheet) ──────────────────────── */

type EditLine = {
  key: number;
  ingredientId: string;
  ingredientName: string;
  measureKind: MeasureKind;
  /** Snapshot de la cascada D3 para el costo EN VIVO (null = sin costo). */
  costPerBase: number | null;
  qtyRaw: string;
  unit: string;
  wasteRaw: string;
};

type ParsedLine =
  | {
      qtyBase: number;
      wastePct: number;
      grossBase: number;
      lineCost: number | null;
    }
  | "qty_invalid"
  | "waste_invalid";

/** Parseo + costo en vivo de una línea: bruto = neto / (1 − merma%). */
function parseLine(l: EditLine): ParsedLine {
  const qtyBase = toBaseQty(
    Number(l.qtyRaw.replace(",", ".")),
    l.measureKind,
    l.unit,
  );
  if (qtyBase == null) return "qty_invalid";
  const wRaw = l.wasteRaw.trim();
  const wastePct = wRaw === "" ? 0 : Number(wRaw);
  if (!Number.isInteger(wastePct) || wastePct < 0 || wastePct > MAX_WASTE_PCT) {
    return "waste_invalid";
  }
  const gross = grossQty(qtyBase, wastePct);
  const lineCost =
    l.costPerBase != null ? Math.round(gross * l.costPerBase) : null;
  return { qtyBase, wastePct, grossBase: Math.round(gross), lineCost };
}

let lineKeySeq = 0;

function RecipeSheet({
  dish,
  ingredients,
  currency,
  onClose,
  onSaved,
}: {
  dish: DishRow;
  ingredients: IngredientOption[];
  currency: string;
  onClose: () => void;
  onSaved: (
    menuItemId: string,
    recipe: RecipeDto | null,
    cost: CostDto | null,
  ) => void;
}) {
  const t = useTranslations("opErp");
  const locale = useLocale() as Locale;

  const ingById = useMemo(() => {
    const m = new Map<string, IngredientOption>();
    for (const i of ingredients) m.set(i.id, i);
    return m;
  }, [ingredients]);

  // Líneas iniciales desde la receta guardada. El costPerBase sale del
  // catálogo de insumos activos; para insumos que salieron del catálogo
  // (inactivos) se rescata el de las líneas de costo del GET.
  const [lines, setLines] = useState<EditLine[]>(() =>
    (dish.recipe?.items ?? []).map((it) => {
      const { qty, unit } = baseToInputQty(it.qtyBase, it.measureKind);
      const fromCatalog = ingById.get(it.ingredientId)?.costPerBase;
      const fromCost = dish.cost?.lines.find(
        (l) => l.ingredientId === it.ingredientId,
      )?.costPerBase;
      return {
        key: ++lineKeySeq,
        ingredientId: it.ingredientId,
        ingredientName: it.ingredientName,
        measureKind: it.measureKind,
        costPerBase: fromCatalog ?? fromCost ?? null,
        qtyRaw: qty,
        unit,
        wasteRaw: String(it.wastePct),
      };
    }),
  );
  const [notes, setNotes] = useState(dish.recipe?.notes ?? "");
  const [ingQ, setIngQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [deletingBusy, setDeletingBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // El picker excluye insumos ya en la receta (guarda duplicate_ingredient).
  const matches = useMemo(() => {
    const used = new Set(lines.map((l) => l.ingredientId));
    const needle = fold(ingQ.trim());
    return ingredients
      .filter(
        (i) => !used.has(i.id) && (!needle || fold(i.name).includes(needle)),
      )
      .slice(0, 8);
  }, [ingredients, ingQ, lines]);

  function addLine(ing: IngredientOption) {
    setErr(null);
    setLines((prev) => [
      ...prev,
      {
        key: ++lineKeySeq,
        ingredientId: ing.id,
        ingredientName: ing.name,
        measureKind: ing.measureKind,
        costPerBase: ing.costPerBase,
        qtyRaw: "",
        unit: BASE_UNIT_SYMBOL[ing.measureKind],
        wasteRaw: "0",
      },
    ]);
    setIngQ("");
  }

  function updateLine(key: number, patch: Partial<EditLine>) {
    setErr(null);
    setLines((prev) =>
      prev.map((l) => (l.key === key ? { ...l, ...patch } : l)),
    );
  }

  // Totales EN VIVO (criterio de aceptación 1: se recalculan al teclear,
  // antes de guardar): suma de líneas costeables; incompleto si alguna
  // línea no tiene fuente de costo o aún no parsea.
  const live = useMemo(() => {
    let total = 0;
    let incomplete = false;
    for (const l of lines) {
      const p = parseLine(l);
      if (p === "qty_invalid" || p === "waste_invalid" || p.lineCost == null) {
        incomplete = true;
        continue;
      }
      total += p.lineCost;
    }
    const complete = lines.length > 0 && !incomplete;
    const fc =
      complete && dish.priceCents > 0
        ? (total / dish.priceCents) * 100
        : null;
    const margin = complete ? dish.priceCents - total : null;
    return { total, complete, fc, margin };
  }, [lines, dish.priceCents]);

  async function put(body: {
    items: { ingredientId: string; qtyBase: number; wastePct: number }[];
    notes: string | null;
  }): Promise<Response> {
    return fetch(`/api/operator/recipes/dish/${dish.menuItemId}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  async function save() {
    setErr(null);
    const items: { ingredientId: string; qtyBase: number; wastePct: number }[] =
      [];
    for (const l of lines) {
      const p = parseLine(l);
      if (p === "qty_invalid") {
        setErr(t("errContentInvalid"));
        return;
      }
      if (p === "waste_invalid") {
        setErr(t("errWasteInvalid"));
        return;
      }
      items.push({
        ingredientId: l.ingredientId,
        qtyBase: p.qtyBase,
        wastePct: p.wastePct,
      });
    }
    if (items.length === 0) return;
    setBusy(true);
    const r = await put({ items, notes: notes.trim() || null });
    setBusy(false);
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      const key = API_ERROR_KEYS[j.error as string];
      setErr(key ? t(key) : t("errSaveFailed"));
      return;
    }
    const j = await r.json();
    // El PUT devuelve items sin nombre/dimensión (a diferencia del GET) —
    // se enriquecen desde las líneas recién validadas.
    const raw = j.recipe as {
      id: string;
      notes: string | null;
      items: { ingredientId: string; qtyBase: number; wastePct: number }[];
    };
    const recipe: RecipeDto = {
      ...raw,
      items: raw.items.map((it) => {
        const line = lines.find((l) => l.ingredientId === it.ingredientId);
        return {
          ...it,
          ingredientName: line?.ingredientName ?? "",
          measureKind: line?.measureKind ?? "count",
        };
      }),
    };
    onSaved(dish.menuItemId, recipe, j.cost as CostDto);
  }

  // Borrado = PUT con items: [] (contrato del API); el plato queda "sin
  // receta". Confirm nativo — mismo patrón que compras/conteos.
  async function deleteRecipe() {
    if (!window.confirm(t("confirmDeleteRecipe"))) return;
    setErr(null);
    setDeletingBusy(true);
    const r = await put({ items: [], notes: null });
    setDeletingBusy(false);
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      const key = API_ERROR_KEYS[j.error as string];
      setErr(key ? t(key) : t("errSaveFailed"));
      return;
    }
    onSaved(dish.menuItemId, null, null);
  }

  const anyBusy = busy || deletingBusy;

  return (
    <div
      className="fixed inset-0 z-50 bg-ink/40 flex items-end md:items-center justify-center p-0 md:p-6"
      onClick={onClose}
    >
      <div
        className="w-full md:max-w-xl bg-op-surface rounded-t-3xl md:rounded-3xl border border-op-border p-5 max-h-[92dvh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3 mb-1">
          <div className="flex items-center gap-2 min-w-0">
            <h2 className="font-display text-2xl truncate">{dish.name}</h2>
            {!dish.available && (
              <span className="px-2 h-5 inline-flex items-center rounded-full bg-paper text-op-muted text-[10px] font-medium shrink-0">
                {t("unavailableBadge")}
              </span>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-op-muted text-sm shrink-0 min-h-[44px] min-w-[44px] -mt-2 -mr-2"
            aria-label={t("cancel")}
          >
            {"✕"}
          </button>
        </div>
        <div className="text-[11px] text-op-muted mb-4">
          {[
            dish.category.label,
            `${t("dishPriceLabel")}: ${formatMoney(dish.priceCents, {
              currency,
              locale,
            })}`,
          ].join(" · ")}
        </div>

        <div className="space-y-3">
          <div>
            <div className="font-mono text-[10px] tracking-[0.15em] uppercase text-op-muted">
              {t("linesTitle")}
            </div>
            <div className="text-[10px] text-op-muted mt-0.5">
              {t("recipeLinesHint")}
            </div>
          </div>

          {lines.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-op-border bg-op-bg/50 p-4 text-center text-sm text-op-muted">
              {t("noRecipeLinesYet")}
            </div>
          ) : (
            <div className="border border-op-border rounded-2xl overflow-hidden">
              {lines.map((l) => {
                const parsed = parseLine(l);
                const invalid =
                  parsed === "qty_invalid" || parsed === "waste_invalid";
                const unitOptions = DISPLAY_UNITS[l.measureKind];
                return (
                  <div
                    key={l.key}
                    className="px-3 py-2.5 border-b border-op-border last:border-b-0"
                  >
                    <div className="flex items-center gap-2">
                      <div className="flex-1 min-w-0">
                        <span className="text-sm font-medium truncate">
                          {l.ingredientName}
                        </span>
                        <span className="font-mono text-[10px] text-op-muted ml-2">
                          {unitSymbols(l.measureKind)}
                        </span>
                      </div>
                      {/* Costo de línea en vivo: bruto × costo por base;
                          "—" = insumo sin fuente de costo (nunca $0). */}
                      <div
                        className={
                          "text-xs font-medium tabular-nums shrink-0 " +
                          (invalid ? "text-danger" : "text-op-muted")
                        }
                      >
                        {invalid
                          ? "✕"
                          : parsed.lineCost != null
                            ? formatMoney(parsed.lineCost, { currency, locale })
                            : "—"}
                      </div>
                      <button
                        type="button"
                        onClick={() =>
                          setLines((prev) =>
                            prev.filter((x) => x.key !== l.key),
                          )
                        }
                        className="min-h-[44px] px-2 rounded-full text-[11px] font-medium text-danger hover:bg-danger/10 shrink-0"
                      >
                        {t("removeLine")}
                      </button>
                    </div>
                    <div className="mt-1 flex items-center gap-2">
                      <input
                        type="number"
                        min={0}
                        step="any"
                        inputMode="decimal"
                        value={l.qtyRaw}
                        onChange={(e) =>
                          updateLine(l.key, { qtyRaw: e.target.value })
                        }
                        aria-label={t("fieldNetQty")}
                        placeholder={t("fieldNetQty")}
                        className={inputCls + " flex-1 min-w-0"}
                      />
                      <select
                        value={l.unit}
                        onChange={(e) =>
                          updateLine(l.key, { unit: e.target.value })
                        }
                        disabled={unitOptions.length < 2}
                        aria-label={t("fieldQty")}
                        className="min-h-[44px] w-20 px-2 rounded-lg border border-op-border bg-op-bg text-sm disabled:opacity-40"
                      >
                        {unitOptions.map((u) => (
                          <option key={u.symbol} value={u.symbol}>
                            {u.symbol}
                          </option>
                        ))}
                      </select>
                      <div className="flex items-center gap-1 shrink-0">
                        <input
                          type="number"
                          min={0}
                          max={MAX_WASTE_PCT}
                          step={1}
                          inputMode="numeric"
                          value={l.wasteRaw}
                          onChange={(e) =>
                            updateLine(l.key, { wasteRaw: e.target.value })
                          }
                          aria-label={t("fieldWastePct")}
                          title={t("fieldWastePct")}
                          className={inputCls + " w-16"}
                        />
                        <span className="text-xs text-op-muted">{"%"}</span>
                      </div>
                    </div>
                    {/* Bruto que costea la merma (spec D2: 180 g netos con
                        20% de merma cuestan como 225 g). */}
                    {!invalid && parsed.wastePct > 0 && (
                      <div className="text-[10px] text-op-muted mt-1 tabular-nums">
                        {`${t("grossQtyLabel")}: ${formatBaseQty(
                          parsed.grossBase,
                          l.measureKind,
                          locale,
                        )}`}
                      </div>
                    )}
                    {l.costPerBase == null && (
                      <div className="text-[10px] text-op-muted mt-1">
                        {t("noCostHint")}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {/* Agregar línea: picker de insumo (solo activos, sin repetidos) */}
          <div className="rounded-2xl border border-op-border bg-op-bg/50 p-4 space-y-2">
            <Field label={t("fieldIngredient")}>
              <input
                type="search"
                value={ingQ}
                onChange={(e) => setIngQ(e.target.value)}
                placeholder={t("ingredientSearchPlaceholder")}
                className={inputCls}
              />
            </Field>
            <div className="rounded-lg border border-op-border bg-op-surface overflow-hidden max-h-44 overflow-y-auto">
              {matches.length === 0 ? (
                <div className="px-3 py-2 text-xs text-op-muted">
                  {t("noIngredientMatches")}
                </div>
              ) : (
                matches.map((i) => (
                  <button
                    key={i.id}
                    type="button"
                    onClick={() => addLine(i)}
                    className="w-full min-h-[40px] px-3 py-1.5 text-left text-sm hover:bg-op-bg border-b border-op-border last:border-b-0 flex items-center justify-between gap-2"
                  >
                    <span className="truncate">
                      <span>{i.name}</span>
                      <span className="font-mono text-[10px] text-op-muted ml-2">
                        {unitSymbols(i.measureKind)}
                      </span>
                    </span>
                    <span className="text-[10px] text-op-muted tabular-nums shrink-0">
                      {i.costPerBase != null
                        ? `${formatMoney(Math.round(i.costPerBase), {
                            currency,
                            locale,
                          })}/${BASE_UNIT_SYMBOL[i.measureKind]}`
                        : t("noCostBadge")}
                    </span>
                  </button>
                ))
              )}
            </div>
          </div>

          {/* Resumen EN VIVO: costo total, food cost con semáforo y margen */}
          <div className="rounded-2xl border border-op-border bg-op-bg/50 px-4 py-3 space-y-1">
            <div className="flex items-center justify-between gap-3">
              <span className="font-mono text-[10px] tracking-[0.15em] uppercase text-op-muted">
                {t("recipeCostLabel")}
              </span>
              <span className="text-sm font-medium tabular-nums flex items-center gap-2">
                {!live.complete && lines.length > 0 && (
                  <span className="px-2 h-5 inline-flex items-center rounded-full bg-[#C98A2E]/15 text-[#7F5A1F] text-[10px] font-medium">
                    {t("incompleteCostBadge")}
                  </span>
                )}
                {live.complete
                  ? formatMoney(live.total, { currency, locale })
                  : "—"}
              </span>
            </div>
            <div className="flex items-center justify-between gap-3">
              <span className="font-mono text-[10px] tracking-[0.15em] uppercase text-op-muted">
                {t("foodCostLabel")}
              </span>
              <span
                className={
                  "text-sm font-medium tabular-nums " +
                  (live.fc != null ? foodCostCls(live.fc) : "text-op-muted")
                }
              >
                {live.fc != null ? formatPct(live.fc, locale) : "—"}
              </span>
            </div>
            <div className="flex items-center justify-between gap-3">
              <span className="font-mono text-[10px] tracking-[0.15em] uppercase text-op-muted">
                {t("marginLabel")}
              </span>
              <span
                className={
                  "text-sm font-medium tabular-nums" +
                  (live.margin != null && live.margin < 0 ? " text-danger" : "")
                }
              >
                {live.margin != null
                  ? formatMoney(live.margin, { currency, locale })
                  : "—"}
              </span>
            </div>
          </div>

          <Field label={t("fieldNotes")}>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              maxLength={1000}
              rows={2}
              className="w-full px-3 py-2 rounded-lg border border-op-border bg-op-bg text-sm focus:outline-none focus:border-op-text/40"
            />
          </Field>

          {err && <div className="text-xs text-danger">{err}</div>}

          <div className="flex items-center gap-3 pt-1">
            {dish.recipe !== null && (
              <button
                type="button"
                onClick={deleteRecipe}
                disabled={anyBusy}
                className="min-h-[44px] px-3 rounded-full text-[11px] font-medium text-danger hover:bg-danger/10 disabled:opacity-40"
              >
                {deletingBusy ? t("deleting") : t("deleteRecipe")}
              </button>
            )}
            <div className="flex-1" />
            <button
              type="button"
              onClick={onClose}
              className="min-h-[44px] px-4 rounded-full bg-op-bg border border-op-border text-sm font-medium hover:bg-op-surface"
            >
              {t("cancel")}
            </button>
            <button
              type="button"
              onClick={save}
              disabled={anyBusy || lines.length === 0}
              className="min-h-[44px] px-5 rounded-full bg-ink text-bone text-sm font-medium disabled:opacity-40"
            >
              {busy ? t("saving") : t("save")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ────────────────────────────── UI compartida ──────────────────────── */

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
