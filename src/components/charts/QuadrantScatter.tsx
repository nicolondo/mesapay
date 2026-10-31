"use client";

// Dispersión con cuatro cuadrantes (ingeniería de menú: popularidad × margen).
// El cuadrante ya lo dice la POSICIÓN: todos los puntos van en un solo color
// (cuatro colores en una dispersión no se distinguen con daltonismo) y cada
// zona lleva su nombre escrito. Umbrales como líneas finas y sólidas; punto
// de 8 px con anillo del color de fondo y zona de toque de 24 px.
import { useMemo, type FocusEvent, type PointerEvent } from "react";
import { ChartLink } from "./ChartNav";
import { ChartTooltip, useChartTooltip, useElementWidth, type TooltipContent } from "./useChartTooltip";
import { formatCompact, niceTicks, type ValueFormat } from "./format";

export type ScatterPoint = {
  key: string;
  x: number;
  y: number;
  tooltip: TooltipContent;
  ariaLabel: string;
  href?: string;
};

const HEIGHT = 300;
const MARGIN = { top: 16, right: 16, bottom: 40, left: 64 };

export function QuadrantScatter({
  points,
  xThreshold,
  yThreshold,
  xFormat,
  yFormat,
  xLabel,
  yLabel,
  quadrants,
  ariaLabel,
}: {
  points: ScatterPoint[];
  xThreshold: number;
  yThreshold: number;
  xFormat: ValueFormat;
  yFormat: ValueFormat;
  xLabel: string;
  yLabel: string;
  /** Rótulos de las zonas: arriba-derecha, abajo-derecha, arriba-izquierda, abajo-izquierda. */
  quadrants: { topRight: string; bottomRight: string; topLeft: string; bottomLeft: string };
  ariaLabel: string;
}) {
  const { ref, width } = useElementWidth<HTMLDivElement>();
  const tip = useChartTooltip(ref);
  const geo = useMemo(() => {
    const innerW = Math.max(40, width - MARGIN.left - MARGIN.right);
    const innerH = HEIGHT - MARGIN.top - MARGIN.bottom;
    const xTicks = niceTicks(Math.max(xThreshold, ...points.map((p) => p.x)) * 1.05);
    const yMax = Math.max(yThreshold, ...points.map((p) => p.y)) * 1.05;
    const yMin = Math.min(0, ...points.map((p) => p.y));
    const yTicks = niceTicks(yMax);
    const xTop = xTicks.at(-1) || 1;
    const yTop = yTicks.at(-1) || 1;
    const x = (v: number) => MARGIN.left + (v / xTop) * innerW;
    const y = (v: number) => MARGIN.top + innerH - ((v - yMin) / (yTop - yMin)) * innerH;
    return { innerW, innerH, xTicks, yTicks, x, y, yMin };
  }, [points, width, xThreshold, yThreshold]);
  const tx = geo.x(xThreshold);
  const ty = geo.y(yThreshold);
  const right = MARGIN.left + geo.innerW;
  const bottom = MARGIN.top + geo.innerH;
  const handlers = (p: ScatterPoint) => ({
    onPointerMove: (e: PointerEvent) => tip.show(e.clientX, e.clientY, p.tooltip),
    onPointerLeave: () => tip.hide(),
    onFocus: (e: FocusEvent) => tip.showAt(e.currentTarget, p.tooltip),
    onBlur: () => tip.hide(),
  });
  return (
    <div className="mp-viz-chart" ref={ref}>
      <svg width={width} height={HEIGHT} role="group" aria-label={ariaLabel} className="mp-viz-svg">
        {geo.yTicks.map((t) => (
          <g key={`y${t}`}>
            <line x1={MARGIN.left} x2={right} y1={geo.y(t)} y2={geo.y(t)} className={t === 0 ? "mp-viz-axis" : "mp-viz-grid"} />
            <text x={MARGIN.left - 8} y={geo.y(t)} dy="0.32em" textAnchor="end" className="mp-viz-tick">{formatCompact(t, yFormat)}</text>
          </g>
        ))}
        {geo.xTicks.map((t) => (
          <text key={`x${t}`} x={geo.x(t)} y={bottom + 16} textAnchor="middle" className="mp-viz-tick">{formatCompact(t, xFormat)}</text>
        ))}
        <line x1={tx} x2={tx} y1={MARGIN.top} y2={bottom} className="mp-viz-threshold" />
        <line x1={MARGIN.left} x2={right} y1={ty} y2={ty} className="mp-viz-threshold" />
        <text x={right - 4} y={MARGIN.top + 12} textAnchor="end" className="mp-viz-quadrant">{quadrants.topRight}</text>
        <text x={right - 4} y={bottom - 6} textAnchor="end" className="mp-viz-quadrant">{quadrants.bottomRight}</text>
        <text x={MARGIN.left + 4} y={MARGIN.top + 12} className="mp-viz-quadrant">{quadrants.topLeft}</text>
        <text x={MARGIN.left + 4} y={bottom - 6} className="mp-viz-quadrant">{quadrants.bottomLeft}</text>
        <text x={MARGIN.left + geo.innerW / 2} y={HEIGHT - 4} textAnchor="middle" className="mp-viz-axis-label">{xLabel}</text>
        <text transform={`translate(12 ${MARGIN.top + geo.innerH / 2}) rotate(-90)`} textAnchor="middle" className="mp-viz-axis-label">{yLabel}</text>
        {points.map((p) => {
          const dot = (
            <g {...handlers(p)}>
              <circle cx={geo.x(p.x)} cy={geo.y(p.y)} r={12} fill="transparent" />
              <circle cx={geo.x(p.x)} cy={geo.y(p.y)} r={4} className="mp-viz-dot" />
            </g>
          );
          return p.href ? (
            <ChartLink key={p.key} href={p.href} aria-label={p.ariaLabel} className="mp-viz-point">{dot}</ChartLink>
          ) : (
            <g key={p.key} role="img" aria-label={p.ariaLabel} tabIndex={0} className="mp-viz-point">{dot}</g>
          );
        })}
      </svg>
      <ChartTooltip state={tip.state} containerWidth={width} />
    </div>
  );
}
