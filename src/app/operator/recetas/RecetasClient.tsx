"use client";

import { useEffect, useMemo, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import type { Locale } from "@/i18n/config";
import { formatDate, formatMoney } from "@/lib/format";
import { grossQty, MAX_WASTE_PCT } from "@/lib/erp/recipes";
import {
  BASE_SYMBOL_FACTOR,
  BASE_UNIT_SYMBOL,
  DISPLAY_UNITS,
  formatBaseQty,
  toBaseQty,
  type MeasureKind,
} from "@/lib/erp/units";
import { useBackdropClose } from "@/lib/useBackdropClose";

/* ───────────────────────────── Tipos ───────────────────────────────── */
// Espejo de GET /api/operator/recipes (dishes + subRecipes + ingredients)
// y de GET /api/operator/menu-engineering (tab Ingeniería).

type CostSource = "stock" | "subrecipe" | "supplier" | null;

type RecipeItemDto = {
  ingredientId: string;
  qtyBase: number;
  wastePct: number;
  ingredientName: string;
  measureKind: MeasureKind;
};

// Delta de insumo por opción de modificador. qtyBase con SIGNO: + agrega,
// − quita. Reusa la forma de RecipeItemDto (nombre + dimensión).
type ModifierItemDto = RecipeItemDto & {
  modifierId: string;
  optLabel: string;
};

// Grupo de modificador del plato (para colgarle insumos por opción).
type ModifierGroupDto = {
  id: string;
  label: string;
  type: "radio" | "checkbox";
  opts: string[];
};

type RecipeDto = {
  id: string;
  notes: string | null;
  items: RecipeItemDto[];
  modifierItems: ModifierItemDto[];
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
  modifiers: ModifierGroupDto[];
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

type SubRecipeRow = {
  recipeId: string;
  /** El insumo elaborado que la receta produce (output). */
  ingredientId: string;
  ingredientName: string;
  measureKind: MeasureKind;
  active: boolean;
  /** Rendimiento del batch en unidad base ("rinde 2000 ml"). */
  outputQtyBase: number | null;
  notes: string | null;
  items: RecipeItemDto[];
  cost: CostDto;
  /** Costo receta / rendimiento (¢/unidad base, float) — null si incompleto. */
  derivedCostPerBase: number | null;
  /** Promedio real del inventario (¢/unidad base, float) — null sin stock. */
  stockAvgCostPerBase: number | null;
};

// Insumos al alza (spec A4·D5): último precio de SupplierPriceHistory vs. el
// registro anterior del mismo supplier-item — el server solo manda alzas
// ≥ 10% de los últimos 30 días, ordenadas por pctIncrease desc.
type PriceAlertDto = {
  ingredientId: string;
  ingredientName: string;
  supplierName: string;
  /** "Bulto 50 kg" — presentación del proveedor (precios por presentación). */
  presentationLabel: string;
  prevPriceCents: number;
  lastPriceCents: number;
  /** Ya redondeado a 1 decimal por el server; siempre ≥ 10. */
  pctIncrease: number;
  /** ISO date del último registro de precio. */
  at: string;
  /** Nombres de platos afectados (máx. 6); dishCount es el total real. */
  dishes: string[];
  dishCount: number;
};

type EngineeringQuadrantId = "star" | "plowhorse" | "puzzle" | "dog";

type EngineeringDish = {
  menuItemId: string;
  name: string;
  category: { id: string; label: string };
  priceCents: number;
  available: boolean;
  unitsSold: number;
  costCents: number;
  marginCents: number;
  quadrant: EngineeringQuadrantId;
};

type EngineeringNoData = {
  menuItemId: string;
  name: string;
  category: { id: string; label: string };
  available: boolean;
  unitsSold: number;
  reason: "no_recipe" | "incomplete_cost" | "no_sales";
};

type EngineeringData = {
  days: number;
  /** Umbral de popularidad en unidades vendidas (float). */
  popularityThreshold: number;
  /** Umbral de margen en centavos (float). */
  marginThreshold: number;
  /** Orden del server: unitsSold desc. */
  dishes: EngineeringDish[];
  noData: EngineeringNoData[];
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
  // units[0].factor: 1 para g/ml, 1000 para count "un" (base milesimal).
  return { qty: String(base / units[0].factor), unit: units[0].symbol };
}

/** "32,5%" con separador decimal del idioma. */
function formatPct(pct: number, locale: string): string {
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(pct)}%`;
}

/**
 * "$16/g" — costo por unidad base (mismo formato que el picker de insumos
 * del editor de Platos, para que ambos tabs hablen igual).
 */
function formatPerBase(
  costPerBase: number,
  kind: MeasureKind,
  currency: string,
  locale: Locale,
): string {
  // costPerBase es por unidad BASE (por milésima en count); se rotula por el
  // símbolo base ("/un"), así que se escala por BASE_SYMBOL_FACTOR.
  return `${formatMoney(Math.round(costPerBase * BASE_SYMBOL_FACTOR[kind]), { currency, locale })}/${BASE_UNIT_SYMBOL[kind]}`;
}

// Semáforo food cost (spec D6, umbrales estándar fijos en A3):
// ≤30% ok · 30-40% atención (ámbar, mismos tokens del chip "parcial" de
// compras) · >40% rojo.
function foodCostCls(pct: number): string {
  if (pct <= 30) return "text-ok";
  if (pct <= 40) return "text-[#7F5A1F]";
  return "text-danger";
}

/** Rojo del semáforo — mismo umbral que foodCostCls (no se duplica el 40). */
function isHighFoodCost(pct: number): boolean {
  return foodCostCls(pct) === "text-danger";
}

/**
 * Food cost del plato (%) — solo con costo COMPLETO y precio > 0 (un costo
 * a medias mentiría; spec: nunca $0). Null = no medible.
 */
function dishFoodCostPct(d: DishRow): number | null {
  if (d.cost === null || !d.cost.complete || d.priceCents <= 0) return null;
  return (d.cost.costCents / d.priceCents) * 100;
}

// Tono del % de alza (D5): el server ya filtra < 10%; ámbar de ahí en
// adelante y rojo desde el doble del umbral (≥ 20%) — mismos tokens del
// semáforo de food cost.
function priceAlertPctCls(pct: number): string {
  return pct >= 20 ? "text-danger" : "text-[#7F5A1F]";
}

// Errores del PUT de receta → clave i18n (fallback errSaveFailed).
const API_ERROR_KEYS: Record<string, string> = {
  invalid: "errLineInvalid",
  duplicate_ingredient: "errDuplicateIngredient",
  ingredient_not_found: "errIngredientNotFound",
  menu_item_not_found: "errMenuItemNotFound",
};

// Errores del PUT/DELETE de sub-receta → clave i18n (fallback errSaveFailed).
// recipe_cycle (409) e ingredient_in_own_recipe son defensivos: el picker de
// líneas ya excluye el propio output, pero los ciclos INDIRECTOS (A usa B y
// B usa A) solo los ve el server.
const SUB_API_ERROR_KEYS: Record<string, string> = {
  invalid: "errLineInvalid",
  duplicate_ingredient: "errDuplicateIngredient",
  ingredient_not_found: "errIngredientNotFound",
  ingredient_in_own_recipe: "errIngredientInOwnRecipe",
  recipe_cycle: "errSubRecipeCycle",
};

type Tab = "dishes" | "subs" | "engineering";

/* ───────────────────────────── Lista ───────────────────────────────── */

export function RecetasClient({ currency }: { currency: string }) {
  const t = useTranslations("opErp");
  const locale = useLocale() as Locale;

  const [tab, setTab] = useState<Tab>("dishes");
  // null = cargando (fetch inicial al montar — ver comentario en page.tsx).
  const [dishes, setDishes] = useState<DishRow[] | null>(null);
  const [subs, setSubs] = useState<SubRecipeRow[]>([]);
  const [ingredients, setIngredients] = useState<IngredientOption[]>([]);
  const [priceAlerts, setPriceAlerts] = useState<PriceAlertDto[]>([]);
  const [loadErr, setLoadErr] = useState(false);
  const [q, setQ] = useState("");
  const [cat, setCat] = useState<string>("all");
  // Filtro "food cost alto" (A4·D5): solo platos en el rojo del semáforo.
  const [fcHighOnly, setFcHighOnly] = useState(false);
  const [openDish, setOpenDish] = useState<DishRow | null>(null);
  // Se incrementa para re-fetchear GET /recipes completo (guardar/borrar una
  // sub-receta puede mover costos en cascada: platos y otras sub-recetas).
  const [reloadSeq, setReloadSeq] = useState(0);
  // Ingeniería: caché por período (7/30/90) — vive acá y no en el tab para
  // sobrevivir al cambio de tab; se invalida al tocar cualquier receta.
  const [engDays, setEngDays] = useState(30);
  const [engCache, setEngCache] = useState<Record<number, EngineeringData>>(
    {},
  );

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch("/api/operator/recipes");
        if (!r.ok) throw new Error("load_failed");
        const j = await r.json();
        if (cancelled) return;
        setDishes((j.dishes ?? []) as DishRow[]);
        setSubs((j.subRecipes ?? []) as SubRecipeRow[]);
        setIngredients((j.ingredients ?? []) as IngredientOption[]);
        setPriceAlerts((j.priceAlerts ?? []) as PriceAlertDto[]);
        setLoadErr(false);
      } catch {
        if (!cancelled) setLoadErr(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [reloadSeq]);

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
      if (fcHighOnly) {
        const fc = dishFoodCostPct(d);
        if (fc == null || !isHighFoodCost(fc)) return false;
      }
      if (needle) {
        const hay = fold(`${d.name} ${d.category.label}`);
        if (!hay.includes(needle)) return false;
      }
      return true;
    });
  }, [dishes, q, cat, fcHighOnly]);

  // Platos en el rojo del semáforo (>40%) — alimenta el banner contador.
  const fcHighCount = useMemo(() => {
    let n = 0;
    for (const d of dishes ?? []) {
      const fc = dishFoodCostPct(d);
      if (fc != null && isHighFoodCost(fc)) n++;
    }
    return n;
  }, [dishes]);

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
    // Los márgenes de ingeniería dependen del costo → caché fuera.
    setEngCache({});
  }

  // Sub-receta guardada/borrada: re-fetch completo — su costo derivado
  // alimenta la cascada D3 de platos y de otras sub-recetas.
  function handleSubsChanged() {
    setEngCache({});
    setReloadSeq((s) => s + 1);
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

      {tab === "subs" ? (
        // Sub-recetas comparte el fetch inicial de GET /recipes con Platos.
        loadErr ? (
          <div className="text-xs text-danger">{t("errLoadFailed")}</div>
        ) : dishes === null ? (
          <div className="py-6 text-center text-sm text-op-muted">
            {t("loading")}
          </div>
        ) : (
          <SubRecipesTab
            subs={subs}
            ingredients={ingredients}
            currency={currency}
            onChanged={handleSubsChanged}
          />
        )
      ) : tab === "engineering" ? (
        <EngineeringTab
          currency={currency}
          days={engDays}
          onDaysChange={setEngDays}
          cache={engCache}
          setCache={setEngCache}
        />
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
          {/* Aviso food cost alto (A4·D5): contador que aplica el filtro */}
          {fcHighCount > 0 && (
            <button
              type="button"
              onClick={() => setFcHighOnly(true)}
              className="w-full text-left rounded-2xl border border-[#C98A2E]/40 bg-[#C98A2E]/10 px-4 py-3 text-sm font-medium text-[#7F5A1F] hover:bg-[#C98A2E]/15"
            >
              {t("fcAlertBannerCount", { count: fcHighCount })}
            </button>
          )}

          {/* Búsqueda + filtros (categoría · food cost alto) */}
          <div className="space-y-2">
            <input
              type="search"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={t("searchDishesPlaceholder")}
              className="w-full min-h-[44px] px-4 rounded-full border border-op-border bg-op-surface text-sm focus:outline-none focus:border-op-text/40"
            />
            <div className="flex items-center gap-2 flex-wrap">
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
              <button
                type="button"
                onClick={() => setFcHighOnly((v) => !v)}
                aria-pressed={fcHighOnly}
                className={
                  "min-h-[44px] px-4 rounded-full border text-xs font-medium transition-colors " +
                  (fcHighOnly
                    ? "border-ink bg-ink text-bone"
                    : "border-op-border bg-op-surface text-op-muted hover:text-ink")
                }
              >
                {t("fcAlertFilterChip")}
              </button>
            </div>
          </div>

          {/* Insumos al alza (D5) — solo si el server trae alertas */}
          {priceAlerts.length > 0 && (
            <PriceAlertsSection alerts={priceAlerts} currency={currency} />
          )}

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
                const fc = dishFoodCostPct(d);
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

/* ──────────────────── Insumos al alza (A4·D5) ──────────────────────── */

/**
 * Sección colapsable con las alzas de precio del último mes (viene lista
 * del GET /recipes — nada persistido, regla A3). Cerrada por defecto: es
 * una alerta lateral, no la tarea principal del tab Platos.
 */
function PriceAlertsSection({
  alerts,
  currency,
}: {
  alerts: PriceAlertDto[];
  currency: string;
}) {
  const t = useTranslations("opErp");
  const locale = useLocale() as Locale;
  const [open, setOpen] = useState(false);

  return (
    <section className="bg-op-surface border border-op-border rounded-2xl overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="w-full min-h-[44px] px-4 py-2.5 flex items-center justify-between gap-3 text-left hover:bg-op-bg"
      >
        <span className="text-sm font-medium">
          {t("priceAlertSectionTitle", { count: alerts.length })}
        </span>
        <span className="text-xs text-op-muted shrink-0" aria-hidden>
          {open ? "▾" : "▸"}
        </span>
      </button>

      {open &&
        alerts.map((a, i) => (
          // El payload no trae supplierItemId → clave por posición (lista
          // de solo lectura que se reemplaza entera en cada fetch).
          <div
            key={`${a.ingredientId}-${i}`}
            className="px-4 py-2.5 border-t border-op-border"
          >
            <div className="flex items-center gap-3">
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium truncate">
                  {a.ingredientName}
                </div>
                <div className="text-[11px] text-op-muted mt-0.5 truncate">
                  {`${a.supplierName} · ${a.presentationLabel}`}
                </div>
              </div>
              <div className="text-right shrink-0">
                {/* Antes → ahora, por presentación del proveedor */}
                <div className="text-sm tabular-nums">
                  <span className="text-op-muted">
                    {`${formatMoney(a.prevPriceCents, { currency, locale })} → `}
                  </span>
                  <span className="font-medium">
                    {formatMoney(a.lastPriceCents, { currency, locale })}
                  </span>
                </div>
                <div className="text-[11px] mt-0.5 tabular-nums">
                  <span
                    className={
                      "font-medium " + priceAlertPctCls(a.pctIncrease)
                    }
                  >
                    {`+${formatPct(a.pctIncrease, locale)}`}
                  </span>
                  <span className="text-op-muted">
                    {" · " + formatDate(a.at, { locale, timeStyle: undefined })}
                  </span>
                </div>
              </div>
            </div>
            {/* Platos afectados: uso directo + vía sub-recetas (server) */}
            <div className="text-[11px] text-op-muted mt-1">
              {a.dishCount === 0
                ? t("priceAlertNoDishes")
                : a.dishCount > a.dishes.length
                  ? t("priceAlertAffectsMore", {
                      list: a.dishes.join(", "),
                      count: a.dishCount - a.dishes.length,
                    })
                  : t("priceAlertAffects", { list: a.dishes.join(", ") })}
            </div>
          </div>
        ))}
    </section>
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
  /** Solo líneas de modificador: +1 agrega, −1 quita. undefined = +1 (base). */
  sign?: 1 | -1;
};

// Línea de insumo atada a una opción de modificador (extiende EditLine).
type ModLine = EditLine & { modifierId: string; optLabel: string };

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

/** Línea nueva desde el picker de insumos (unidad base, sin merma). */
function newEditLine(ing: IngredientOption): EditLine {
  return {
    key: ++lineKeySeq,
    ingredientId: ing.id,
    ingredientName: ing.name,
    measureKind: ing.measureKind,
    costPerBase: ing.costPerBase,
    qtyRaw: "",
    unit: BASE_UNIT_SYMBOL[ing.measureKind],
    wasteRaw: "0",
  };
}

/** Línea precargada desde una receta guardada (rescatando el costo D3). */
function editLineFromItem(
  it: RecipeItemDto,
  ingById: Map<string, IngredientOption>,
  costLines: CostLineDto[] | undefined,
): EditLine {
  const { qty, unit } = baseToInputQty(it.qtyBase, it.measureKind);
  // El costPerBase sale del catálogo de insumos activos; para insumos que
  // salieron del catálogo (inactivos) se rescata el de las líneas de costo.
  const fromCatalog = ingById.get(it.ingredientId)?.costPerBase;
  const fromCost = costLines?.find(
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
}

/**
 * Suma EN VIVO de las líneas del editor (criterio de aceptación 1: se
 * recalcula al teclear, antes de guardar): total de las líneas costeables;
 * incompleto si alguna línea no tiene fuente de costo o aún no parsea.
 */
function liveLinesTotal(lines: EditLine[]): {
  total: number;
  complete: boolean;
} {
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
  return { total, complete: lines.length > 0 && !incomplete };
}

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

  // Líneas iniciales desde la receta guardada.
  const [lines, setLines] = useState<EditLine[]>(() =>
    (dish.recipe?.items ?? []).map((it) =>
      editLineFromItem(it, ingById, dish.cost?.lines),
    ),
  );
  const [notes, setNotes] = useState(dish.recipe?.notes ?? "");
  // Deltas de insumo por opción de modificador (± por línea). Se precargan
  // de la receta guardada; qtyBase negativo → sign −1 (quitar).
  const [modLines, setModLines] = useState<ModLine[]>(() =>
    (dish.recipe?.modifierItems ?? []).map((it) => ({
      ...editLineFromItem(
        { ...it, qtyBase: Math.abs(it.qtyBase) },
        ingById,
        undefined,
      ),
      modifierId: it.modifierId,
      optLabel: it.optLabel,
      sign: it.qtyBase < 0 ? -1 : 1,
    })),
  );
  const [busy, setBusy] = useState(false);
  const [deletingBusy, setDeletingBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  function addLine(ing: IngredientOption) {
    setErr(null);
    setLines((prev) => [...prev, newEditLine(ing)]);
  }

  function updateLine(key: number, patch: Partial<EditLine>) {
    setErr(null);
    setLines((prev) =>
      prev.map((l) => (l.key === key ? { ...l, ...patch } : l)),
    );
  }

  function removeLine(key: number) {
    setLines((prev) => prev.filter((x) => x.key !== key));
  }

  function addModLine(modifierId: string, optLabel: string, ing: IngredientOption) {
    setErr(null);
    setModLines((prev) => [
      ...prev,
      { ...newEditLine(ing), modifierId, optLabel, sign: 1 },
    ]);
  }

  function updateModLine(key: number, patch: Partial<EditLine>) {
    setErr(null);
    setModLines((prev) =>
      prev.map((l) => (l.key === key ? { ...l, ...patch } : l)),
    );
  }

  function removeModLine(key: number) {
    setModLines((prev) => prev.filter((x) => x.key !== key));
  }

  function toggleModSign(key: number) {
    setErr(null);
    setModLines((prev) =>
      prev.map((l) =>
        l.key === key ? { ...l, sign: l.sign === -1 ? 1 : -1 } : l,
      ),
    );
  }

  // Totales EN VIVO: costo + food cost + margen contra el precio de carta.
  const live = useMemo(() => {
    const { total, complete } = liveLinesTotal(lines);
    const fc =
      complete && dish.priceCents > 0
        ? (total / dish.priceCents) * 100
        : null;
    const margin = complete ? dish.priceCents - total : null;
    return { total, complete, fc, margin };
  }, [lines, dish.priceCents]);

  type ModItemPayload = {
    modifierId: string;
    optLabel: string;
    ingredientId: string;
    qtyBase: number;
    wastePct: number;
  };

  async function put(body: {
    items: { ingredientId: string; qtyBase: number; wastePct: number }[];
    modifierItems?: ModItemPayload[];
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
    // Deltas de modificador: qtyBase con signo (sign −1 = quitar).
    const modifierItems: ModItemPayload[] = [];
    for (const l of modLines) {
      const p = parseLine(l);
      if (p === "qty_invalid") {
        setErr(t("errContentInvalid"));
        return;
      }
      if (p === "waste_invalid") {
        setErr(t("errWasteInvalid"));
        return;
      }
      modifierItems.push({
        modifierId: l.modifierId,
        optLabel: l.optLabel,
        ingredientId: l.ingredientId,
        qtyBase: (l.sign === -1 ? -1 : 1) * p.qtyBase,
        wastePct: p.wastePct,
      });
    }
    setBusy(true);
    const r = await put({ items, modifierItems, notes: notes.trim() || null });
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
      modifierItems: ModItemPayload[];
    };
    const nameOf = (id: string) =>
      lines.find((l) => l.ingredientId === id) ??
      modLines.find((l) => l.ingredientId === id);
    const recipe: RecipeDto = {
      id: raw.id,
      notes: raw.notes,
      items: raw.items.map((it) => {
        const line = nameOf(it.ingredientId);
        return {
          ...it,
          ingredientName: line?.ingredientName ?? "",
          measureKind: line?.measureKind ?? "count",
        };
      }),
      modifierItems: (raw.modifierItems ?? []).map((it) => {
        const line = nameOf(it.ingredientId);
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
      {...useBackdropClose(onClose)}
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

          <LinesEditor
            lines={lines}
            ingredients={ingredients}
            currency={currency}
            onAdd={addLine}
            onUpdate={updateLine}
            onRemove={removeLine}
          />

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

          {/* Los deltas de modificador se cuelgan de la receta base: solo se
              muestran cuando ya hay al menos un insumo base (sin base, guardar
              está deshabilitado y el server borraría la receta). */}
          {lines.length > 0 && (
            <DishModifiersEditor
              modifiers={dish.modifiers}
              modLines={modLines}
              ingredients={ingredients}
              currency={currency}
              onAdd={addModLine}
              onUpdate={updateModLine}
              onRemove={removeModLine}
              onToggleSign={toggleModSign}
            />
          )}

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

/* ─────────────── Editor de líneas (compartido plato/sub) ───────────── */

/**
 * Lista de líneas de receta + picker para agregar insumos. Compartido por
 * el editor de Platos y el de Sub-recetas: misma edición de cantidad neta
 * (unidades display), merma % y costo de línea EN VIVO.
 */
function LinesEditor({
  lines,
  ingredients,
  excludeIds,
  currency,
  signed,
  onToggleSign,
  onAdd,
  onUpdate,
  onRemove,
}: {
  lines: EditLine[];
  ingredients: IngredientOption[];
  /** Ids extra fuera del picker (p. ej. el insumo output de la sub-receta). */
  excludeIds?: Set<string>;
  currency: string;
  /** Modo modificador: muestra un toggle +/− (agregar / quitar) por línea. */
  signed?: boolean;
  onToggleSign?: (key: number) => void;
  onAdd: (ing: IngredientOption) => void;
  onUpdate: (key: number, patch: Partial<EditLine>) => void;
  onRemove: (key: number) => void;
}) {
  const t = useTranslations("opErp");
  const locale = useLocale() as Locale;
  const [ingQ, setIngQ] = useState("");

  // El picker excluye insumos ya en la receta (guarda duplicate_ingredient)
  // y los vetados por el caller (p. ej. ingredient_in_own_recipe).
  const matches = useMemo(() => {
    const used = new Set(lines.map((l) => l.ingredientId));
    const needle = fold(ingQ.trim());
    return ingredients
      .filter(
        (i) =>
          !used.has(i.id) &&
          !excludeIds?.has(i.id) &&
          (!needle || fold(i.name).includes(needle)),
      )
      .slice(0, 8);
  }, [ingredients, ingQ, lines, excludeIds]);

  return (
    <>
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
                        ? (signed && l.sign === -1 ? "−" : "") +
                          formatMoney(parsed.lineCost, { currency, locale })
                        : "—"}
                  </div>
                  <button
                    type="button"
                    onClick={() => onRemove(l.key)}
                    className="min-h-[44px] px-2 rounded-full text-[11px] font-medium text-danger hover:bg-danger/10 shrink-0"
                  >
                    {t("removeLine")}
                  </button>
                </div>
                <div className="mt-1 flex items-center gap-2">
                  {signed && (
                    <button
                      type="button"
                      onClick={() => onToggleSign?.(l.key)}
                      aria-label={
                        l.sign === -1 ? t("modSignRemove") : t("modSignAdd")
                      }
                      title={l.sign === -1 ? t("modSignRemove") : t("modSignAdd")}
                      className={
                        "min-h-[44px] w-10 rounded-lg border text-base font-bold shrink-0 " +
                        (l.sign === -1
                          ? "border-danger/40 text-danger bg-danger/10"
                          : "border-ok/40 text-ok bg-ok/10")
                      }
                    >
                      {l.sign === -1 ? "−" : "+"}
                    </button>
                  )}
                  <input
                    type="number"
                    min={0}
                    step="any"
                    inputMode="decimal"
                    value={l.qtyRaw}
                    onChange={(e) =>
                      onUpdate(l.key, { qtyRaw: e.target.value })
                    }
                    aria-label={t("fieldNetQty")}
                    placeholder={t("fieldNetQty")}
                    className={inputCls + " flex-1 min-w-0"}
                  />
                  <select
                    value={l.unit}
                    onChange={(e) => onUpdate(l.key, { unit: e.target.value })}
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
                        onUpdate(l.key, { wasteRaw: e.target.value })
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
                onClick={() => {
                  onAdd(i);
                  setIngQ("");
                }}
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
                    ? formatPerBase(i.costPerBase, i.measureKind, currency, locale)
                    : t("noCostBadge")}
                </span>
              </button>
            ))
          )}
        </div>
      </div>
    </>
  );
}

/* ─────────── Insumos por opción de modificador (plato) ─────────── */

// Por cada grupo de modificador del plato y cada opción, un editor de
// deltas de insumo (± agregar/quitar). Se aplica al consumo/CMV solo cuando
// el comensal eligió esa opción. Sin modificadores no renderiza nada.
function DishModifiersEditor({
  modifiers,
  modLines,
  ingredients,
  currency,
  onAdd,
  onUpdate,
  onRemove,
  onToggleSign,
}: {
  modifiers: ModifierGroupDto[];
  modLines: ModLine[];
  ingredients: IngredientOption[];
  currency: string;
  onAdd: (modifierId: string, optLabel: string, ing: IngredientOption) => void;
  onUpdate: (key: number, patch: Partial<EditLine>) => void;
  onRemove: (key: number) => void;
  onToggleSign: (key: number) => void;
}) {
  const t = useTranslations("opErp");
  if (modifiers.length === 0) return null;
  return (
    <div className="space-y-2">
      <div>
        <div className="font-mono text-[10px] tracking-[0.15em] uppercase text-op-muted">
          {t("modRecipeTitle")}
        </div>
        <div className="text-[10px] text-op-muted mt-0.5">
          {t("modRecipeHint")}
        </div>
      </div>
      {modifiers.map((m) => (
        <div
          key={m.id}
          className="rounded-2xl border border-op-border overflow-hidden"
        >
          <div className="px-3 py-2 bg-op-bg/50 text-sm font-medium">
            {m.label}
          </div>
          <div className="divide-y divide-op-border">
            {m.opts.map((opt) => (
              <OptionEditor
                key={opt}
                label={opt}
                lines={modLines.filter(
                  (l) => l.modifierId === m.id && l.optLabel === opt,
                )}
                ingredients={ingredients}
                currency={currency}
                onAdd={(ing) => onAdd(m.id, opt, ing)}
                onUpdate={onUpdate}
                onRemove={onRemove}
                onToggleSign={onToggleSign}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

// Una opción del modificador: colapsable, abre el LinesEditor (modo signed)
// para colgarle insumos. Estado `open` local para no depender de <details>.
function OptionEditor({
  label,
  lines,
  ingredients,
  currency,
  onAdd,
  onUpdate,
  onRemove,
  onToggleSign,
}: {
  label: string;
  lines: EditLine[];
  ingredients: IngredientOption[];
  currency: string;
  onAdd: (ing: IngredientOption) => void;
  onUpdate: (key: number, patch: Partial<EditLine>) => void;
  onRemove: (key: number) => void;
  onToggleSign: (key: number) => void;
}) {
  const t = useTranslations("opErp");
  const [open, setOpen] = useState(lines.length > 0);
  return (
    <div className="px-3 py-2">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full min-h-[40px] flex items-center justify-between gap-2 text-sm"
      >
        <span className="flex items-center gap-2 min-w-0">
          <span aria-hidden className="text-op-muted">
            {open ? "▾" : "▸"}
          </span>
          <span className="truncate">{label}</span>
        </span>
        <span className="text-[10px] text-op-muted shrink-0">
          {lines.length > 0
            ? t("modOptLineCount", { count: lines.length })
            : t("modOptAdd")}
        </span>
      </button>
      {open && (
        <div className="mt-2">
          <LinesEditor
            lines={lines}
            ingredients={ingredients}
            currency={currency}
            signed
            onToggleSign={onToggleSign}
            onAdd={onAdd}
            onUpdate={onUpdate}
            onRemove={onRemove}
          />
        </div>
      )}
    </div>
  );
}

/* ───────────────────────── Tab Sub-recetas ─────────────────────────── */

// Recetas de insumos elaborados (spec D1): salsa de la casa, masa madre…
// El semi-elaborado ES un insumo normal de A0 — acá solo vive su receta y
// el costo derivado por unidad base (costo del batch / rendimiento).
function SubRecipesTab({
  subs,
  ingredients,
  currency,
  onChanged,
}: {
  subs: SubRecipeRow[];
  ingredients: IngredientOption[];
  currency: string;
  onChanged: () => void;
}) {
  const t = useTranslations("opErp");
  const locale = useLocale() as Locale;
  // null = cerrado · "new" = crear · row = editar.
  const [open, setOpen] = useState<SubRecipeRow | "new" | null>(null);

  // Insumos que ya tienen sub-receta: fuera del picker de output al crear
  // (el PUT haría upsert silencioso sobre la existente).
  const takenIds = useMemo(
    () => new Set(subs.map((s) => s.ingredientId)),
    [subs],
  );

  return (
    <div className="space-y-4">
      <button
        type="button"
        onClick={() => setOpen("new")}
        className="w-full min-h-[44px] rounded-full bg-ink text-bone text-sm font-medium hover:bg-ink/90"
      >
        {t("newSubRecipe")}
      </button>

      {subs.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-op-border bg-op-surface/50 p-8 text-center">
          <div className="font-display text-lg mb-1">
            {t("subRecipesEmptyTitle")}
          </div>
          <p className="text-sm text-op-muted">{t("subRecipesEmptyBody")}</p>
        </div>
      ) : (
        <div className="bg-op-surface border border-op-border rounded-2xl overflow-hidden">
          {subs.map((s) => {
            const complete = s.cost.complete;
            return (
              <button
                key={s.recipeId}
                type="button"
                onClick={() => setOpen(s)}
                className="w-full text-left px-4 py-2.5 border-b border-op-border last:border-b-0 hover:bg-op-bg"
              >
                <div className="flex items-center gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 min-w-0">
                      <span
                        className={
                          "text-sm font-medium truncate" +
                          (s.active ? "" : " opacity-50")
                        }
                      >
                        {s.ingredientName}
                      </span>
                      {!s.active && (
                        <span className="px-2 h-5 inline-flex items-center rounded-full bg-paper text-op-muted text-[10px] font-medium shrink-0">
                          {t("inactiveBadge")}
                        </span>
                      )}
                      {!complete && (
                        <span className="px-2 h-5 inline-flex items-center rounded-full bg-[#C98A2E]/15 text-[#7F5A1F] text-[10px] font-medium shrink-0">
                          {t("incompleteCostBadge")}
                        </span>
                      )}
                    </div>
                    <div className="text-[11px] text-op-muted mt-0.5 truncate">
                      {s.outputQtyBase != null
                        ? t("subRecipeYieldLabel", {
                            qty: formatBaseQty(
                              s.outputQtyBase,
                              s.measureKind,
                              locale,
                            ),
                          })
                        : "—"}
                    </div>
                  </div>
                  {/* Costo del batch + derivado por unidad base vs. promedio
                      real de inventario ("—" cuando no hay dato, nunca $0). */}
                  <div className="text-right shrink-0">
                    <div className="text-sm font-medium tabular-nums">
                      {complete
                        ? formatMoney(s.cost.costCents, { currency, locale })
                        : "—"}
                    </div>
                    <div className="text-[11px] text-op-muted mt-0.5 tabular-nums">
                      {`${t("subRecipeDerivedLabel")}: ${
                        s.derivedCostPerBase != null
                          ? formatPerBase(
                              s.derivedCostPerBase,
                              s.measureKind,
                              currency,
                              locale,
                            )
                          : "—"
                      }`}
                    </div>
                    <div className="text-[11px] text-op-muted mt-0.5 tabular-nums">
                      {`${t("subRecipeStockAvgLabel")}: ${
                        s.stockAvgCostPerBase != null
                          ? formatPerBase(
                              s.stockAvgCostPerBase,
                              s.measureKind,
                              currency,
                              locale,
                            )
                          : "—"
                      }`}
                    </div>
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      )}

      {open !== null && (
        <SubRecipeSheet
          sub={open === "new" ? null : open}
          ingredients={ingredients}
          takenIds={takenIds}
          currency={currency}
          onClose={() => setOpen(null)}
          onSaved={() => {
            setOpen(null);
            onChanged();
          }}
        />
      )}
    </div>
  );
}

/* ────────────────── Editor de sub-receta (sheet) ───────────────────── */

function SubRecipeSheet({
  sub,
  ingredients,
  takenIds,
  currency,
  onClose,
  onSaved,
}: {
  /** null = crear (con picker de insumo output). */
  sub: SubRecipeRow | null;
  ingredients: IngredientOption[];
  /** Insumos que ya tienen sub-receta (excluidos del picker de output). */
  takenIds: Set<string>;
  currency: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const t = useTranslations("opErp");
  const locale = useLocale() as Locale;

  const ingById = useMemo(() => {
    const m = new Map<string, IngredientOption>();
    for (const i of ingredients) m.set(i.id, i);
    return m;
  }, [ingredients]);

  // Output: fijo al editar; elegible al crear.
  const [output, setOutput] = useState<{
    id: string;
    name: string;
    measureKind: MeasureKind;
  } | null>(
    sub
      ? {
          id: sub.ingredientId,
          name: sub.ingredientName,
          measureKind: sub.measureKind,
        }
      : null,
  );
  const [outQ, setOutQ] = useState("");

  // Rendimiento en unidades display (mismo manejo que las líneas: toBaseQty
  // rechaza pérdidas de precisión tipo 0,0004 kg).
  const initYield =
    sub?.outputQtyBase != null
      ? baseToInputQty(sub.outputQtyBase, sub.measureKind)
      : null;
  const [yieldRaw, setYieldRaw] = useState(initYield?.qty ?? "");
  const [yieldUnit, setYieldUnit] = useState(
    initYield?.unit ?? (sub ? BASE_UNIT_SYMBOL[sub.measureKind] : ""),
  );

  const [lines, setLines] = useState<EditLine[]>(() =>
    (sub?.items ?? []).map((it) =>
      editLineFromItem(it, ingById, sub?.cost.lines),
    ),
  );
  const [notes, setNotes] = useState(sub?.notes ?? "");
  const [busy, setBusy] = useState(false);
  const [deletingBusy, setDeletingBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Candidatos a output: activos sin sub-receta previa.
  const outputMatches = useMemo(() => {
    if (sub) return [];
    const needle = fold(outQ.trim());
    return ingredients
      .filter(
        (i) =>
          !takenIds.has(i.id) && (!needle || fold(i.name).includes(needle)),
      )
      .slice(0, 8);
  }, [sub, ingredients, outQ, takenIds]);

  // El output NO puede estar en sus propias líneas: además de excluirlo del
  // picker, al elegirlo se retira si ya estaba (evita ingredient_in_own_recipe).
  const excludeIds = useMemo(
    () => new Set(output ? [output.id] : []),
    [output],
  );

  function pickOutput(ing: IngredientOption) {
    setErr(null);
    setOutput({ id: ing.id, name: ing.name, measureKind: ing.measureKind });
    setYieldRaw("");
    setYieldUnit(BASE_UNIT_SYMBOL[ing.measureKind]);
    setLines((prev) => prev.filter((l) => l.ingredientId !== ing.id));
    setOutQ("");
  }

  function addLine(ing: IngredientOption) {
    setErr(null);
    setLines((prev) => [...prev, newEditLine(ing)]);
  }

  function updateLine(key: number, patch: Partial<EditLine>) {
    setErr(null);
    setLines((prev) =>
      prev.map((l) => (l.key === key ? { ...l, ...patch } : l)),
    );
  }

  function removeLine(key: number) {
    setLines((prev) => prev.filter((x) => x.key !== key));
  }

  // Totales EN VIVO: costo del batch + costo derivado por unidad base
  // (costo / rendimiento), que es lo que la cascada D3 usará en los platos.
  const live = useMemo(() => {
    const { total, complete } = liveLinesTotal(lines);
    const yieldBase = output
      ? toBaseQty(
          Number(yieldRaw.replace(",", ".")),
          output.measureKind,
          yieldUnit,
        )
      : null;
    const derived = complete && yieldBase != null ? total / yieldBase : null;
    return { total, complete, derived };
  }, [lines, output, yieldRaw, yieldUnit]);

  async function save() {
    setErr(null);
    if (!output) return;
    const yieldBase = toBaseQty(
      Number(yieldRaw.replace(",", ".")),
      output.measureKind,
      yieldUnit,
    );
    if (yieldBase == null) {
      setErr(t("errContentInvalid"));
      return;
    }
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
    if (items.some((i) => i.ingredientId === output.id)) {
      setErr(t("errIngredientInOwnRecipe"));
      return;
    }
    setBusy(true);
    const r = await fetch(`/api/operator/recipes/sub/${output.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        outputQtyBase: yieldBase,
        items,
        notes: notes.trim() || null,
      }),
    });
    setBusy(false);
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      const key = SUB_API_ERROR_KEYS[j.error as string];
      setErr(key ? t(key) : t("errSaveFailed"));
      return;
    }
    onSaved();
  }

  async function deleteSub() {
    if (!sub) return;
    if (!window.confirm(t("confirmDeleteSubRecipe"))) return;
    setErr(null);
    setDeletingBusy(true);
    const r = await fetch(`/api/operator/recipes/sub/${sub.ingredientId}`, {
      method: "DELETE",
    });
    setDeletingBusy(false);
    // 404 = ya no existía (otra sesión la borró) → refrescar igual.
    if (!r.ok && r.status !== 404) {
      setErr(t("errSaveFailed"));
      return;
    }
    onSaved();
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
        <div className="flex items-start justify-between gap-3 mb-4">
          <div className="flex items-center gap-2 min-w-0">
            <h2 className="font-display text-2xl truncate">
              {sub ? sub.ingredientName : t("newSubRecipe")}
            </h2>
            {sub && !sub.active && (
              <span className="px-2 h-5 inline-flex items-center rounded-full bg-paper text-op-muted text-[10px] font-medium shrink-0">
                {t("inactiveBadge")}
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

        <div className="space-y-3">
          {/* Insumo output (solo al crear; al editar es el título) */}
          {!sub &&
            (output === null ? (
              <div className="rounded-2xl border border-op-border bg-op-bg/50 p-4 space-y-2">
                <Field
                  label={t("subRecipeOutputLabel")}
                  hint={t("subRecipeOutputHint")}
                >
                  <input
                    type="search"
                    value={outQ}
                    onChange={(e) => setOutQ(e.target.value)}
                    placeholder={t("ingredientSearchPlaceholder")}
                    className={inputCls}
                  />
                </Field>
                <div className="rounded-lg border border-op-border bg-op-surface overflow-hidden max-h-44 overflow-y-auto">
                  {outputMatches.length === 0 ? (
                    <div className="px-3 py-2 text-xs text-op-muted">
                      {t("noIngredientMatches")}
                    </div>
                  ) : (
                    outputMatches.map((i) => (
                      <button
                        key={i.id}
                        type="button"
                        onClick={() => pickOutput(i)}
                        className="w-full min-h-[40px] px-3 py-1.5 text-left text-sm hover:bg-op-bg border-b border-op-border last:border-b-0 flex items-center justify-between gap-2"
                      >
                        <span className="truncate">{i.name}</span>
                        <span className="font-mono text-[10px] text-op-muted shrink-0">
                          {unitSymbols(i.measureKind)}
                        </span>
                      </button>
                    ))
                  )}
                </div>
              </div>
            ) : (
              <div className="rounded-2xl border border-op-border bg-op-bg/50 px-4 py-3 flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="font-mono text-[10px] tracking-[0.15em] uppercase text-op-muted">
                    {t("subRecipeOutputLabel")}
                  </div>
                  <div className="text-sm font-medium truncate">
                    {output.name}
                    <span className="font-mono text-[10px] text-op-muted ml-2">
                      {unitSymbols(output.measureKind)}
                    </span>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setErr(null);
                    setOutput(null);
                    setYieldRaw("");
                  }}
                  className="min-h-[44px] px-3 rounded-full text-[11px] font-medium text-op-muted hover:bg-op-bg shrink-0"
                >
                  {t("changeIngredient")}
                </button>
              </div>
            ))}

          {output && (
            <>
              {/* Rendimiento del batch ("esta preparación rinde 2 L") */}
              <Field
                label={t("subRecipeYieldField")}
                required
                hint={t("subRecipeYieldHint")}
              >
                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    min={0}
                    step="any"
                    inputMode="decimal"
                    value={yieldRaw}
                    onChange={(e) => {
                      setErr(null);
                      setYieldRaw(e.target.value);
                    }}
                    className={inputCls + " flex-1 min-w-0"}
                  />
                  <select
                    value={yieldUnit}
                    onChange={(e) => setYieldUnit(e.target.value)}
                    disabled={DISPLAY_UNITS[output.measureKind].length < 2}
                    aria-label={t("fieldQty")}
                    className="min-h-[44px] w-20 px-2 rounded-lg border border-op-border bg-op-bg text-sm disabled:opacity-40"
                  >
                    {DISPLAY_UNITS[output.measureKind].map((u) => (
                      <option key={u.symbol} value={u.symbol}>
                        {u.symbol}
                      </option>
                    ))}
                  </select>
                </div>
              </Field>

              <div>
                <div className="font-mono text-[10px] tracking-[0.15em] uppercase text-op-muted">
                  {t("linesTitle")}
                </div>
                <div className="text-[10px] text-op-muted mt-0.5">
                  {t("subRecipeLinesHint")}
                </div>
              </div>

              <LinesEditor
                lines={lines}
                ingredients={ingredients}
                excludeIds={excludeIds}
                currency={currency}
                onAdd={addLine}
                onUpdate={updateLine}
                onRemove={removeLine}
              />

              {/* Resumen EN VIVO: costo del batch, derivado por unidad base
                  y promedio real de inventario para comparar */}
              <div className="rounded-2xl border border-op-border bg-op-bg/50 px-4 py-3 space-y-1">
                <div className="flex items-center justify-between gap-3">
                  <span className="font-mono text-[10px] tracking-[0.15em] uppercase text-op-muted">
                    {t("subRecipeBatchCostLabel")}
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
                    {t("subRecipeDerivedLabel")}
                  </span>
                  <span className="text-sm font-medium tabular-nums">
                    {live.derived != null
                      ? formatPerBase(
                          live.derived,
                          output.measureKind,
                          currency,
                          locale,
                        )
                      : "—"}
                  </span>
                </div>
                {sub && (
                  <div className="flex items-center justify-between gap-3">
                    <span className="font-mono text-[10px] tracking-[0.15em] uppercase text-op-muted">
                      {t("subRecipeStockAvgLabel")}
                    </span>
                    <span className="text-sm font-medium tabular-nums">
                      {sub.stockAvgCostPerBase != null
                        ? formatPerBase(
                            sub.stockAvgCostPerBase,
                            sub.measureKind,
                            currency,
                            locale,
                          )
                        : "—"}
                    </span>
                  </div>
                )}
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
            </>
          )}

          {err && <div className="text-xs text-danger">{err}</div>}

          <div className="flex items-center gap-3 pt-1">
            {sub !== null && (
              <button
                type="button"
                onClick={deleteSub}
                disabled={anyBusy}
                className="min-h-[44px] px-3 rounded-full text-[11px] font-medium text-danger hover:bg-danger/10 disabled:opacity-40"
              >
                {deletingBusy ? t("deleting") : t("deleteSubRecipe")}
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
              disabled={anyBusy || !output || lines.length === 0}
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

/* ───────────────────────── Tab Ingeniería ──────────────────────────── */

const ENG_PERIODS = [7, 30, 90];

// Matriz popularidad × margen (spec D4) como listas agrupadas por cuadrante
// (mobile-first, sin chart) con acción sugerida estática.
const ENG_QUADRANTS: { id: EngineeringQuadrantId; emoji: string }[] = [
  { id: "star", emoji: "⭐" },
  { id: "plowhorse", emoji: "🐎" },
  { id: "puzzle", emoji: "🧩" },
  { id: "dog", emoji: "🐕" },
];

function EngineeringTab({
  currency,
  days,
  onDaysChange,
  cache,
  setCache,
}: {
  currency: string;
  days: number;
  onDaysChange: (d: number) => void;
  cache: Record<number, EngineeringData>;
  setCache: React.Dispatch<
    React.SetStateAction<Record<number, EngineeringData>>
  >;
}) {
  const t = useTranslations("opErp");
  const locale = useLocale() as Locale;
  const data = cache[days] ?? null;
  const [err, setErr] = useState(false);

  // Mismo patrón fetch-en-efecto del resto del app (sin setState síncrono):
  // el error se limpia en el click de período, que además re-dispara el
  // efecto (err en deps) → tocar cualquier período reintenta.
  useEffect(() => {
    if (data || err) return;
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(`/api/operator/menu-engineering?days=${days}`);
        if (!r.ok) throw new Error("load_failed");
        const j = (await r.json()) as EngineeringData;
        if (!cancelled) setCache((prev) => ({ ...prev, [days]: j }));
      } catch {
        if (!cancelled) setErr(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [data, days, err, setCache]);

  // Título + acción sugerida por cuadrante (t no acepta claves dinámicas
  // legibles → lookup explícito).
  const quadrantCopy: Record<
    EngineeringQuadrantId,
    { title: string; action: string }
  > = {
    star: {
      title: t("engineeringQuadrantStar"),
      action: t("engineeringActionStar"),
    },
    plowhorse: {
      title: t("engineeringQuadrantPlowhorse"),
      action: t("engineeringActionPlowhorse"),
    },
    puzzle: {
      title: t("engineeringQuadrantPuzzle"),
      action: t("engineeringActionPuzzle"),
    },
    dog: {
      title: t("engineeringQuadrantDog"),
      action: t("engineeringActionDog"),
    },
  };

  const byQuadrant = useMemo(() => {
    const m = new Map<EngineeringQuadrantId, EngineeringDish[]>();
    for (const d of data?.dishes ?? []) {
      const arr = m.get(d.quadrant) ?? [];
      arr.push(d);
      m.set(d.quadrant, arr);
    }
    return m;
  }, [data]);

  return (
    <div className="space-y-4">
      {/* Período: 7 / 30 / 90 días (cacheado por período) */}
      <div className="inline-flex rounded-full border border-op-border bg-op-surface overflow-hidden">
        {ENG_PERIODS.map((d) => (
          <button
            key={d}
            type="button"
            onClick={() => {
              setErr(false);
              onDaysChange(d);
            }}
            className={
              "min-h-[44px] px-4 text-xs font-medium transition-colors " +
              (days === d ? "bg-ink text-bone" : "text-op-muted hover:text-ink")
            }
          >
            {t("engineeringPeriodDays", { days: d })}
          </button>
        ))}
      </div>

      {err ? (
        <div className="text-xs text-danger">{t("errLoadFailed")}</div>
      ) : data === null ? (
        <div className="py-6 text-center text-sm text-op-muted">
          {t("loading")}
        </div>
      ) : (
        <>
          {data.dishes.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-op-border bg-op-surface/50 p-8 text-center">
              <div className="font-display text-lg mb-1">
                {t("engineeringEmptyTitle")}
              </div>
              <p className="text-sm text-op-muted">
                {t("engineeringEmptyBody")}
              </p>
            </div>
          ) : (
            <>
              {/* Umbrales D4 usados, discretos */}
              <div className="text-[10px] text-op-muted">
                {t("engineeringThresholds", {
                  units: new Intl.NumberFormat(locale, {
                    maximumFractionDigits: 1,
                  }).format(data.popularityThreshold),
                  amount: formatMoney(Math.round(data.marginThreshold), {
                    currency,
                    locale,
                  }),
                })}
              </div>

              {ENG_QUADRANTS.map((qd) => {
                const rows = byQuadrant.get(qd.id) ?? [];
                // Cuadrante vacío: fuera (mobile-first, sin secciones huecas).
                if (rows.length === 0) return null;
                return (
                  <section key={qd.id} className="space-y-1.5">
                    <div>
                      <div className="text-sm font-medium">
                        {`${qd.emoji} ${quadrantCopy[qd.id].title}`}
                      </div>
                      <p className="text-[11px] text-op-muted">
                        {quadrantCopy[qd.id].action}
                      </p>
                    </div>
                    <div className="bg-op-surface border border-op-border rounded-2xl overflow-hidden">
                      {rows.map((d) => {
                        const fc =
                          d.priceCents > 0
                            ? (d.costCents / d.priceCents) * 100
                            : null;
                        return (
                          <div
                            key={d.menuItemId}
                            className="px-4 py-2.5 border-b border-op-border last:border-b-0"
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
                                </div>
                                <div className="text-[11px] text-op-muted mt-0.5 truncate">
                                  {t("engineeringUnitsSold", {
                                    count: d.unitsSold,
                                  })}
                                </div>
                              </div>
                              <div className="text-right shrink-0">
                                <div
                                  className={
                                    "text-sm font-medium tabular-nums" +
                                    (d.marginCents < 0 ? " text-danger" : "")
                                  }
                                >
                                  {formatMoney(d.marginCents, {
                                    currency,
                                    locale,
                                  })}
                                </div>
                                {fc != null && (
                                  <div
                                    className={
                                      "text-[11px] mt-0.5 tabular-nums font-medium " +
                                      foodCostCls(fc)
                                    }
                                  >
                                    {formatPct(fc, locale)}
                                  </div>
                                )}
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </section>
                );
              })}
            </>
          )}

          {/* Fuera de la matriz: sin receta / costo incompleto / sin ventas */}
          {data.noData.length > 0 && (
            <section className="space-y-1.5">
              <div className="text-sm font-medium">
                {t("engineeringNoDataTitle")}
              </div>
              <div className="bg-op-surface border border-op-border rounded-2xl overflow-hidden">
                {data.noData.map((d) => (
                  <div
                    key={d.menuItemId}
                    className="px-4 py-2.5 border-b border-op-border last:border-b-0"
                  >
                    <div className="flex items-center justify-between gap-3">
                      <div className="flex-1 min-w-0">
                        <div
                          className={
                            "text-sm truncate" +
                            (d.available ? "" : " opacity-50")
                          }
                        >
                          {d.name}
                        </div>
                        {d.unitsSold > 0 && (
                          <div className="text-[11px] text-op-muted mt-0.5">
                            {t("engineeringUnitsSold", { count: d.unitsSold })}
                          </div>
                        )}
                      </div>
                      <span className="px-2 h-5 inline-flex items-center rounded-full bg-paper text-op-muted text-[10px] font-medium shrink-0">
                        {d.reason === "no_recipe"
                          ? t("noRecipeBadge")
                          : d.reason === "incomplete_cost"
                            ? t("incompleteCostBadge")
                            : t("engineeringReasonNoSales")}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}
        </>
      )}
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
