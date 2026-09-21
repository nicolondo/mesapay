// Pestañas de /operator/contabilidad. Viven acá (y no en el cliente) porque
// las comparten tres lugares: el cliente (pestaña inicial desde `?tab=`), el
// menú lateral (ítems que abren una pestaña directa) y el hub de reportes.

export const CONTABILIDAD_TABS = [
  "expenses",
  "pnl",
  "books",
  "chart",
  "diario",
  "estados",
  "impuestos",
  "bancos",
  "activos",
  "presupuesto",
] as const;

export type ContabilidadTab = (typeof CONTABILIDAD_TABS)[number];

export const DEFAULT_CONTABILIDAD_TAB: ContabilidadTab = "expenses";

/** `?tab=` crudo → pestaña válida, o null si no es ninguna. */
export function parseContabilidadTab(
  raw: string | null | undefined,
): ContabilidadTab | null {
  return raw != null && (CONTABILIDAD_TABS as readonly string[]).includes(raw)
    ? (raw as ContabilidadTab)
    : null;
}

/** URL de la página de contabilidad abierta en una pestaña concreta. */
export function contabilidadTabHref(tab: ContabilidadTab): string {
  return `/operator/contabilidad?tab=${tab}`;
}
