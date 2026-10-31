"use client";

// Línea de tendencia con la serie de comparación superpuesta (SVG propio).
//
// Forma: ÉNFASIS — la serie actual en el color de acento (línea de 2 px y un
// lavado al 10 %), la comparación en gris de contexto. Un solo eje Y, desde
// cero. Cruz que encuentra la X más cercana al puntero, globo con las dos
// series, y clic (o Enter) para entrar al punto. Con teclado: flechas.
import { useMemo, useState, type KeyboardEvent, type PointerEvent } from "react";
import { useChartNav } from "./ChartNav";
import { ChartTooltip, useChartTooltip, useElementWidth, type TooltipRow } from "./useChartTooltip";
import { formatCompact, formatValue, niceTicks, type ValueFormat } from "./format";

export type LinePoint = {
  key: string;
  /** Rótulo largo (globo y lectores de pantalla). */
  label: string;
  /** Rótulo corto del eje X. */
  shortLabel: string;
  value: number;
  compare: number | null;
  /** Rótulo del punto de comparación alineado. */
  compareLabel: string | null;
  /** Filas extra del globo (cuentas, ticket…). */
  extra?: TooltipRow[];
  /** Adónde lleva el clic (drill-down). */
  href?: string;
};

const HEIGHT = 220;
const MARGIN = { top: 16, right: 16, bottom: 28, left: 64 };

