/**
 * Etiquetas de los estados financieros que nacen en la lógica PURA
 * (`balanceSheet.ts`, `incomeStatement.ts`) y se traducen en la página o
 * en la ruta API. La lib no importa `next-intl`: cada renglón lleva o bien
 * la CLAVE del catálogo `opReportes` (con sus parámetros ICU) o bien un
 * TEXTO ya resuelto (el nombre de una cuenta del plan, que no se traduce).
 */
export type StatementLabel =
  | { key: string; params?: Record<string, string | number> }
  | { text: string };

type TranslatorLike = (key: string, params?: Record<string, string | number>) => string;

/** Texto final de una etiqueta con el traductor de la superficie. */
export function labelText(label: StatementLabel, t: TranslatorLike): string {
  return "text" in label ? label.text : t(label.key, label.params);
}
