"use client";

import { useEffect, useMemo, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import type { Locale } from "@/i18n/config";
import { formatDate, formatMoney } from "@/lib/format";
import { MAX_WASTE_PCT } from "@/lib/erp/recipes";
import {
  foodCostPct,
  foodCostTone,
  netMenuPriceCents,
  type MenuTax,
} from "@/lib/erp/recipeDetail";
import {
  DEFAULT_INPUT_UNIT,
  DISPLAY_UNITS,
  formatBaseQty,
  toBaseQty,
  type MeasureKind,
} from "@/lib/erp/units";
import { parseDecimalInput, sanitizeDecimalInput } from "@/lib/decimalInput";
import { parseReferencePriceInput, referencePriceUnit } from "@/lib/erp/ingredientPrice";
import { MoneyInput } from "@/components/MoneyInput";
import {
  baseToInputQty,
  editLineFromItem,
  fold,
  formatPct,
  formatPerBase,
  liveLinesTotal,
  minQtyLabel,
  newEditLine,
  parseLine,
  unitSymbols,
  type CostDto,
  type DishRow,
  type EditLine,
  type IngredientOption,
  type RecipeDto,
  type RecipeItemDto,
} from "./recipeModel";
import { RecipeDetail } from "./detalle/RecipeDetail";

/* ───────────────────────────── Tipos ───────────────────────────────── */
// Espejo de GET /api/operator/recipes (dishes + subRecipes + ingredients)
// y de GET /api/operator/menu-engineering (tab Ingeniería).

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

// Costos incompletos (GET /api/operator/recipes/cost-gaps): platos con algún
// insumo sin fuente de costo ("none") o que resuelve a cero ("zero"), directo
// o dentro de una sub-receta que el costeo usa. Derivado en vivo, nada
// persistido.
type CostGapReason = "none" | "zero";

type CostGapMissingDto = {
  /** Insumo hoja (donde se corrige). */
  ingredientId: string;
  name: string;
  measureKind: MeasureKind;
  /** Cantidad neta efectiva por plato, en unidad base. */
  qtyBase: number;
  reason: CostGapReason;
  /** Nombres de las sub-recetas por las que llega al plato ([] = directo). */
  via: string[];
};

type CostGapDishDto = {
  menuItemId: string;
  name: string;
  categoryName: string;
  /** Mismo costo que el resto de la app (subestimado mientras falte costo). */
  costCents: number;
  complete: boolean;
  missing: CostGapMissingDto[];
};

type CostGapIngredientDto = {
  id: string;
  name: string;
  measureKind: MeasureKind;
  reason: CostGapReason;
  usedInCount: number;
  referencePriceCents: number | null;
};

type CostGapsDto = {
  items: CostGapDishDto[];
  ingredientsWithoutCost: CostGapIngredientDto[];
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

// Semáforo food cost (spec D6, umbrales estándar fijos en A3, en
// @/lib/erp/recipeDetail): ≤30% ok · 30-40% atención (ámbar, mismos tokens
// del chip "parcial" de compras) · >40% rojo.
function foodCostCls(pct: number): string {
  const tone = foodCostTone(pct);
  if (tone === "ok") return "text-ok";
  if (tone === "warn") return "text-[#7F5A1F]";
  return "text-danger";
}

/** Rojo del semáforo — mismo umbral que foodCostCls (no se duplica el 40). */
function isHighFoodCost(pct: number): boolean {
  return foodCostTone(pct) === "high";
}

/**
 * Food cost del plato (%) sobre el precio de carta SIN el impuesto embebido
 * (el impoconsumo/IVA no es venta del comercio) — solo con costo COMPLETO y
 * precio > 0 (un costo a medias mentiría; spec: nunca $0). Null = no medible.
 * Es el mismo número que muestra el detalle de la receta.
 */
function dishFoodCostPct(d: DishRow, tax: MenuTax): number | null {
  if (d.cost === null) return null;
  return foodCostPct(
    d.cost.costCents,
    netMenuPriceCents(d.priceCents, tax),
    d.cost.complete,
  );
}

// Tono del % de alza (D5): el server ya filtra < 10%; ámbar de ahí en
// adelante y rojo desde el doble del umbral (≥ 20%) — mismos tokens del
// semáforo de food cost.
function priceAlertPctCls(pct: number): string {
  return pct >= 20 ? "text-danger" : "text-[#7F5A1F]";
}

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

export function RecetasClient({
  currency,
  tax,
}: {
  currency: string;
  /** Impuesto de venta del comercio (va embebido en el precio de carta). */
  tax: MenuTax;
}) {
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
  // Costos incompletos: platos con algún insumo sin costo o en cero (GET
  // /recipes/cost-gaps). null = aún sin cargar; se refresca junto con las
  // recetas (reloadSeq) y al guardar una receta o un costo (gapsSeq).
  const [gaps, setGaps] = useState<CostGapsDto | null>(null);
  const [gapsSeq, setGapsSeq] = useState(0);
  const [gapsOnly, setGapsOnly] = useState(false);
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
    let frame: number | null = null;
    const refreshCosts = () => {
      if (document.visibilityState !== "visible" || frame !== null) return;
      frame = requestAnimationFrame(() => {
        frame = null;
        setEngCache({});
        setReloadSeq(sequence => sequence + 1);
      });
    };
    // Refresh catalog costs when returning from Purchases or Ingredients in
    // another tab. RecipeDetail keeps its own unsaved lines and uses this new
    // catalog only for cost resolution, so quantities and notes stay intact.
    window.addEventListener("focus", refreshCosts);
    document.addEventListener("visibilitychange", refreshCosts);
    return () => {
      if (frame !== null) cancelAnimationFrame(frame);
      window.removeEventListener("focus", refreshCosts);
      document.removeEventListener("visibilitychange", refreshCosts);
    };
  }, []);

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

  // Costos incompletos: fetch aparte (más liviano que GET /recipes) que se
  // repite con cada recarga de recetas y con cada corrección en línea. Si
  // falla se conserva lo último cargado (null al inicio → chip oculto).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch("/api/operator/recipes/cost-gaps");
        if (!r.ok) throw new Error("load_failed");
        const j = (await r.json()) as Partial<CostGapsDto>;
        if (cancelled) return;
        setGaps({
          items: j.items ?? [],
          ingredientsWithoutCost: j.ingredientsWithoutCost ?? [],
        });
      } catch {
        /* se conserva el estado anterior */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [reloadSeq, gapsSeq]);

  // Platos con costo incompleto (badge en la lista + filtro).
  const gapDishIds = useMemo(
    () => new Set((gaps?.items ?? []).map((g) => g.menuItemId)),
    [gaps],
  );

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
        const fc = dishFoodCostPct(d, tax);
        if (fc == null || !isHighFoodCost(fc)) return false;
      }
      if (gapsOnly && !gapDishIds.has(d.menuItemId)) return false;
      if (needle) {
        const hay = fold(`${d.name} ${d.category.label}`);
        if (!hay.includes(needle)) return false;
      }
      return true;
    });
  }, [dishes, q, cat, fcHighOnly, gapsOnly, gapDishIds, tax]);

  // Ids visibles tras búsqueda/categoría: el panel de costos incompletos
  // respeta los mismos filtros que la lista.
  const visibleDishIds = useMemo(
    () => new Set(filtered.map((d) => d.menuItemId)),
    [filtered],
  );
  const filtering = q.trim() !== "" || cat !== "all" || fcHighOnly;

  // Platos en el rojo del semáforo (>40%) — alimenta el banner contador.
  const fcHighCount = useMemo(() => {
    let n = 0;
    for (const d of dishes ?? []) {
      const fc = dishFoodCostPct(d, tax);
      if (fc != null && isHighFoodCost(fc)) n++;
    }
    return n;
  }, [dishes, tax]);

  // Insumos que tienen sub-receta: el detalle los marca «Sub-receta».
  const subRecipeIds = useMemo(
    () => new Set(subs.map((s) => s.ingredientId)),
    [subs],
  );

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
    // La receta cambió de insumos → los costos incompletos pueden cambiar.
    setGapsSeq((s) => s + 1);
  }

  // Sub-receta guardada/borrada: re-fetch completo — su costo derivado
  // alimenta la cascada D3 de platos y de otras sub-recetas.
  function handleSubsChanged() {
    setEngCache({});
    setReloadSeq((s) => s + 1);
  }

  // Costo de un insumo corregido en línea: mueve el costo de TODOS los platos
  // y sub-recetas que lo usan → re-fetch completo (recetas + costos
  // incompletos, que depende de reloadSeq).
  function handleFixedCost() {
    setEngCache({});
    setReloadSeq((s) => s + 1);
  }

  return (
    <div className="space-y-4">
      {/* Segmentos Platos / Sub-recetas / Ingeniería */}
      <div className="mp-seg" role="tablist">
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
            role="tab"
            aria-selected={tab === value}
            onClick={() => setTab(value)}
            className="mp-seg__i"
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
          tax={tax}
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

          {/* Aviso costos incompletos: contador que aplica el filtro */}
          {gaps !== null && gaps.items.length > 0 && !gapsOnly && (
            <button
              type="button"
              onClick={() => setGapsOnly(true)}
              className="w-full text-left rounded-2xl border border-[#C98A2E]/40 bg-[#C98A2E]/10 px-4 py-3 text-sm font-medium text-[#7F5A1F] hover:bg-[#C98A2E]/15 flex items-center gap-2"
            >
              <WarningIcon className="shrink-0" />
              <span>
                {t("costGapsSummary", {
                  dishes: gaps.items.length,
                  ingredients: gaps.ingredientsWithoutCost.length,
                })}
              </span>
            </button>
          )}

          {/* Búsqueda + filtros (categoría · food cost alto · costos incompletos) */}
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
                className="mp-chip"
              >
                {t("fcAlertFilterChip")}
              </button>
              {gaps !== null && (
                <button
                  type="button"
                  onClick={() => setGapsOnly((v) => !v)}
                  aria-pressed={gapsOnly}
                  className="mp-chip"
                >
                  {t("costGapsChip", { count: gaps.items.length })}
                </button>
              )}
            </div>
          </div>

          {/* Insumos al alza (D5) — solo si el server trae alertas */}
          {priceAlerts.length > 0 && (
            <PriceAlertsSection alerts={priceAlerts} currency={currency} />
          )}

          {gapsOnly ? (
            // Vista de costos incompletos: platos afectados + insumos a
            // corregir en línea. Respeta búsqueda/categoría de arriba.
            gaps === null ? (
              <div className="py-6 text-center text-sm text-op-muted">
                {t("loading")}
              </div>
            ) : (
              <CostGapsPanel
                gaps={gaps}
                visibleDishIds={visibleDishIds}
                filtering={filtering}
                currency={currency}
                onOpenDish={(menuItemId) => {
                  const d = dishes.find((x) => x.menuItemId === menuItemId);
                  if (d) setOpenDish(d);
                }}
                onFixed={handleFixedCost}
              />
            )
          ) : filtered.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-op-border bg-op-surface/50 p-8 text-center text-sm text-op-muted">
              {t("emptyFilteredDishes")}
            </div>
          ) : (
            <div className="bg-op-surface border border-op-border rounded-2xl overflow-hidden">
              {filtered.map((d) => {
                // Food cost/margen solo con costo COMPLETO — un costo a
                // medias mentiría (spec: nunca $0); incompleto → badge.
                const complete = d.cost !== null && d.cost.complete;
                const fc = dishFoodCostPct(d, tax);
                const margin = complete
                  ? netMenuPriceCents(d.priceCents, tax) - d.cost!.costCents
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
                          ) : !complete || gapDishIds.has(d.menuItemId) ? (
                            // Incompleto por la cascada (sin fuente) o por un
                            // insumo en cero (GET /cost-gaps): texto + icono.
                            <IncompleteCostBadge />
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
        <RecipeDetail
          key={openDish.menuItemId}
          dish={openDish}
          ingredients={ingredients}
          subRecipeIds={subRecipeIds}
          currency={currency}
          tax={tax}
          onClose={() => setOpenDish(null)}
          onSaved={handleSaved}
          onCostFixed={handleFixedCost}
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

/* ──────────────── Costos incompletos (insumos sin costo) ───────────── */

/** Triángulo de aviso — icono inline (sin emojis) para el distintivo. */
function WarningIcon({ className = "" }: { className?: string }) {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      <path d="M12 3 2.5 20h19L12 3Z" />
      <path d="M12 9v5m0 3h.01" />
    </svg>
  );
}

/** Distintivo "Costo incompleto": texto + icono, no sólo color. */
function IncompleteCostBadge() {
  const t = useTranslations("opErp");
  return (
    <span className="px-2 h-5 inline-flex items-center gap-1 rounded-full bg-[#C98A2E]/15 text-[#7F5A1F] text-[10px] font-medium shrink-0">
      <WarningIcon />
      {t("incompleteCostBadge")}
    </span>
  );
}

function costGapEditorId(ingredientId: string): string {
  return `cost-gap-ing-${ingredientId}`;
}

/** Lleva al editor en línea del insumo y enfoca su campo de precio. */
function focusCostGapEditor(ingredientId: string) {
  const el = document.getElementById(costGapEditorId(ingredientId));
  if (!el) return;
  el.scrollIntoView({ behavior: "smooth", block: "center" });
  el.querySelector("input")?.focus({ preventScroll: true });
}

/**
 * Vista de costos incompletos: resumen, platos afectados con sus insumos
 * sin costo (y por qué sub-receta llegan) y, debajo, un editor en línea
 * por insumo para ponerle precio de referencia — corregir uno recalcula
 * todos los platos que lo usan.
 */
function CostGapsPanel({
  gaps,
  visibleDishIds,
  filtering,
  currency,
  onOpenDish,
  onFixed,
}: {
  gaps: CostGapsDto;
  /** Platos que pasan búsqueda/categoría de la lista. */
  visibleDishIds: Set<string>;
  /** true si hay algún filtro activo (los insumos se acotan a lo visible). */
  filtering: boolean;
  currency: string;
  onOpenDish: (menuItemId: string) => void;
  onFixed: () => void;
}) {
  const t = useTranslations("opErp");
  const locale = useLocale() as Locale;

  if (gaps.items.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-op-border bg-op-surface/50 p-8 text-center">
        <div className="font-display text-lg mb-1">{t("costGapsEmptyTitle")}</div>
        <p className="text-sm text-op-muted">{t("costGapsEmptyBody")}</p>
      </div>
    );
  }

  const dishes = gaps.items.filter((d) => visibleDishIds.has(d.menuItemId));
  // Con filtros activos sólo se listan los insumos de los platos visibles.
  const visibleIngredientIds = filtering
    ? new Set(dishes.flatMap((d) => d.missing.map((m) => m.ingredientId)))
    : null;
  const ingredients = visibleIngredientIds
    ? gaps.ingredientsWithoutCost.filter((i) => visibleIngredientIds.has(i.id))
    : gaps.ingredientsWithoutCost;

  const reasonLabel = (reason: CostGapReason) =>
    reason === "none" ? t("noCostBadge") : t("costGapReasonZero");

  return (
    <div className="space-y-4">
      <div className="rounded-2xl border border-[#C98A2E]/40 bg-[#C98A2E]/10 px-4 py-3">
        <div className="flex items-center gap-2 text-sm font-medium text-[#7F5A1F]">
          <WarningIcon className="shrink-0" />
          <span>
            {t("costGapsSummary", {
              dishes: gaps.items.length,
              ingredients: gaps.ingredientsWithoutCost.length,
            })}
          </span>
        </div>
        <p className="text-xs text-op-muted mt-1">{t("costGapsIntro")}</p>
      </div>

      {dishes.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-op-border bg-op-surface/50 p-8 text-center text-sm text-op-muted">
          {t("emptyFilteredDishes")}
        </div>
      ) : (
        <>
          <section className="bg-op-surface border border-op-border rounded-2xl overflow-hidden">
            <div className="px-4 py-2.5 border-b border-op-border text-sm font-medium">
              {t("costGapsDishesTitle", { count: dishes.length })}
            </div>
            <div className="divide-y divide-op-border">
              {dishes.map((d) => (
                <div key={d.menuItemId} className="px-4 py-3">
                  <div className="flex items-start gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 min-w-0 flex-wrap">
                        <span className="text-sm font-medium truncate">{d.name}</span>
                        <IncompleteCostBadge />
                      </div>
                      <div className="text-[11px] text-op-muted mt-0.5 truncate">
                        {d.categoryName}
                      </div>
                    </div>
                    <div className="text-right shrink-0">
                      <div className="text-[10px] text-op-muted">
                        {t("costGapComputedCost")}
                      </div>
                      <div className="text-sm tabular-nums">
                        {formatMoney(d.costCents, { currency, locale })}
                      </div>
                    </div>
                  </div>

                  {/* Insumos culpables: cantidad por plato, ruta y motivo */}
                  <ul className="mt-2 space-y-1">
                    {d.missing.map((m) => (
                      <li
                        key={m.ingredientId}
                        className="flex items-center justify-between gap-2 text-xs"
                      >
                        <span className="min-w-0">
                          <span className="font-medium">{m.name}</span>
                          <span className="text-op-muted tabular-nums">
                            {` · ${formatBaseQty(m.qtyBase, m.measureKind, locale)}`}
                          </span>
                          {m.via.length > 0 && (
                            <span className="text-op-muted">
                              {` · ${t("costGapVia", { path: m.via.join(" › ") })}`}
                            </span>
                          )}
                          <span className="text-[#7F5A1F]">
                            {` · ${reasonLabel(m.reason)}`}
                          </span>
                        </span>
                        <button
                          type="button"
                          onClick={() => focusCostGapEditor(m.ingredientId)}
                          className="mp-btn mp-btn--ghost mp-btn--sm shrink-0"
                        >
                          {t("costGapSetCost")}
                        </button>
                      </li>
                    ))}
                  </ul>

                  <button
                    type="button"
                    onClick={() => onOpenDish(d.menuItemId)}
                    className="mt-2 text-xs text-op-muted underline underline-offset-2 min-h-[32px]"
                  >
                    {t("costGapOpenRecipe")}
                  </button>
                </div>
              ))}
            </div>
          </section>

          <section className="bg-op-surface border border-op-border rounded-2xl overflow-hidden">
            <div className="px-4 py-2.5 border-b border-op-border text-sm font-medium">
              {t("costGapsIngredientsTitle", { count: ingredients.length })}
            </div>
            <div className="divide-y divide-op-border">
              {ingredients.map((i) => (
                <IngredientCostFixRow
                  key={i.id}
                  ingredient={i}
                  currency={currency}
                  reasonLabel={reasonLabel(i.reason)}
                  onFixed={onFixed}
                />
              ))}
            </div>
          </section>
        </>
      )}
    </div>
  );
}

/**
 * Editor en línea del precio de referencia de un insumo sin costo. Reusa
 * el PATCH de insumos (misma validación y auditoría que la ficha); al
 * guardar, el padre recarga recetas y costos incompletos.
 */
function IngredientCostFixRow({
  ingredient,
  currency,
  reasonLabel,
  onFixed,
}: {
  ingredient: CostGapIngredientDto;
  currency: string;
  reasonLabel: string;
  onFixed: () => void;
}) {
  const t = useTranslations("opErp");
  const unit = referencePriceUnit(ingredient.measureKind);
  // Un 0 explícito es justo lo que hay que corregir: el campo arranca vacío.
  const [raw, setRaw] = useState(
    ingredient.referencePriceCents != null && ingredient.referencePriceCents > 0
      ? String(ingredient.referencePriceCents / 100)
      : "",
  );
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function save() {
    if (busy) return;
    setErr(null);
    const cents = parseReferencePriceInput(raw);
    if (cents === "invalid") {
      setErr(t("errCostInvalid"));
      return;
    }
    if (cents == null || cents <= 0) {
      setErr(t("costGapErrNeedsPrice"));
      return;
    }
    setBusy(true);
    try {
      const r = await fetch(`/api/operator/ingredients/${ingredient.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ referencePriceCents: cents }),
      });
      if (!r.ok) throw new Error("save_failed");
      onFixed();
    } catch {
      setErr(t("errSaveFailed"));
    } finally {
      setBusy(false);
    }
  }

  const label = t("ingredientReferenceLabel", { currency, unit });

  return (
    <div id={costGapEditorId(ingredient.id)} className="px-4 py-3">
      <div className="text-sm font-medium truncate">{ingredient.name}</div>
      <div className="text-[11px] text-op-muted mt-0.5">
        <span className="text-[#7F5A1F]">{reasonLabel}</span>
        {` · ${t("costGapUsedIn", { count: ingredient.usedInCount })}`}
      </div>
      <form
        className="mt-2"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <div className="font-mono text-[10px] tracking-[0.15em] uppercase text-op-muted mb-1">
          {label}
        </div>
        <div className="flex items-center gap-2">
          <div className="flex-1 min-w-0">
            <MoneyInput
              value={raw}
              onChange={setRaw}
              fractionDigits={2}
              ariaLabel={label}
              placeholder={t("ingredientReferenceUnset")}
              className={inputCls}
              disabled={busy}
            />
          </div>
          <button
            type="submit"
            className="mp-btn mp-btn--primary shrink-0"
            disabled={busy}
          >
            {t("save")}
          </button>
        </div>
        <div className="text-[10px] text-op-muted mt-1">
          {t("costGapPriceHint", { unit })}
        </div>
        {err && <div className="text-xs text-danger mt-1">{err}</div>}
      </form>
    </div>
  );
}

/* ─────────────── Editor de líneas (sub-recetas) ───────────── */

/**
 * Lista de líneas de receta + picker para agregar insumos del editor de
 * Sub-recetas: edición de cantidad neta (unidades display), merma % y costo
 * de línea EN VIVO. (Los platos usan el detalle de ./detalle.)
 */
function LinesEditor({
  lines,
  ingredients,
  excludeIds,
  currency,
  onAdd,
  onUpdate,
  onRemove,
}: {
  lines: EditLine[];
  ingredients: IngredientOption[];
  /** Ids extra fuera del picker (p. ej. el insumo output de la sub-receta). */
  excludeIds?: Set<string>;
  currency: string;
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
              parsed === "qty_invalid" ||
              parsed === "qty_too_small" ||
              parsed === "waste_invalid";
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
                    {invalid ? (
                      "✕"
                    ) : parsed.lineCost != null ? (
                      formatMoney(parsed.lineCost, { currency, locale })
                    ) : (
                      // Sin fuente de costo: distintivo corto (el detalle
                      // va en el título), no un párrafo por línea.
                      <span
                        className="inline-flex items-center gap-1 text-[#7F5A1F]"
                        title={t("noCostHint")}
                      >
                        <WarningIcon />
                        {t("noCostBadge")}
                      </span>
                    )}
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
                  <input
                    type="text"
                    inputMode="decimal"
                    value={l.qtyRaw}
                    onChange={(e) =>
                      onUpdate(l.key, { qtyRaw: sanitizeDecimalInput(e.target.value) })
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
        className="mp-btn mp-btn--primary mp-btn--block"
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
    initYield?.unit ?? (sub ? DEFAULT_INPUT_UNIT[sub.measureKind] : ""),
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
    setYieldUnit(DEFAULT_INPUT_UNIT[ing.measureKind]);
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
          parseDecimalInput(yieldRaw),
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
      parseDecimalInput(yieldRaw),
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
      if (p === "qty_too_small") {
        setErr(
          t("errQtyTooSmall", {
            min: minQtyLabel(l.measureKind, l.unit, locale),
          }),
        );
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
                    type="text"
                    inputMode="decimal"
                    value={yieldRaw}
                    onChange={(e) => {
                      setErr(null);
                      setYieldRaw(sanitizeDecimalInput(e.target.value));
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
              className="mp-btn mp-btn--secondary"
            >
              {t("cancel")}
            </button>
            <button
              type="button"
              onClick={save}
              disabled={anyBusy || !output || lines.length === 0}
              className="mp-btn mp-btn--primary"
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
  tax,
  days,
  onDaysChange,
  cache,
  setCache,
}: {
  currency: string;
  tax: MenuTax;
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
      <div className="mp-seg" role="tablist">
        {ENG_PERIODS.map((d) => (
          <button
            key={d}
            type="button"
            role="tab"
            aria-selected={days === d}
            onClick={() => {
              setErr(false);
              onDaysChange(d);
            }}
            className="mp-seg__i"
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
                        // Mismo food cost que la lista y el detalle:
                        // sobre el precio sin el impuesto embebido.
                        const fc = foodCostPct(
                          d.costCents,
                          netMenuPriceCents(d.priceCents, tax),
                          true,
                        );
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
