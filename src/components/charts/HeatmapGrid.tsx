"use client";

// Mapa de calor (filas × columnas) con escala SECUENCIAL de un solo tono:
// más venta = más oscuro (en oscuro, más claro). Celdas separadas por un
// hueco del color de fondo, globo al pasar o enfocar, y clic para filtrar.
// En celular se TRASPONE (las horas pasan a ser filas) para que las celdas
// sigan siendo tocables a 375 px.
import type { FocusEvent, PointerEvent } from "react";
import { ChartLink } from "./ChartNav";
import { ChartTooltip, useChartTooltip, useElementWidth, type TooltipContent } from "./useChartTooltip";

export type HeatGridCell = {
  /** 0 = sin dato; 1..levels = escala. */
  level: number;
  tooltip: TooltipContent;
  /** Texto para lectores de pantalla («Viernes 20:00: $ 1.234.000»). */
  ariaLabel: string;
  href?: string;
};

export function HeatmapGrid({
  rowLabels,
  colLabels,
  cells,
  levels,
  scaleLabels,
  ariaLabel,
}: {
  rowLabels: string[];
  colLabels: string[];
  /** cells[fila][columna] */
  cells: HeatGridCell[][];
  levels: number;
  scaleLabels: { low: string; high: string; none: string };
  ariaLabel: string;
}) {
  const { ref, width } = useElementWidth<HTMLDivElement>();
  const tip = useChartTooltip(ref);
  const handlers = (cell: HeatGridCell) => ({
    onPointerMove: (e: PointerEvent) => tip.show(e.clientX, e.clientY, cell.tooltip),
    onPointerLeave: () => tip.hide(),
    onFocus: (e: FocusEvent) => tip.showAt(e.currentTarget, cell.tooltip),
    onBlur: () => tip.hide(),
  });
  const renderCell = (cell: HeatGridCell, key: string) =>
    cell.href ? (
      <ChartLink key={key} href={cell.href} className={`mp-viz-heat-cell mp-viz-heat-${cell.level}`} aria-label={cell.ariaLabel} {...handlers(cell)} />
    ) : (
      <span key={key} className={`mp-viz-heat-cell mp-viz-heat-${cell.level}`} role="img" aria-label={cell.ariaLabel} {...handlers(cell)} />
    );
  const grid = (transposed: boolean) => {
    const rows = transposed ? colLabels : rowLabels;
    const cols = transposed ? rowLabels : colLabels;
    return (
      <div
        className={`mp-viz-heat ${transposed ? "mp-viz-heat--narrow" : "mp-viz-heat--wide"}`}
        style={{ gridTemplateColumns: `auto repeat(${cols.length}, minmax(0, 1fr))` }}
        role="group"
        aria-label={ariaLabel}
      >
        <span aria-hidden="true" />
        {cols.map((c, j) => (
          <span key={`c${j}`} className="mp-viz-heat-col" aria-hidden="true">{c}</span>
        ))}
        {rows.map((r, i) => [
          <span key={`r${i}`} className="mp-viz-heat-row" aria-hidden="true">{r}</span>,
          ...cols.map((_, j) => renderCell(transposed ? cells[j]![i]! : cells[i]![j]!, `${i}-${j}`)),
        ])}
      </div>
    );
  };
  return (
    <div className="mp-viz-chart" ref={ref}>
      {grid(false)}
      {grid(true)}
      <div className="mp-viz-scale" aria-hidden="true">
        <span className="mp-viz-scale-item"><span className="mp-viz-heat-cell mp-viz-heat-0" />{scaleLabels.none}</span>
        <span className="mp-viz-scale-item">
          {scaleLabels.low}
          {Array.from({ length: levels }, (_, i) => (
            <span key={i} className={`mp-viz-heat-cell mp-viz-heat-${i + 1}`} />
          ))}
          {scaleLabels.high}
        </span>
      </div>
      <ChartTooltip state={tip.state} containerWidth={width} />
    </div>
  );
}
