"use client";

// Tooltip compartido por los gráficos: un solo globo posicionado dentro del
// contenedor del gráfico, que sigue al puntero o al foco del teclado. Los
// textos se pintan como texto React (nunca HTML), así un nombre de plato
// cargado por el comercio no puede inyectar marcado.
import { useCallback, useEffect, useRef, useState, type ReactNode, type RefObject } from "react";

export type TooltipRow = {
  /** Valor: lo fuerte del globo. */
  value: string;
  /** Rótulo secundario (serie o métrica). */
  label: string;
  /** Clave de color de la serie (línea corta), opcional. */
  swatch?: "accent" | "compare";
};

export type TooltipContent = { title: string; rows: TooltipRow[]; hint?: string };

/** `ref` = el contenedor posicionado del gráfico (el globo se ubica relativo a él). */
export function useChartTooltip(ref: RefObject<HTMLElement | null>) {
  const [state, setState] = useState<{ x: number; y: number; content: TooltipContent } | null>(null);
  const show = useCallback((clientX: number, clientY: number, content: TooltipContent) => {
    const box = ref.current?.getBoundingClientRect();
    if (!box) return;
    setState({ x: clientX - box.left, y: clientY - box.top, content });
  }, [ref]);
  /** Para el foco del teclado: el globo se ancla al elemento enfocado. */
  const showAt = useCallback((el: Element, content: TooltipContent) => {
    const box = ref.current?.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    if (!box) return;
    setState({ x: r.left + r.width / 2 - box.left, y: r.top - box.top, content });
  }, [ref]);
  const hide = useCallback(() => setState(null), []);
  return { state, show, showAt, hide };
}

export function ChartTooltip({
  state,
  containerWidth,
}: {
  state: { x: number; y: number; content: TooltipContent } | null;
  containerWidth: number;
}): ReactNode {
  const boxRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(180);
  useEffect(() => {
    if (boxRef.current) setWidth(boxRef.current.offsetWidth);
  }, [state]);
  if (!state) return null;
  // Se voltea al otro lado cerca del borde derecho para no salirse.
  const flip = state.x + 16 + width > containerWidth;
  const left = Math.max(4, flip ? state.x - 16 - width : state.x + 16);
  const top = Math.max(4, state.y - 12);
  return (
    <div ref={boxRef} className="mp-viz-tooltip" role="status" style={{ left, top }}>
      <p className="mp-viz-tooltip-title">{state.content.title}</p>
      {state.content.rows.map((row, i) => (
        <p key={i} className="mp-viz-tooltip-row">
          {row.swatch && <span className={`mp-viz-key mp-viz-key--${row.swatch}`} aria-hidden="true" />}
          <strong>{row.value}</strong>
          <span>{row.label}</span>
        </p>
      ))}
      {state.content.hint && <p className="mp-viz-tooltip-hint">{state.content.hint}</p>}
    </div>
  );
}

/** Ancho del contenedor (para que el SVG dibuje en píxeles reales y el texto no escale). */
export function useElementWidth<T extends HTMLElement>(fallback = 640) {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(fallback);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => setWidth(Math.max(240, Math.round(el.getBoundingClientRect().width)));
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return { ref, width };
}
