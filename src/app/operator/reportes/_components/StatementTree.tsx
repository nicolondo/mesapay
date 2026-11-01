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
import {
  CardFacts,
  CardTotal,
  cx,
  depthStyle,
  ReportCards,
  ReportScroll,
  ReportTable,
} from "./ReportCards";

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
 *
 * CELULAR (< 768px):
 *  · con UNA columna numérica (ESFA, estado de resultado) la propia tabla
 *    cabe: sin `min-width`, el nombre envuelve hasta 2 líneas
 *    (`.report-name`), sangría de 8px por nivel (`.report-indent`) y la
 *    cifra en 13px en una sola línea;
 *  · con VARIAS columnas (balance de prueba) la tabla oficial se oculta
 *    (`.report-table`) y sale una vista apilada (`.report-cards`): por
 *    cuenta, código + nombre y debajo una grilla rótulo → valor con los
 *    mismos `columns`, con el mismo plegado y el mismo enlace al detalle.
 *    Elegimos la vista apilada y no el scroll lateral porque cuatro
 *    columnas de dinero en 358px obligaban a desplazar para leer el saldo.
 *  La tabla oficial se imprime SIEMPRE completa (bloque print de
 *  ReportShell + workspace.css); las tarjetas nunca (`no-print`).
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

// Celdas: 8px de relleno lateral en el celular, 12px (como antes) en md+.
const CELL_X = "px-2 md:px-3";
const CELL = `${CELL_X} py-1.5`;
const NUM_X = `${CELL_X} text-right font-mono tabular whitespace-nowrap text-[13px] md:text-sm`;
const NUM = `${NUM_X} py-1.5`;
const TH = `${CELL_X} py-2 font-mono text-[9px] uppercase tracking-wider font-normal`;

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
  const multi = columns.length > 1;
  const isBlank = (r: TreeRow) => r.variant === "head" || r.variant === "note";

  /** Flecha de plegado (o su hueco, para que las hojas alineen). */
  const toggleButton = (r: TreeRow) =>
    r.hasChildren ? (
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
    );

  const nameLink = (r: TreeRow, className: string) =>
    r.href ? (
      <Link
        href={r.href}
        className={`${className} underline decoration-op-border underline-offset-2 hover:text-op-accent`}
      >
        {r.name}
      </Link>
    ) : (
      <span className={className}>{r.name}</span>
    );

  // La tabla oficial: con una columna es la única vista (cabe en el
  // celular); con varias se oculta en < md y la reemplazan las tarjetas.
  const Wrapper = multi ? ReportTable : ReportScroll;

  return (
    <div className="min-w-0 max-w-full overflow-hidden rounded-2xl border border-op-border bg-op-surface">
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
      <Wrapper>
        <table className={cx("w-full text-sm", multi && "min-w-[640px]")}>
          <thead>
            <tr className="border-b border-op-border text-op-muted">
              <th className={`${TH} text-left`}>{firstColumnLabel}</th>
              {columns.map((c) => (
                <th key={c} className={`${TH} text-right`}>
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
              const blank = isBlank(r);
              return (
                <tr
                  key={r.key}
                  className={cx(!visible && "report-row-hidden", rowClass(r))}
                  hidden={!visible}
                >
                  <td className={`${CELL} min-w-0`} colSpan={blank ? colSpan : undefined}>
                    <div
                      className="report-indent flex min-w-0 items-start gap-1.5 md:items-center md:gap-2"
                      style={depthStyle(r.depth)}
                    >
                      {toggleButton(r)}
                      {r.code && <span className="font-mono text-xs text-op-muted shrink-0">{r.code}</span>}
                      {nameLink(r, "report-name")}
                    </div>
                  </td>
                  {!blank &&
                    r.values.map((v, i) => (
                      <td key={i} className={cx(NUM, v === 0 && !r.emphasis && "text-op-muted")}>
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
                <td className={`${CELL_X} py-2`}>{totalLabel}</td>
                {totals.map((v, i) => (
                  <td key={i} className={`${NUM_X} py-2`}>
                    {money(v)}
                  </td>
                ))}
              </tr>
            </tfoot>
          )}
        </table>
      </Wrapper>

      {multi && (
        <ReportCards>
          {rows.length === 0 && empty && <div className="px-3 py-3 text-op-muted">{empty}</div>}
          {rows
            .filter((r) => isRowVisible(r, expanded))
            .map((r) => (
              <div key={r.key} className={cx("px-3 py-2", rowClass(r))}>
                <div className="report-indent flex min-w-0 items-start gap-1.5" style={depthStyle(r.depth)}>
                  {toggleButton(r)}
                  <div className="min-w-0 flex-1">
                    <div className="min-w-0 break-words">
                      {r.code && <span className="mr-1.5 font-mono text-xs text-op-muted">{r.code}</span>}
                      {nameLink(r, "")}
                    </div>
                    {!isBlank(r) && (
                      <CardFacts
                        className="mt-1.5"
                        items={columns.map((c, i) => {
                          const v = r.values[i] ?? 0;
                          return {
                            label: c,
                            value: money(v),
                            tone: v === 0 && !r.emphasis ? "muted" : undefined,
                          };
                        })}
                      />
                    )}
                  </div>
                </div>
              </div>
            ))}
          {totals && totalLabel != null && (
            <CardTotal
              label={totalLabel}
              items={columns.map((c, i) => ({ label: c, value: money(totals[i] ?? 0) }))}
            />
          )}
        </ReportCards>
      )}
    </div>
  );
}
