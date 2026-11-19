// Registro central de DESTINOS del buscador ⌘K del operador, más la lógica
// pura de filtrado/orden. El buscador (src/app/operator/NavigationSearch.tsx)
// ya indexa el menú lateral; este registro agrega las SUBSECCIONES que viven
// como pestañas o subpáginas dentro de una sección (Compras → Pagos,
// Inventario → Conteos, Configuración → Impresoras…) y que el menú no lista.
//
// ── Cómo agregar un destino nuevo ───────────────────────────────────────────
// 1. Agrega una entrada a OPERATOR_SEARCH_DESTINATIONS con:
//      href       → URL real (puede llevar ?tab=…). Única en el registro.
//      labelKey   → clave i18n COMPLETA ("ns.clave") del rótulo visible.
//                   Reusa la clave que ya pinta la pestaña/tarjeta.
//      groupKey   → clave i18n COMPLETA de la sección madre (operator.nav…):
//                   el resultado se muestra «Rótulo — Grupo».
//      parentHref → href (sin query) del ítem del menú del que cuelga. El
//                   destino sólo aparece si ese ítem está en el menú actual
//                   (así hereda el gating por módulos y no sale en el admin).
//      keywordsKey→ (opcional) clave COMPLETA en el namespace `opSearch` con
//                   sinónimos/palabras clave separadas por espacios, por
//                   idioma (messages/{es,en,pt}.json).
// 2. Si agregaste keywordsKey o un rótulo nuevo: claves en es.json + en.json
//    + pt.json (skill mesapay-i18n — nunca sólo en español).
// 3. `npx vitest run src/lib/operatorSearch.test.ts` verifica que el href
//    exista como página, que la pestaña pedida sea real, que las claves i18n
//    estén en los tres catálogos y que las subpáginas del mapa de ayuda
//    (coverage.ts) estén registradas o excluidas con razón.

export type SearchDestinationDef = {
  href: string;
  labelKey: string;
  groupKey: string;
  parentHref: string;
  keywordsKey?: string;
};

const d = (
  href: string,
  labelKey: string,
  groupKey: string,
  parentHref: string,
  keywordsKey?: string,
): SearchDestinationDef => ({ href, labelKey, groupKey, parentHref, keywordsKey });

