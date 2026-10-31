"use client";

// Barras horizontales para comparar magnitudes entre categorías NOMINALES
// (productos, meseros, métodos de pago, canales): un solo color para todas
// las barras —el largo ya dice cuánto—, barra delgada con el extremo de dato
// redondeado y el valor escrito al lado (nunca adentro, así no se recorta).
// Cada fila es el blanco del puntero y, si trae `href`, un enlace de drill.
import type { FocusEvent, PointerEvent, ReactNode } from "react";
import { ChartLink } from "./ChartNav";
import { ChartTooltip, useChartTooltip, useElementWidth, type TooltipContent } from "./useChartTooltip";

export type BarItem = {
  key: string;
  label: string;
  value: number;
  /** Valor ya formateado (al final de la barra). */
  valueLabel: string;
  /** Línea secundaria bajo el nombre («12 % · 34 cuentas»). */
  sub?: string;
  /** Variación ya formateada y su tono (con flecha: nunca sólo color). */
  delta?: { text: string; tone: "good" | "bad" | "neutral" } | null;
  href?: string;
  tooltip?: TooltipContent;
  /** Marca la fila del filtro activo. */
  selected?: boolean;
};

export function BarList({
  items,
  ariaLabel,
  empty,
  max,
}: {
  items: BarItem[];
  ariaLabel: string;
  empty?: ReactNode;
  /** Máximo de la escala (por defecto, el mayor de la lista). */
  max?: number;
}) {
  const { ref, width } = useElementWidth<HTMLDivElement>();
  const tip = useChartTooltip(ref);
  const scale = max ?? Math.max(0, ...items.map((i) => i.value));
  return (
    <div className="mp-viz-chart" ref={ref}>
      {items.length === 0 && <div className="mp-viz-empty">{empty}</div>}
      <ul hidden={items.length === 0} className="mp-viz-bars" aria-label={ariaLabel}>
        {items.map((item) => {
          const pct = scale > 0 ? Math.max(0, item.value) / scale : 0;
          const body = (
            <>
              <span className="mp-viz-bar-text">
                <span className="mp-viz-bar-label">{item.label}</span>
                {item.sub && <span className="mp-viz-bar-sub">{item.sub}</span>}
              </span>
              <span className="mp-viz-bar-track" aria-hidden="true">
                <span className="mp-viz-bar" style={{ width: `${Math.max(pct > 0 ? 1.5 : 0, pct * 100)}%` }} />
              </span>
              <span className="mp-viz-bar-value">
                {item.valueLabel}
                {item.delta && (
                  <span className={`mp-viz-delta mp-viz-delta--${item.delta.tone}`}>{item.delta.text}</span>
                )}
              </span>
            </>
          );
          const handlers = item.tooltip
            ? {
                onPointerMove: (e: PointerEvent) => tip.show(e.clientX, e.clientY, item.tooltip!),
                onPointerLeave: () => tip.hide(),
                onFocus: (e: FocusEvent) => tip.showAt(e.currentTarget, item.tooltip!),
                onBlur: () => tip.hide(),
              }
            : {};
          return (
            <li key={item.key} data-selected={item.selected || undefined}>
              {item.href ? (
                <ChartLink href={item.href} className="mp-viz-bar-row" {...handlers}>
                  {body}
                </ChartLink>
              ) : (
                <div className="mp-viz-bar-row" {...handlers}>
                  {body}
                </div>
              )}
            </li>
          );
        })}
      </ul>
      <ChartTooltip state={tip.state} containerWidth={width} />
    </div>
  );
}
