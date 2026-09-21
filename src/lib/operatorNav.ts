// Menú del operador: fuente ÚNICA de los ítems para los tres shells (cockpit,
// clásico y drawer móvil) y para el buscador ⌘K. Es un módulo puro (sin React
// ni next-intl): devuelve CLAVES i18n del namespace `operator` y cada
// consumidor traduce. Así el armado (qué módulos prenden qué grupos, en qué
// orden) se testea sin renderizar nada.
import { isModuleEnabled } from "@/lib/modules";
import { contabilidadTabHref } from "@/lib/erp/contabilidadTabs";

export type NavLeafDef = { href: string; labelKey: string };
export type NavGroupDef = { labelKey: string; children: NavLeafDef[] };
export type NavEntryDef = NavLeafDef | NavGroupDef;

export type OperatorNavInput = {
  /** `Restaurant.enabledModules` crudo (Json de DB). */
  enabledModules: unknown;
  hasBar: boolean;
  /** `serviceMode === "counter"` → "Mostrador" en vez de "Mesas". */
  counterMode: boolean;
  reservationsEnabled: boolean;
};

const leaf = (href: string, labelKey: string): NavLeafDef => ({ href, labelKey });

/**
 * Grupo CONTABILIDAD — espejo del menú de zenith, más "Gastos y diario" como
 * primer ítem (zenith no lo tiene; acá las pestañas Gastos, PYG, Libros,
 * Diario, Estados, Impuestos y Bancos siguen viviendo en /operator/contabilidad
 * y necesitan quedar a un clic).
 */
function accountingGroup(): NavGroupDef {
  return {
    labelKey: "navAccounting",
    children: [
      leaf("/operator/contabilidad", "navAccDaily"),
      leaf(contabilidadTabHref("chart"), "navAccChart"),
      leaf("/operator/contabilidad/comprobantes", "navAccVouchers"),
      leaf("/operator/reportes/libro-mayor", "navAccLedger"),
      leaf("/operator/reportes/libro-diario", "navAccDailyBook"),
      leaf(contabilidadTabHref("presupuesto"), "navAccBudgets"),
      leaf(contabilidadTabHref("activos"), "navAccFixedAssets"),
      leaf("/operator/contabilidad/diferidos", "navAccDeferred"),
      leaf("/operator/contabilidad/cierre", "navAccPeriodClose"),
    ],
  };
}

/** Grupo REPORTES — mismo orden que zenith. */
function reportsGroup(): NavGroupDef {
  return {
    labelKey: "navGroupReports",
    children: [
      leaf("/operator/reportes", "navRepAll"),
      leaf("/operator/reportes/comisiones", "navRepCommissions"),
      leaf("/operator/reportes/cartera", "navRepReceivables"),
      leaf("/operator/reportes/impuestos", "navRepTaxes"),
      leaf("/operator/reportes/estado-situacion", "navRepBalanceSheet"),
      leaf("/operator/reportes/estado-resultado", "navRepIncome"),
      leaf("/operator/reportes/balance-prueba", "navRepTrialBalance"),
      leaf("/operator/reportes/exogena", "navRepExogena"),
    ],
  };
}