export const OPERATOR_SEARCH_DESTINATIONS: readonly SearchDestinationDef[] = [
  /* ── Compras ── */
  d("/operator/compras?tab=unpaid", "opErp.tabUnpaid", "operator.navPurchasing", "/operator/compras", "opSearch.kwComprasUnpaid"),
  d("/operator/compras/notas-credito", "opSupplierCredit.tabCreditNotes", "operator.navPurchasing", "/operator/compras", "opSearch.kwComprasCreditNotes"),
  d("/operator/compras/pagos", "opSupplierPayment.tabPayments", "operator.navPurchasing", "/operator/compras", "opSearch.kwComprasPagos"),

  /* ── Inventario (la pestaña Existencias es la página misma) ── */
  d("/operator/inventario?tab=movimientos", "opErp.tabMovements", "operator.navInventory", "/operator/inventario", "opSearch.kwInvMovimientos"),
  d("/operator/inventario?tab=conteos", "opErp.tabCounts", "operator.navInventory", "/operator/inventario", "opSearch.kwInvConteos"),

  /* ── Facturas ── */
  d("/operator/facturas/notas-credito", "opCreditNotes.title", "operator.navInvoices", "/operator/facturas", "opSearch.kwFacturasNotasCredito"),

  /* ── Contabilidad: pestañas SIN ítem propio en el menú (Gastos es la
        página misma; Plan de cuentas, Presupuestos y Activos ya están). ── */
  d("/operator/contabilidad?tab=pnl", "opErp.tabPnl", "operator.navAccounting", "/operator/contabilidad", "opSearch.kwContabPnl"),
  d("/operator/contabilidad?tab=books", "opErp.tabBooks", "operator.navAccounting", "/operator/contabilidad", "opSearch.kwContabBooks"),
  d("/operator/contabilidad?tab=diario", "opErp.tabDiario", "operator.navAccounting", "/operator/contabilidad", "opSearch.kwContabDiario"),
  d("/operator/contabilidad?tab=estados", "opErp.tabEstados", "operator.navAccounting", "/operator/contabilidad", "opSearch.kwContabEstados"),
  d("/operator/contabilidad?tab=impuestos", "opErp.tabImpuestos", "operator.navAccounting", "/operator/contabilidad", "opSearch.kwContabImpuestos"),
  d("/operator/contabilidad?tab=bancos", "opErp.tabBancos", "operator.navAccounting", "/operator/contabilidad", "opSearch.kwContabBancos"),

  /* ── Reportes ── */
  d("/operator/reportes/notas-credito-proveedores", "opSupplierCredit.reportTitle", "operator.navGroupReports", "/operator/reportes"),

  /* ── Cierre ── */
  d("/operator/shifts", "opShifts.title", "operator.navClose", "/operator/reports", "opSearch.kwShifts"),

  /* ── Carta y mesas ── */
  d("/operator/menu/import", "opMenuImport.title", "operator.navMenu", "/operator/menu", "opSearch.kwMenuImport"),
  d("/operator/tables/print", "opTables.printHeading", "operator.navTables", "/operator/tables", "opSearch.kwTablesPrint"),

  /* ── Equipo ── */
  d("/operator/horarios/kiosko", "opErp.kioskTitle", "operator.navStaff", "/operator/horarios", "opSearch.kwKiosko"),

  /* ── Bonos ── */
  d("/operator/bonos/reporte", "opVouchers.reportTitle", "operator.navVouchers", "/operator/bonos", "opSearch.kwBonosReporte"),

  /* ── Configuración (tarjetas del hub; Insumos ya es ítem del menú) ── */
  d("/operator/settings/identidad", "opSettings.cardIdentityTitle", "operator.navSettings", "/operator/settings", "opSearch.kwSetIdentidad"),
  d("/operator/settings/usuarios", "opSettings.cardUsersTitle", "operator.navSettings", "/operator/settings", "opSearch.kwSetUsuarios"),
  d("/operator/settings/pagos", "opSettings.cardPaymentsTitle", "operator.navSettings", "/operator/settings", "opSearch.kwSetPagos"),
  d("/operator/settings/etiquetas", "opSettings.cardTagsTitle", "operator.navSettings", "/operator/settings"),
  d("/operator/settings/proveedores", "opErp.cardProveedoresTitle", "operator.navSettings", "/operator/settings", "opSearch.kwSetProveedores"),
  d("/operator/settings/facturacion-dian", "opDian.cardTitle", "operator.navSettings", "/operator/settings", "opSearch.kwSetFacturacionDian"),
  d("/operator/settings/impuestos", "opSalesTax.cardTitle", "operator.navSettings", "/operator/settings", "opSearch.kwSetImpuestos"),
  d("/operator/settings/bonos", "opVouchers.cardTitle", "operator.navSettings", "/operator/settings"),
  d("/operator/settings/traducciones", "opSettings.cardTranslationsTitle", "operator.navSettings", "/operator/settings", "opSearch.kwSetTraducciones"),
  d("/operator/settings/datafonos", "opSettings.cardDevicesTitle", "operator.navSettings", "/operator/settings", "opSearch.kwSetDatafonos"),
  d("/operator/settings/staff-policies", "opSettings.cardPoliciesTitle", "operator.navSettings", "/operator/settings", "opSearch.kwSetPoliticas"),
  d("/operator/settings/meseros", "opSettings.cardMeserosTitle", "operator.navSettings", "/operator/settings", "opSearch.kwSetMeseros"),
  d("/operator/settings/estaciones", "opSettings.cardStationsTitle", "operator.navSettings", "/operator/settings", "opSearch.kwSetEstaciones"),
  d("/operator/settings/impresoras", "opSettings.cardPrintersTitle", "operator.navSettings", "/operator/settings", "opSearch.kwSetImpresoras"),
  d("/operator/settings/reservas", "opSettings.cardReservasTitle", "operator.navSettings", "/operator/settings"),
  d("/operator/settings/mesas", "opSettings.cardMesasTitle", "operator.navSettings", "/operator/settings"),
  d("/operator/settings/salon", "opSettings.cardSalonTitle", "operator.navSettings", "/operator/settings", "opSearch.kwSetSalon"),
  d("/operator/settings/suscripcion", "opSettings.subscriptionCardTitle", "operator.navSettings", "/operator/settings", "opSearch.kwSetSuscripcion"),
  d("/operator/settings/backups", "opBackups.cardTitle", "operator.navSettings", "/operator/settings", "opSearch.kwSetBackups"),
];

