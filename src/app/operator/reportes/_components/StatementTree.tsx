"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import type { Locale } from "@/i18n/config";
import { formatMoney } from "@/lib/format";
import {
  isRowVisible,
  parseExpansion,
  serializeExpansion,
  type Expansion,
} from "@/lib/erp/reports/pucTree";

/**
 * Tabla jerárquica plegable (balance de prueba y, más adelante, estados
 * financieros). Portado de zenith `statement-tree.tsx`.
 *
 * El estado de plegado vive en la URL (`?abrir=`; `*` = todo) y se cambia
 * con `router.replace`: compartir el enlace comparte lo desplegado. Las
 * filas plegadas se pintan igual pero ocultas (`report-row-hidden`) y
 * vuelven a salir al imprimir.
 */
export type TreeRow = {
  key: string;
  code: string;
  name: string;
  depth: number;
  ancestors: string[];
  hasChildren: boolean;
  /** Una cifra por columna, en centavos. */
  values: number[];
};

export function StatementTree({
  rows,
  columns,
  totals,
  totalLabel,
  currency,
  firstColumnLabel,
}: {
  rows: TreeRow[];
  /** Encabezados de las columnas numéricas. */
  columns: string[];
  totals: number[];
  totalLabel: string;
  currency: string;
  firstColumnLabel: string;
}) {
  const t = useTranslations("opReportes");
  const locale = useLocale() as Locale;
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams();
  const expanded = parseExpansion(search.get("abrir"));
  const money = (c: number) => formatMoney(c, { currency, locale });

  function commit(next: Expansion) {
    const params = new URLSearchParams(search.toString());
    const raw = serializeExpansion(next);
    if (raw) params.set("abrir", raw);
    else params.delete("abrir");
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
  }

  function toggle(row: TreeRow) {
    if (expanded === "all") {
      // De «todo abierto» a «todo menos esta rama»: se materializa el set.
      const all = new Set(rows.filter((r) => r.hasChildren).map((r) => r.key));
      all.delete(row.key);
      commit(all);
      return;
    }
    const next = new Set(expanded);
    if (next.has(row.key)) next.delete(row.key);
    else next.add(row.key);
    commit(next);
  }

  const isOpen = (row: TreeRow) => expanded === "all" || expanded.has(row.key);
  const allOpen = expanded === "all";

  return (
    <div className="rounded-2xl border border-op-border bg-op-surface overflow-hidden">
      <div className="no-print flex items-center justify-end gap-2 border-b border-op-border bg-op-bg px-3 py-2">
        <button
          type="button"
          className="mp-btn mp-btn--ghost mp-btn--sm"
          onClick={() => commit(allOpen ? new Set<string>() : "all")}
        >
          {allOpen ? t("collapseAll") : t("expandAll")}
        </button>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm min-w-[640px]">
          <thead>
            <tr className="border-b border-op-border text-op-muted">
              <th className="px-3 py-2 text-left font-mono text-[9px] uppercase tracking-wider font-normal">
                {firstColumnLabel}
              </th>
              {columns.map((c) => (
                <th
                  key={c}
                  className="px-3 py-2 text-right font-mono text-[9px] uppercase tracking-wider font-normal"
                >
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-op-border/50">
            {rows.map((r) => {
              const visible = isRowVisible(r, expanded);
              const bold = r.depth === 0;
              return (
                <tr
                  key={r.key}
                  className={[
                    !visible && "report-row-hidden",
                    bold ? "font-semibold bg-op-bg/60" : "",
                    r.depth === 1 && "font-medium",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  hidden={!visible}
                >
                  <td className="px-3 py-1.5 min-w-0">
                    <div
                      className="flex items-center gap-2 min-w-0"
                      style={{ paddingLeft: `${r.depth * 16}px` }}
                    >
                      {r.hasChildren ? (
                        <button
                          type="button"
                          onClick={() => toggle(r)}
                          aria-expanded={isOpen(r)}
                          className="no-print inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-op-muted hover:text-op-text"
                        >
                          <span
                            aria-hidden
                            className={`inline-block transition-transform ${isOpen(r) ? "rotate-90" : ""}`}
                          >
                            ›
                          </span>
                        </button>
                      ) : (
                        <span className="no-print inline-block h-5 w-5 shrink-0" />
                      )}
                      <span className="font-mono text-xs text-op-muted shrink-0">{r.code}</span>
                      <span className="truncate">{r.name}</span>
                    </div>
                  </td>
                  {r.values.map((v, i) => (
                    <td key={i} className="px-3 py-1.5 text-right font-mono tabular whitespace-nowrap">
                      {money(v)}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr className="border-t-2 border-op-border font-semibold bg-op-bg">
              <td className="px-3 py-2">{totalLabel}</td>
              {totals.map((v, i) => (
                <td key={i} className="px-3 py-2 text-right font-mono tabular whitespace-nowrap">
                  {money(v)}
                </td>
              ))}
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}
