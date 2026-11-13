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
    <div className="space-y-1.5">
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
          <div key={key} className={`rounded-xl border px-3 py-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 ${doubtful ? "border-terracotta/40 bg-terracotta/5" : "border-op-border bg-op-surface"}`}>
            <span id={titleId} className="text-xs font-medium break-words">
              {t("invRecColumnTitle", { name })}
            </span>
            <span role="radiogroup" aria-labelledby={titleId} className="inline-flex rounded-lg border border-op-border overflow-hidden">
              {column.options.map(scope => (
                <button key={scope} type="button" role="radio" aria-checked={chosen === scope}
                  onClick={() => onChange(key, scope)}
                  className={"min-h-[32px] px-3 text-xs font-medium transition-colors border-r border-op-border last:border-r-0 " +
                    (chosen === scope ? "bg-ink text-bone" : "bg-op-bg hover:bg-op-surface")}>
                  {t(SCOPE_LABEL[scope])}
                </button>
              ))}
            </span>
            <span className={`text-[11px] leading-snug ${doubtful ? "font-medium text-terracotta" : "text-op-muted"}`}>
              {isManual ? t("invRecStatusManual") : t(STATUS_TEXT[column.status])}
            </span>
            {doubtful && column.aiEvidence?.trim() && column.aiScope !== "unknown" && (
              <span className="basis-full text-[10px] text-op-muted break-words">
                {t("invRecAiHypothesis", { scope: t(SCOPE_LABEL[column.aiScope]), evidence: column.aiEvidence.trim() })}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}
