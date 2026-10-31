// Orquestador del análisis de ventas: resuelve el período y la comparación,
// lanza las consultas agregadas en paralelo y deriva los indicadores.
import { loadCostContext } from "@/lib/erp/recipeData";
import { costRecipeItems } from "@/lib/erp/recipes";
import type { RestaurantTax } from "@/lib/salesTax";
import {
  hasItemFilter,
  resolveComparison,
  resolveRange,
  type SalesFilters,
} from "./filters";
import { rangeDays, rangeInstants, resolveGranularity, type DayRange, type Granularity } from "./period";
import { deriveKpis, summarizeReturns } from "./metrics";
import { buildMenuEngineering, type RecipeCostInfo } from "./menuEngineering";
import {
  loadAvailableItems,
  loadCategories,
  loadChannels,
  loadDuration,
  loadFilterOptions,
  loadHeat,
  loadMethods,
  loadModifiers,
  loadOrders,
  loadProducts,
  loadReturnRows,
  loadTables,
  loadTotals,
  loadTrend,
  loadWaiters,
  type SalesDb,
} from "./queries";
import type { SalesScope } from "./sql";
import type { PeriodData, SalesAnalysis } from "./types";

/** Tope de cuentas en el detalle de un día (Son y Melona: ~33 por día). */
export const ORDER_LIST_LIMIT = 500;

export type SalesAnalysisInput = {
  restaurantId: string;
  filters: SalesFilters;
  /** Día operativo de hoy (con la hora de corte). */
  today: string;
  cutoffHour: number;
  tax: RestaurantTax;
  counterMode: boolean;
  /** Módulo de recetas activo: habilita margen e ingeniería de menú. */
  recipesEnabled: boolean;
};

function scopeFor(input: SalesAnalysisInput, range: DayRange): SalesScope {
  return {
    restaurantId: input.restaurantId,
    ...rangeInstants(range, input.cutoffHour),
    cutoffHour: input.cutoffHour,
    tax: input.tax,
    dims: input.filters.dims,
  };
}

async function loadPeriod(
  client: SalesDb,
  scope: SalesScope,
  range: DayRange,
  granularity: Granularity,
  tax: RestaurantTax,
): Promise<PeriodData> {
  const item = hasItemFilter(scope);
  const [totals, returnRows, duration, trend, products, categories, waiters, methods, channels] = await Promise.all([
    loadTotals(client, scope),
    item ? Promise.resolve(null) : loadReturnRows(client, scope),
    loadDuration(client, scope),
    loadTrend(client, scope, granularity),
    loadProducts(client, scope),
    loadCategories(client, scope),
    loadWaiters(client, scope),
    loadMethods(client, scope),
    loadChannels(client, scope),
  ]);
  return {
    range,
    totals,
    returns: returnRows ? summarizeReturns(returnRows.notes, returnRows.refunds, tax) : null,
    duration,
    trend,
    products,
    categories,
    waiters,
    methods,
    channels,
  };
}

/** Costo actual de la receta de cada plato vendido (null = sin receta). */
async function loadRecipeCosts(
  client: SalesDb,
  restaurantId: string,
  menuItemIds: string[],
): Promise<Map<string, RecipeCostInfo>> {
  if (menuItemIds.length === 0) return new Map();
  const [{ ctx }, items] = await Promise.all([
    loadCostContext(restaurantId),
    client.menuItem.findMany({
      where: { restaurantId, id: { in: menuItemIds } },
      select: {
        id: true,
        recipe: { select: { items: { select: { ingredientId: true, qtyBase: true, wastePct: true } } } },
      },
    }),
  ]);
  return new Map(items.map((mi) => {
    if (!mi.recipe || mi.recipe.items.length === 0) return [mi.id, null];
    const cost = costRecipeItems(ctx, mi.recipe.items);
    return [mi.id, { costCents: cost.costCents, complete: cost.complete }];
  }));
}

export async function loadSalesAnalysis(client: SalesDb, input: SalesAnalysisInput): Promise<SalesAnalysis> {
  const { filters } = input;
  const range = resolveRange(filters, input.today);
  const compareRange = resolveComparison(filters, range);
  const granularity = resolveGranularity(range, filters.granularity);
  const scope = scopeFor(input, range);
  const itemFilter = hasItemFilter(filters);
  const singleDay = rangeDays(range) === 1;
  const dimsBesidesCategory = Object.keys(filters.dims).filter((d) => d !== "categoria");

  const [current, compare, heat, tables, modifiers, orders, options, available] = await Promise.all([
    loadPeriod(client, scope, range, granularity, input.tax),
    compareRange ? loadPeriod(client, scopeFor(input, compareRange), compareRange, granularity, input.tax) : null,
    loadHeat(client, scope),
    loadTables(client, scope),
    loadModifiers(client, scope),
    singleDay ? loadOrders(client, scope, ORDER_LIST_LIMIT + 1) : null,
    loadFilterOptions(client, input.restaurantId),
    dimsBesidesCategory.length === 0
      ? loadAvailableItems(client, input.restaurantId, filters.dims.categoria)
      : null,
  ]);

  const soldIds = new Set(current.products.map((p) => p.menuItemId).filter((x): x is string => !!x));
  const engineering = input.recipesEnabled
    ? buildMenuEngineering(
        current.products
          .filter((p): p is typeof p & { menuItemId: string } => p.menuItemId !== null)
          .map((p) => ({ menuItemId: p.menuItemId, name: p.name, units: p.units, netCents: p.netCents })),
        await loadRecipeCosts(client, input.restaurantId, [...soldIds]),
      )
    : null;

  return {
    filters,
    today: input.today,
    cutoffHour: input.cutoffHour,
    counterMode: input.counterMode,
    itemFilter,
    range,
    compareRange,
    granularity,
    current,
    compare,
    kpis: deriveKpis(current.totals, current.returns, current.duration),
    compareKpis: compare ? deriveKpis(compare.totals, compare.returns, compare.duration) : null,
    heat,
    tables,
    modifiers,
    orders: orders ? orders.slice(0, ORDER_LIST_LIMIT) : null,
    ordersTruncated: !!orders && orders.length > ORDER_LIST_LIMIT,
    unsold: available ? available.filter((m) => !soldIds.has(m.id)) : [],
    engineering,
    options,
  };
}
