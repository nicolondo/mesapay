"use client";

import type { ReactNode } from "react";
import { cx } from "./ReportCards";

/**
 * Renglón DESPLEGABLE de un reporte (niveles 1 y 2 del despliegue de
 * impuestos; reutilizable en el estado de resultado y el balance).
 *
 * Accesibilidad: el rótulo es un `<button>` con `aria-expanded` y
 * `aria-controls` hacia el panel que abre (teclado: Tab + Enter/Espacio),
 * con área de toque de 44px. Las cifras van en un `<dl>` con sus rótulos:
 *
 *  · md+: una fila de grilla; las cifras se alinean con el encabezado de
 *    columnas del grupo (`columns`, la misma plantilla para todo el grupo)
 *    y los rótulos quedan sólo para lectores de pantalla;
 *  · celular: el rótulo arriba y las cifras en una mini-grilla rótulo →
 *    valor de dos columnas (la vista «tarjeta»), sin desplazamiento lateral.
 *
 * El panel (`children`) se pinta siempre que esté abierto; al imprimir,
 * sale lo que esté abierto (lo cerrado no carga sus auxiliares).
 */
export type DrillCell = { label: string; value: ReactNode; className?: string };

export function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className={cx(
        "no-print shrink-0 text-op-muted transition-transform duration-200 motion-reduce:transition-none",
        open && "rotate-90",
      )}
    >
      <path d="m9 6 6 6-6 6" />
    </svg>
  );
}

export function DrillRow({
  id,
  open,
  onToggle,
  label,
  sublabel,
  cells,
  trailing,
  columns,
  level,
  children,
  expandable = true,
}: {
  /** Id del renglón (el de la URL); el panel lleva `drill-panel-<id>`. */
  id: string;
  open: boolean;
  onToggle: (id: string) => void;
  label: ReactNode;
  sublabel?: ReactNode;
  cells: DrillCell[];
  /** Algo al final de la fila (un semáforo). */
  trailing?: ReactNode;
  /** Plantilla de columnas md+ (`md:grid-cols-[…]`), la misma del encabezado del grupo. */
  columns: string;
  level: 1 | 2;
  children?: ReactNode;
  /** false = renglón de sólo lectura (sin auxiliares). */
  expandable?: boolean;
}) {
  const panelId = `drill-panel-${id}`;
  const head = (
    <span className="flex min-w-0 items-start gap-2">
      {expandable ? <Chevron open={open} /> : <span className="no-print inline-block w-4 shrink-0" />}
      <span className="min-w-0">
        <span className={cx("block break-words", level === 1 ? "font-semibold" : "font-medium")}>{label}</span>
        {sublabel && <span className="block text-xs font-normal text-op-muted">{sublabel}</span>}
      </span>
    </span>
  );
  return (
    <div className={cx(level === 1 ? "bg-op-surface" : "", open && level === 1 && "bg-op-bg/40")}>
      <div
        className={cx(
          "grid min-w-0 gap-x-4 gap-y-2 px-3 md:items-center md:px-4",
          level === 1 ? "py-2.5" : "py-1.5 md:pl-10",
          columns,
        )}
      >
        {expandable ? (
          <button
            type="button"
            onClick={() => onToggle(id)}
            aria-expanded={open}
            aria-controls={panelId}
            className="-mx-1 flex min-h-11 min-w-0 cursor-pointer items-center rounded-lg px-1 text-left text-sm hover:text-op-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-op-accent"
          >
            {head}
          </button>
        ) : (
          <div className="flex min-h-11 min-w-0 items-center text-sm">{head}</div>
        )}
        <dl className="grid min-w-0 grid-cols-2 gap-x-3 gap-y-1.5 pl-6 md:contents">
          {cells.map((c, i) => (
            <div key={i} className={cx("min-w-0 md:text-right", c.className)}>
              <dt className="font-mono text-[9px] uppercase tracking-wider text-op-muted md:sr-only">{c.label}</dt>
              <dd className="font-mono tabular text-[13px] whitespace-nowrap md:text-sm">{c.value}</dd>
            </div>
          ))}
        </dl>
        {trailing && <div className="min-w-0 pl-6 md:pl-0 md:text-right">{trailing}</div>}
      </div>
      {expandable && open && (
        <div id={panelId} className="drill-panel min-w-0">
          {children}
        </div>
      )}
    </div>
  );
}

/** Encabezado de columnas de un grupo de renglones (sólo md+; en el celular cada cifra trae su rótulo). */
export function DrillHeader({
  first,
  cells,
  columns,
  trailing,
  indent = false,
}: {
  first: string;
  cells: string[];
  columns: string;
  trailing?: string;
  indent?: boolean;
}) {
  return (
    <div
      aria-hidden
      className={cx(
        "hidden gap-x-4 border-b border-op-border px-4 py-2 font-mono text-[9px] uppercase tracking-wider text-op-muted md:grid",
        indent && "md:pl-10",
        columns,
      )}
    >
      <span>{first}</span>
      {cells.map((c) => (
        <span key={c} className="text-right">
          {c}
        </span>
      ))}
      {trailing !== undefined && <span className="text-right">{trailing}</span>}
    </div>
  );
}
