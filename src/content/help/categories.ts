/**
 * Registro de categorías del centro de ayuda: orden, id e ícono.
 *
 * El id es definitivo: es el nombre del archivo de contenido
 * (`src/content/help/<idioma>/<id>.json`) y el segmento de la URL
 * (`/operator/ayuda/<id>`). El título y la descripción de cada categoría
 * viven en el JSON de cada idioma, no acá.
 *
 * El ícono es un nombre de `src/components/help/HelpIcon.tsx`.
 */
export const HELP_CATEGORIES = [
  { id: "primeros-pasos", icon: "start" },
  { id: "salon-y-pedidos", icon: "tables" },
  { id: "cobro-y-caja", icon: "cash" },
  { id: "app-del-mesero", icon: "phone" },
  { id: "experiencia-del-comensal", icon: "diner" },
  { id: "carta-y-produccion", icon: "menu" },
  { id: "facturacion", icon: "invoice" },
  { id: "contabilidad-y-reportes", icon: "chart" },
  { id: "equipo-y-nomina", icon: "team" },
  { id: "pagos-en-linea", icon: "card" },
  { id: "impresion-y-equipos", icon: "printer" },
] as const;

export type HelpCategoryId = (typeof HELP_CATEGORIES)[number]["id"];
export type HelpIconName = (typeof HELP_CATEGORIES)[number]["icon"];

export const HELP_CATEGORY_IDS: readonly HelpCategoryId[] = HELP_CATEGORIES.map(
  (c) => c.id,
);

export function isHelpCategoryId(value: string): value is HelpCategoryId {
  return (HELP_CATEGORY_IDS as readonly string[]).includes(value);
}
