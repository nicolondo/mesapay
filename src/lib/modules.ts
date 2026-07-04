// Módulos ERP activables por comercio.
//
// Requisito transversal del roadmap ERP (docs/roadmap-erp-modulos.md):
// toda funcionalidad administrativa nueva (inventario, compras, recetas,
// facturación electrónica, contabilidad, producción, personal) nace detrás
// de un toggle POR COMERCIO que maneja el admin de plataforma. Default:
// apagado. Un comercio con módulo apagado no ve ninguna superficie de ese
// módulo (nav, pantallas, campos). Comercios con ERP propio los dejan
// apagados y a futuro se integran vía exports/API.
//
// Este archivo es la fuente única del catálogo de slugs. Los labels y
// descripciones visibles al usuario viven en los catálogos i18n
// (opAdmin.module*) — acá solo metadata estable.

export type ModuleSlug =
  | "inventory" // A1 — existencias, movimientos, conteos, mermas
  | "purchasing" // A0/A2 — proveedores, órdenes de compra, recepción, CxP
  | "recipes" // A3 — recetas, costeo, ingeniería de menú
  | "einvoicing" // B1 — facturación electrónica (DIAN / CFDI)
  | "accounting" // B2 — gastos, libros operativos, P&L, export contable
  | "production" // A5 — batches de sub-recetas, traslados entre sedes
  | "staff"; // C1 — horarios, asistencia, costo laboral

export type ModuleConfig = {
  slug: ModuleSlug;
  /**
   * false = la fase del roadmap todavía no se construyó: el toggle aparece
   * deshabilitado con badge "próximamente" en el panel del admin. Cada fase
   * que sale a producción flipa su módulo a true.
   */
  shipped: boolean;
};

export const MODULE_CATALOG: ModuleConfig[] = [
  { slug: "einvoicing", shipped: false },
  { slug: "purchasing", shipped: false },
  { slug: "inventory", shipped: false },
  { slug: "recipes", shipped: false },
  { slug: "accounting", shipped: false },
  { slug: "production", shipped: false },
  { slug: "staff", shipped: false },
];

export const MODULE_SLUGS = MODULE_CATALOG.map((m) => m.slug);

/**
 * Normaliza el Json crudo de Restaurant.enabledModules a slugs conocidos.
 * null / inválido / vacío → [] (todo apagado — opt-in, a diferencia de
 * enabledPaymentMethods donde null = todo prendido).
 */
export function resolveEnabledModules(raw: unknown): ModuleSlug[] {
  if (!Array.isArray(raw)) return [];
  const known = new Set<string>(MODULE_SLUGS);
  const out: ModuleSlug[] = [];
  for (const v of raw) {
    if (typeof v === "string" && known.has(v) && !out.includes(v as ModuleSlug)) {
      out.push(v as ModuleSlug);
    }
  }
  return out;
}

/** ¿Tiene este comercio el módulo activado? Acepta el Json crudo de DB. */
export function isModuleEnabled(
  enabledModulesRaw: unknown,
  slug: ModuleSlug,
): boolean {
  return resolveEnabledModules(enabledModulesRaw).includes(slug);
}