/**
 * Pantallas ESTÁTICAS del operador (mapeadas en la ayuda, coverage.ts) que a
 * propósito NO son destino del buscador ni ítem del menú — con la razón. El
 * test `operatorSearch.test.ts` exige que toda pantalla estática del operador
 * esté en el menú, en el registro de arriba o acá: una pantalla nueva sin
 * decidir rompe la CI.
 */
export const SEARCH_EXCLUDED_SCREENS: Record<string, string> = {
  "/operator/contabilidad/comprobantes/nuevo":
    "Acción de creación: se llega con el botón de Comprobantes, no es un lugar que se busque.",
  "/operator/reportes/impuestos-detallados":
    "Ruta vieja: redirige a Impuestos del período (que sí está en el menú).",
};

/* ───────────────────────── Lógica pura del buscador ───────────────────── */

/** href → ruta sin query ("/operator/compras?tab=unpaid" → "/operator/compras"). */
export function searchHrefPath(href: string): string {
  const q = href.indexOf("?");
  return q < 0 ? href : href.slice(0, q);
}

/** Sin acentos ni mayúsculas — mismo criterio para rótulos y consulta. */
export function normalizeSearchText(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase();
}

/**
 * Destinos del registro que aplican al menú actual: su `parentHref` tiene
 * que ser un ítem del menú (hereda el gating por módulos; en el shell del
 * admin de plataforma no aplica ninguno) y su href no estar ya en el menú.
 */
export function destinationsForNav(
  navHrefs: readonly string[],
): SearchDestinationDef[] {
  const paths = new Set(navHrefs.map(searchHrefPath));
  const exact = new Set(navHrefs);
  return OPERATOR_SEARCH_DESTINATIONS.filter(
    (dest) => paths.has(dest.parentHref) && !exact.has(dest.href),
  );
}

/** Entrada ya traducida, lista para filtrar y pintar. */
export type SearchLink = {
  href: string;
  label: string;
  group: string;
  /** Sinónimos traducidos (sólo destinos del registro). */
  keywords?: string;
  /** true = subsección del registro; false/ausente = ítem del menú. */
  sub?: boolean;
};

/**
 * Filtra y ordena: primero coincidencias de rótulo, luego de grupo, luego de
 * sinónimos; a igualdad, secciones del menú antes que subsecciones (el sort
 * es estable, así que dentro de cada franja se conserva el orden del menú /
 * del registro). Consulta vacía → todo, menú primero.
 */
export function filterSearchLinks(
  links: readonly SearchLink[],
  query: string,
): SearchLink[] {
  const q = normalizeSearchText(query.trim());
  const tier = (l: SearchLink): number => {
    if (!q) return 0;
    if (normalizeSearchText(l.label).includes(q)) return 0;
    if (normalizeSearchText(l.group).includes(q)) return 1;
    if (l.keywords && normalizeSearchText(l.keywords).includes(q)) return 2;
    return -1;
  };
  return links
    .map((l) => ({ l, t: tier(l) }))
    .filter((m) => m.t >= 0)
    .sort((a, b) => a.t - b.t || Number(a.l.sub ?? false) - Number(b.l.sub ?? false))
    .map((m) => m.l);
}
