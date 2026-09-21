"use client";

import Link from "next/link";
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
 * Tabla jerárquica plegable (balance de prueba y estados financieros).
 * Portado de zenith `statement-tree.tsx`.
 *
 * El estado de plegado vive en la URL (`?abrir=`, o el `param` que pida
 * la página cuando tiene varias secciones: `abrir_activo`…; `*` = todo) y
 * se cambia con `router.replace`: compartir el enlace comparte lo
 * desplegado. Las filas plegadas se pintan igual pero ocultas
 * (`report-row-hidden`) y vuelven a salir al imprimir.
 *
 * Un renglón puede llevar `variant` (línea, banda, subtotal, total,
 * encabezado, nota) para los estados en cascada; sin él, el estilo va por
 * profundidad como en el balance de prueba. Los encabezados y notas no
 * llevan cifra (`values: []`). `href` enlaza la cuenta a su detalle
 * (mayor o balance de prueba): la página lo calcula porque un componente
 * cliente no recibe funciones del servidor.
 */
export type TreeRowVariant = "line" | "group" | "subtotal" | "total" | "head" | "note";

export type TreeRow = {
  key: string;
  code: string;
  name: string;
  depth: number;
  ancestors: string[];
  hasChildren: boolean;
  /** Una cifra por columna, en centavos (vacío en encabezados y notas). */
  values: number[];
  variant?: TreeRowVariant;
  /** Resalta la línea (p. ej. la utilidad del ejercicio en el patrimonio). */
  emphasis?: boolean;
  /** Enlace al detalle del renglón. */
  href?: string;
};

function rowClass(r: TreeRow): string {
  if (!r.variant) {
    if (r.depth === 0) return "font-semibold bg-op-bg/60";
    if (r.depth === 1) return "font-medium";
    return "";
  }
  switch (r.variant) {
    case "group":
      return r.depth === 0 ? "font-semibold bg-op-bg/60" : "font-medium";
    case "subtotal":
      return "font-semibold border-t-2 border-op-border bg-op-bg/40";
    case "total":
      return (r.values[0] ?? 0) < 0
        ? "font-semibold border-t-2 border-op-border bg-danger/10 text-danger"
        : "font-semibold border-t-2 border-op-border bg-op-accent/10";
    case "head":
      return "text-[10px] uppercase tracking-wider text-op-muted bg-op-bg/40";
    case "note":
      return "text-xs text-op-muted";
    default:
      return r.emphasis ? "font-medium" : "";
  }
}

export function StatementTree({
  rows,
  columns,
  totals,
  totalLabel,
  currency,
  firstColumnLabel,
  param = "abrir",
  empty,
}: {
  rows: TreeRow[];
  /** Encabezados de las columnas numéricas. */
  columns: string[];
  /** Fila de cierre (total activo…); sin ella no hay pie de tabla. */
  totals?: number[];
  totalLabel?: string;
  currency: string;
  firstColumnLabel: string;
  /** Parámetro de la URL con el plegado (uno por sección en una misma página). */
  param?: string;
  /** Aviso cuando no hay renglones (la fila de total sigue saliendo). */
  empty?: string;
}) {
  const t = useTranslations("opReportes");
  const locale = useLocale() as Locale;
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams();
  const expanded = parseExpansion(search.get(param));
  const money = (c: number) => formatMoney(c, { currency, locale });
  const branches = rows.filter((r) => r.hasChildren).map((r) => r.key);

  function commit(next: Expansion) {
    const params = new URLSearchParams(search.toString());
    const raw = serializeExpansion(next);
    if (raw) params.set(param, raw);
    else params.delete(param);
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
  }

  function toggle(row: TreeRow) {
    if (expanded === "all") {
      // De «todo abierto» a «todo menos esta rama»: se materializa el set.
      const all = new Set(branches);
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
  const colSpan = columns.length + 1;

  return (
    <div className="rounded-2xl border border-op-border bg-op-surface overflow-hidden">
      {branches.length > 0 && (
        <div className="no-print flex items-center justify-end gap-2 border-b border-op-border bg-op-bg px-3 py-2">
          <button
            type="button"
            className="mp-btn mp-btn--ghost mp-btn--sm"
            onClick={() => commit(allOpen ? new Set<string>() : "all")}
          >
            {allOpen ? t("collapseAll") : t("expandAll")}
          </button>
        </div>
      )}
      <div className="overflow-x-auto">
        <table className={`w-full text-sm ${columns.length > 1 ? "min-w-[640px]" : "min-w-[360px]"}`}>
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
            {rows.length === 0 && empty && (
              <tr>
                <td colSpan={colSpan} className="px-3 py-3 text-sm text-op-muted">
                  {empty}
                </td>
              </tr>
            )}
            {rows.map((r) => {
              const visible = isRowVisible(r, expanded);
              const blank = r.variant === "head" || r.variant === "note";
              return (
                <tr
                  key={r.key}
                  className={[!visible && "report-row-hidden", rowClass(r)].filter(Boolean).join(" ")}
                  hidden={!visible}
                >
                  <td className="px-3 py-1.5 min-w-0" colSpan={blank ? colSpan : undefined}>
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
                      {r.code && <span className="font-mono text-xs text-op-muted shrink-0">{r.code}</span>}
                      {r.href ? (
                        <Link
                          href={r.href}
                          className="truncate underline decoration-op-border underline-offset-2 hover:text-op-accent"
                        >
                          {r.name}
                        </Link>
                      ) : (
                        <span className="truncate">{r.name}</span>
                      )}
                    </div>
                  </td>
                  {!blank &&
                    r.values.map((v, i) => (
                      <td
                        key={i}
                        className={`px-3 py-1.5 text-right font-mono tabular whitespace-nowrap ${
                          v === 0 && !r.emphasis ? "text-op-muted" : ""
                        }`}
                      >
                        {money(v)}
                      </td>
                    ))}
                </tr>
              );
            })}
          </tbody>
          {totals && totalLabel != null && (
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
          )}
        </table>
      </div>
    </div>
  );
}
