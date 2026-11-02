import type { ReactNode } from "react";

/**
 * Rótulo → valor para las vistas apiladas del celular (`.report-cards`,
 * workspace.css) de Contabilidad: la tarjeta que reemplaza a cada fila de
 * tabla en pantallas de menos de 768px lleva los MISMOS rótulos que los
 * encabezados de la tabla.
 *
 * Sólo <span>, así vale adentro de un <button> o un <Link> (las tarjetas
 * clicables de activos, comprobantes y diferidos); por eso no se reutiliza
 * la <CardFacts> de los reportes, que es un <dl>.
 */
export function CardFact({
  label,
  value,
  strong,
  tone,
  className,
}: {
  label: string;
  value: ReactNode;
  strong?: boolean;
  tone?: "muted" | "ok" | "danger";
  className?: string;
}) {
  const toneCls =
    tone === "muted" ? " text-op-muted" : tone === "ok" ? " text-ok" : tone === "danger" ? " text-danger" : "";
  return (
    <span className={"block min-w-0" + (className ? " " + className : "")}>
      <span className="block font-mono text-[9px] uppercase tracking-wider text-op-muted">{label}</span>
      <span className={"block font-mono tabular-nums text-[13px]" + (strong ? " font-semibold" : "") + toneCls}>
        {value}
      </span>
    </span>
  );
}

/** Pastilla chica de estado/etiqueta (la misma que usan libros y plantillas). */
export const pillCls =
  "px-2 h-5 inline-flex items-center rounded-full text-[10px] font-medium whitespace-nowrap";