export function buildOperatorNav(input: OperatorNavInput): NavEntryDef[] {
  const on = (slug: Parameters<typeof isModuleEnabled>[1]) =>
    isModuleEnabled(input.enabledModules, slug);

  const erpItems: NavLeafDef[] = [
    ...(on("inventory") ? [leaf("/operator/inventario", "navInventory")] : []),
    ...(on("inventory") || on("purchasing") || on("recipes")
      ? [leaf("/operator/settings/insumos", "navInsumos")]
      : []),
    ...(on("purchasing") ? [leaf("/operator/compras", "navPurchasing")] : []),
    ...(on("recipes") ? [leaf("/operator/recetas", "navRecipes")] : []),
    ...(on("production") ? [leaf("/operator/produccion", "navProduction")] : []),
    ...(on("staff")
      ? [leaf("/operator/horarios", "navStaff"), leaf("/operator/nomina", "navPayroll")]
      : []),
  ];
  const ordersGroup: NavLeafDef[] = [
    leaf("/operator/orders", "navOrders"),
    leaf("/operator/clientes", "navCustomers"),
    leaf("/operator/payments", "navPayments"),
    leaf("/operator/facturas", "navInvoices"),
    leaf("/operator/ratings", "navRatings"),
  ];
  const menuGroup: NavLeafDef[] = [
    leaf("/operator/menu", "navMenu"),
    leaf("/operator/menus", "navMenus"),
  ];
  const businessGroup: NavLeafDef[] = [
    leaf("/operator/reports", "navClose"),
    leaf("/operator/wallet", "navWallet"),
    leaf("/operator/insights", "navInsights"),
    // Bonos empresariales: sólo con el módulo `vouchers` activo (la página
    // también devuelve 404 sin él).
    ...(on("vouchers") ? [leaf("/operator/bonos", "navVouchers")] : []),
  ];

  return [
    leaf("/operator", "navSummary"),
    leaf("/operator/kitchen", "navKitchen"),
    ...(input.hasBar ? [leaf("/operator/bar", "navBar")] : []),
    leaf("/operator/serve", "navHall"),
    leaf("/operator/tables", input.counterMode ? "navCounter" : "navTables"),
    ...(input.reservationsEnabled ? [leaf("/operator/reservas", "navReservations")] : []),
    { labelKey: "navGroupOrders", children: ordersGroup },
    { labelKey: "navGroupMenu", children: menuGroup },
    ...(erpItems.length > 0 ? [{ labelKey: "navErpGroup", children: erpItems }] : []),
    // Contabilidad y Reportes: dos grupos (como zenith), ambos detrás del
    // módulo `accounting` — las páginas destino devuelven 404 sin él.
    ...(on("accounting") ? [accountingGroup(), reportsGroup()] : []),
    { labelKey: "navGroupBusiness", children: businessGroup },
    leaf("/operator/settings", "navSettings"),
    leaf("/operator/ayuda", "navHelp"),
  ];
}

/* ───────────────────────── Ítem activo ───────────────────────── */

export type NavLocation = {
  pathname: string | null;
  /** `?tab=` de la URL actual (las pestañas de contabilidad son ítems propios). */
  tab?: string | null;
};

/** Cualquier forma de nav (con claves o ya traducida): sólo importa el href. */
type NavLike =
  | { href: string }
  | { children: readonly { href: string }[] };

function leaves(entries: readonly NavLike[]): { href: string }[] {
  return entries.flatMap((e) => ("children" in e ? [...e.children] : [e]));
}

/** href → ruta + pestaña pedida (`/operator/contabilidad?tab=chart`). */
function splitHref(href: string): { path: string; tab: string | null } {
  const q = href.indexOf("?");
  if (q < 0) return { path: href, tab: null };
  return {
    path: href.slice(0, q),
    tab: new URLSearchParams(href.slice(q + 1)).get("tab"),
  };
}

/**
 * Puntaje de coincidencia de un href con la ubicación actual (-1 = no
 * coincide). Gana el más específico: pestaña exacta > ruta exacta > prefijo
 * más largo. "/operator" (Resumen) sólo coincide exacto — si no, estaría
 * activo en todo el panel.
 */
function matchScore(href: string, loc: NavLocation): number {
  if (!loc.pathname) return -1;
  const { path, tab } = splitHref(href);
  if (tab) {
    return loc.pathname === path && (loc.tab ?? null) === tab ? path.length + 1000 : -1;
  }
  if (loc.pathname === path) return path.length + 500;
  if (path !== "/operator" && loc.pathname.startsWith(path + "/")) return path.length;
  return -1;
}

/**
 * Href del ÚNICO ítem activo para la ubicación actual, o null. Se resuelve
 * sobre toda la nav (no ítem por ítem) para que un hub ("Todos los reportes",
 * "Gastos y diario") no quede encendido junto con la subpágina o pestaña
 * que tiene ítem propio.
 */
export function resolveActiveHref(
  entries: readonly NavLike[],
  loc: NavLocation,
): string | null {
  let best: string | null = null;
  let bestScore = -1;
  for (const { href } of leaves(entries)) {
    const s = matchScore(href, loc);
    if (s > bestScore) {
      best = href;
      bestScore = s;
    }
  }
  return best;
}