export function LineChart({
  points,
  format,
  seriesLabel,
  compareSeriesLabel,
  ariaLabel,
  hint,
}: {
  points: LinePoint[];
  format: ValueFormat;
  seriesLabel: string;
  /** null = sin comparación: no se dibuja la segunda serie ni la leyenda. */
  compareSeriesLabel: string | null;
  ariaLabel: string;
  /** Texto del globo que explica el clic («Clic para ver el día»). */
  hint?: string;
}) {
  const { ref, width } = useElementWidth<HTMLDivElement>();
  const tip = useChartTooltip(ref);
  const { navigate } = useChartNav();
  const [active, setActive] = useState<number | null>(null);
  const hasCompare = compareSeriesLabel !== null && points.some((p) => p.compare !== null);

  const geo = useMemo(() => {
    const innerW = Math.max(40, width - MARGIN.left - MARGIN.right);
    const innerH = HEIGHT - MARGIN.top - MARGIN.bottom;
    const max = Math.max(0, ...points.map((p) => p.value), ...(hasCompare ? points.map((p) => p.compare ?? 0) : []));
    const ticks = niceTicks(max);
    const top = ticks[ticks.length - 1] || 1;
    const x = (i: number) => MARGIN.left + (points.length <= 1 ? innerW / 2 : (i * innerW) / (points.length - 1));
    const y = (v: number) => MARGIN.top + innerH - (v / top) * innerH;
    const path = (vals: (number | null)[]) => {
      let d = "";
      vals.forEach((v, i) => {
        if (v === null) return;
        d += `${d === "" || vals[i - 1] === null ? "M" : "L"}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
      });
      return d;
    };
    const line = path(points.map((p) => p.value));
    const area = points.length > 1
      ? `${line}L${x(points.length - 1).toFixed(1)},${y(0).toFixed(1)}L${x(0).toFixed(1)},${y(0).toFixed(1)}Z`
      : "";
    const compareLine = hasCompare ? path(points.map((p) => p.compare)) : "";
    // Rótulos del eje X sin choques: uno cada `step`.
    const maxLabels = Math.max(2, Math.floor(innerW / 72));
    const step = Math.max(1, Math.ceil(points.length / maxLabels));
    return { innerW, innerH, ticks, x, y, line, area, compareLine, step };
  }, [points, width, hasCompare]);

  const contentFor = (i: number) => {
    const p = points[i]!;
    const rows: TooltipRow[] = [{ value: formatValue(p.value, format), label: seriesLabel, swatch: "accent" }];
    if (hasCompare && p.compare !== null) {
      rows.push({ value: formatValue(p.compare, format), label: p.compareLabel ?? compareSeriesLabel ?? "", swatch: "compare" });
    }
    return { title: p.label, rows: [...rows, ...(p.extra ?? [])], hint: p.href ? hint : undefined };
  };

  const indexAt = (clientX: number) => {
    const box = ref.current?.getBoundingClientRect();
    if (!box || points.length === 0) return null;
    const rel = clientX - box.left - MARGIN.left;
    if (points.length === 1) return 0;
    return Math.min(points.length - 1, Math.max(0, Math.round((rel / geo.innerW) * (points.length - 1))));
  };

  const onMove = (e: PointerEvent<SVGRectElement>) => {
    const i = indexAt(e.clientX);
    if (i === null) return;
    setActive(i);
    tip.show(e.clientX, e.clientY, contentFor(i));
  };

  const onKey = (e: KeyboardEvent<SVGSVGElement>) => {
    if (points.length === 0) return;
    const cur = active ?? points.length - 1;
    let next = cur;
    if (e.key === "ArrowRight") next = Math.min(points.length - 1, cur + 1);
    else if (e.key === "ArrowLeft") next = Math.max(0, cur - 1);
    else if (e.key === "Enter" && points[cur]?.href) {
      navigate(points[cur]!.href!);
      return;
    } else return;
    e.preventDefault();
    setActive(next);
    const box = ref.current?.getBoundingClientRect();
    if (box) tip.show(box.left + geo.x(next), box.top + geo.y(points[next]!.value), contentFor(next));
  };

  const last = points.length - 1;
  return (
    <div className="mp-viz-chart" ref={ref}>
      {hasCompare && (
        <div className="mp-viz-legend" aria-hidden="true">
          <span><span className="mp-viz-key mp-viz-key--accent" />{seriesLabel}</span>
          <span><span className="mp-viz-key mp-viz-key--compare" />{compareSeriesLabel}</span>
        </div>
      )}
      <svg
        width={width}
        height={HEIGHT}
        role="img"
        aria-label={ariaLabel}
        tabIndex={0}
        onKeyDown={onKey}
        onBlur={() => {
          setActive(null);
          tip.hide();
        }}
        className="mp-viz-svg"
      >
        {geo.ticks.map((t) => (
          <g key={t}>
            <line x1={MARGIN.left} x2={MARGIN.left + geo.innerW} y1={geo.y(t)} y2={geo.y(t)} className={t === 0 ? "mp-viz-axis" : "mp-viz-grid"} />
            <text x={MARGIN.left - 8} y={geo.y(t)} dy="0.32em" textAnchor="end" className="mp-viz-tick">
              {formatCompact(t, format)}
            </text>
          </g>
        ))}
        {points.map((p, i) =>
          // El último rótulo siempre (alineado a la derecha); los regulares,
          // salvo que no quepan antes de él.
          (i % geo.step === 0 && geo.x(last) - geo.x(i) >= 96) || i === last ? (
            <text key={p.key} x={geo.x(i)} y={HEIGHT - 8} textAnchor={i === 0 && points.length > 1 ? "start" : i === last && points.length > 1 ? "end" : "middle"} className="mp-viz-tick">
              {p.shortLabel}
            </text>
          ) : null,
        )}
        {geo.area && <path d={geo.area} className="mp-viz-area" />}
        {geo.compareLine && <path d={geo.compareLine} className="mp-viz-line mp-viz-line--compare" />}
        <path d={geo.line} className="mp-viz-line mp-viz-line--accent" />
        {points.length === 1 && <circle cx={geo.x(0)} cy={geo.y(points[0]!.value)} r={4} className="mp-viz-dot" />}
        {last >= 0 && points.length > 1 && <circle cx={geo.x(last)} cy={geo.y(points[last]!.value)} r={4} className="mp-viz-dot" />}
        {active !== null && points[active] && (
          <g aria-hidden="true">
            <line x1={geo.x(active)} x2={geo.x(active)} y1={MARGIN.top} y2={MARGIN.top + geo.innerH} className="mp-viz-crosshair" />
            {hasCompare && points[active]!.compare !== null && (
              <circle cx={geo.x(active)} cy={geo.y(points[active]!.compare!)} r={4} className="mp-viz-dot mp-viz-dot--compare" />
            )}
            <circle cx={geo.x(active)} cy={geo.y(points[active]!.value)} r={4} className="mp-viz-dot" />
          </g>
        )}
        <rect
          x={MARGIN.left - 8}
          y={MARGIN.top}
          width={geo.innerW + 16}
          height={geo.innerH}
          fill="transparent"
          style={{ cursor: active !== null && points[active]?.href ? "pointer" : "crosshair" }}
          onPointerMove={onMove}
          onPointerLeave={() => {
            setActive(null);
            tip.hide();
          }}
          onClick={(e) => {
            const i = indexAt(e.clientX);
            const href = i === null ? undefined : points[i]?.href;
            if (href) navigate(href);
          }}
        />
      </svg>
      <ChartTooltip state={tip.state} containerWidth={width} />
    </div>
  );
}
