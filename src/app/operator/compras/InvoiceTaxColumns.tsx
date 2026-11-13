"use client";

// Control por COLUMNA de impuesto de la factura importada: «por unidad /
// total de la línea / % de la base». Viene preseleccionado con lo que eligió
// la conciliación (invoiceReconcile.ts) y al cambiarlo se recalculan todas
// las líneas y el resumen «Factura vs MESAPAY» al instante.
import { useTranslations } from "next-intl";
import type { TaxCellScope, TaxColumnKey, TaxColumnResolution } from "@/lib/erp/invoiceReconcile";

const SCOPE_LABEL: Record<TaxCellScope, string> = {
  unit: "invRecScopeUnit",
  line: "invRecScopeLine",
  percent: "invRecScopePercent",
};
const STATUS_TEXT: Record<TaxColumnResolution["status"], string> = {
  matched: "invRecStatusMatched",
  equivalent: "invRecStatusMatched",
  ambiguous: "invRecStatusAmbiguous",
  mismatch: "invRecStatusMismatch",
  unverified: "invRecStatusUnverified",
};

export type TaxColumnEntry = { key: TaxColumnKey; column: TaxColumnResolution };

/** Solo las columnas donde la lectura cambia algo (más de una opción con montos distintos). */
export function reviewableTaxColumns(columns: { iva?: TaxColumnResolution | null; consumo?: TaxColumnResolution | null } | undefined): TaxColumnEntry[] {
  return (["consumo", "iva"] as const).flatMap(key => {
    const column = columns?.[key];
    return column && column.options.length > 1 && column.status !== "equivalent" ? [{ key, column }] : [];
  });
}

export function InvoiceTaxColumns({ columns, scopes, manual, onChange }: {
  columns: TaxColumnEntry[];
  scopes: Record<TaxColumnKey, TaxCellScope | null>;
  manual: Record<TaxColumnKey, boolean>;
  onChange: (key: TaxColumnKey, scope: TaxCellScope) => void;
}) {
  const t = useTranslations("opErp");
  if (!columns.length) return null;
  return (
    <div className="space-y-2">
      <div className="font-mono text-[10px] tracking-[0.15em] uppercase text-op-muted pt-1">
        {t("invRecColumnsSection")}
      </div>
      {columns.map(({ key, column }) => {
        const chosen = scopes[key];
        const isManual = manual[key];
        const doubtful = !isManual && column.status !== "matched";
        const name = column.header?.trim() || t(key === "iva" ? "invRecColumnIva" : "invRecColumnConsumo");
        const titleId = `inv-tax-column-${key}`;
        return (
          <div key={key} className={`rounded-xl border p-3 space-y-2 ${doubtful ? "border-terracotta/40 bg-terracotta/5" : "border-op-border bg-op-surface"}`}>
            <div id={titleId} className="text-sm font-medium break-words">
              {t("invRecColumnTitle", { name })}
            </div>
            <div role="radiogroup" aria-labelledby={titleId}
              className={`grid gap-2 ${column.options.length > 2 ? "grid-cols-3" : "grid-cols-2"}`}>
              {column.options.map(scope => (
                <button key={scope} type="button" role="radio" aria-checked={chosen === scope}
                  onClick={() => onChange(key, scope)}
                  className={"min-h-[44px] px-2 rounded-xl border text-xs font-medium transition-colors " +
                    (chosen === scope ? "border-ink bg-ink text-bone" : "border-op-border bg-op-bg hover:bg-op-surface")}>
                  {t(SCOPE_LABEL[scope])}
                </button>
              ))}
            </div>
            <p className={`text-[11px] leading-relaxed ${doubtful ? "font-medium text-terracotta" : "text-op-muted"}`}>
              {isManual ? t("invRecStatusManual") : t(STATUS_TEXT[column.status])}
            </p>
            {column.aiEvidence?.trim() && column.aiScope !== "unknown" && (
              <p className="text-[10px] text-op-muted break-words">
                {t("invRecAiHypothesis", { scope: t(SCOPE_LABEL[column.aiScope]), evidence: column.aiEvidence.trim() })}
              </p>
            )}
          </div>
        );
      })}
    </div>
  );
}
