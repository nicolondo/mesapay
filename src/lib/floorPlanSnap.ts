/**
 * Ayudas de alineación del editor del plano: guías inteligentes al
 * arrastrar (bordes y centros de otros objetos, igual separación),
 * cuadrícula opcional, y alinear / distribuir una selección.
 *
 * PURO y sin estado: recibe cajas (alineadas a los ejes, en unidades del
 * plano) y devuelve cuánto corregir y qué guías dibujar. El editor decide
 * si aplica el ajuste (el imán se puede apagar).
 */
import type { Box, Point } from "./floorPlan";

export type SnapGuide =
  /** Línea vertical en `x`, de y1 a y2. */
  | { kind: "v"; x: number; y1: number; y2: number }
  /** Línea horizontal en `y`, de x1 a x2. */
  | { kind: "h"; y: number; x1: number; x2: number }
  /** Separación igual: tramo sobre el eje, de `from` a `to`, a la altura `at`. */
  | { kind: "gap"; axis: "x" | "y"; from: number; to: number; at: number };

export type SnapOptions = {
  /** Distancia máxima (unidades) a la que el imán atrae. */
  threshold: number;
  /** Paso de la cuadrícula, o null si está apagada. */
  grid?: number | null;
};

type AxisHit = {
  delta: number;
  /** Para alinear: la coordenada donde va la línea. */
  line?: number;
  /** Para separación igual: los tramos que quedan iguales. */
  gaps?: { from: number; to: number }[];
};

const EPS = 1e-6;

/** Proyección de una caja sobre un eje: inicio, centro, fin y tamaño. */
function span(b: Box, axis: "x" | "y") {
  const start = axis === "x" ? b.x : b.y;
  const size = axis === "x" ? b.w : b.h;
  return { start, mid: start + size / 2, end: start + size, size };
}

function overlapsCross(a: Box, b: Box, axis: "x" | "y"): boolean {
  const cross = axis === "x" ? "y" : "x";
  const sa = span(a, cross);
  const sb = span(b, cross);
  return sa.start < sb.end - EPS && sb.start < sa.end - EPS;
}

function bestAxis(moving: Box, others: Box[], axis: "x" | "y", threshold: number): AxisHit | null {
  const m = span(moving, axis);
  let best: AxisHit | null = null;
  const consider = (hit: AxisHit) => {
    if (Math.abs(hit.delta) > threshold) return;
    if (!best || Math.abs(hit.delta) < Math.abs(best.delta) - EPS) best = hit;
  };

  // 1) Bordes y centros.
  for (const o of others) {
    const s = span(o, axis);
    for (const target of [s.start, s.mid, s.end]) {
      for (const own of [m.start, m.mid, m.end]) {
        consider({ delta: target - own, line: target });
      }
    }
  }

  // 2) Igual separación con los vecinos de la misma fila / columna.
  const mates = others
    .filter((o) => overlapsCross(moving, o, axis))
    .map((o) => span(o, axis))
    .sort((a, b) => a.start - b.start);
  const before = mates.filter((s) => s.end <= m.mid + EPS);
  const after = mates.filter((s) => s.start >= m.mid - EPS);
  const prev = before[before.length - 1];
  const prev2 = before[before.length - 2];
  const next = after[0];
  const next2 = after[1];
  if (prev && next && next.start - prev.end >= m.size) {
    // En el medio de dos.
    const gap = (next.start - prev.end - m.size) / 2;
    const start = prev.end + gap;
    consider({
      delta: start - m.start,
      gaps: [
        { from: prev.end, to: start },
        { from: start + m.size, to: next.start },
      ],
    });
  }
  if (prev && prev2 && prev.start - prev2.end > EPS) {
    // Continúa la fila hacia adelante con la misma separación.
    const gap = prev.start - prev2.end;
    const start = prev.end + gap;
    consider({
      delta: start - m.start,
      gaps: [
        { from: prev2.end, to: prev.start },
        { from: prev.end, to: start },
      ],
    });
  }
  if (next && next2 && next2.start - next.end > EPS) {
    // Continúa la fila hacia atrás.
    const gap = next2.start - next.end;
    const start = next.start - gap - m.size;
    consider({
      delta: start - m.start,
      gaps: [
        { from: start + m.size, to: next.start },
        { from: next.end, to: next2.start },
      ],
    });
  }
  return best;
}

function snapToGrid(v: number, grid: number): number {
  return Math.round(v / grid) * grid;
}

/**
 * Ajuste magnético al MOVER. `moving` es la caja en la posición que pide
 * el puntero; devuelve la corrección (dx, dy) y las guías a dibujar. Sin
 * nada cerca, y con la cuadrícula prendida, ajusta la esquina superior
 * izquierda a la cuadrícula.
 */
export function snapMove(
  moving: Box,
  others: Box[],
  opts: SnapOptions,
): { dx: number; dy: number; guides: SnapGuide[] } {
  const hx = bestAxis(moving, others, "x", opts.threshold);
  const hy = bestAxis(moving, others, "y", opts.threshold);
  let dx = hx ? hx.delta : 0;
  let dy = hy ? hy.delta : 0;
  if (!hx && opts.grid) dx = snapToGrid(moving.x, opts.grid) - moving.x;
  if (!hy && opts.grid) dy = snapToGrid(moving.y, opts.grid) - moving.y;

  const moved: Box = { ...moving, x: moving.x + dx, y: moving.y + dy };
  const guides: SnapGuide[] = [];
  const addLine = (axis: "x" | "y", at: number) => {
    // La línea abarca la caja movida y todo lo que comparte esa coordenada.
    const cross = axis === "x" ? "y" : "x";
    let lo = span(moved, cross).start;
    let hi = span(moved, cross).end;
    for (const o of others) {
      const s = span(o, axis);
      if ([s.start, s.mid, s.end].some((v) => Math.abs(v - at) < 1e-4)) {
        const c = span(o, cross);
        lo = Math.min(lo, c.start);
        hi = Math.max(hi, c.end);
      }
    }
    guides.push(
      axis === "x" ? { kind: "v", x: at, y1: lo, y2: hi } : { kind: "h", y: at, x1: lo, x2: hi },
    );
  };
  if (hx?.line !== undefined) addLine("x", hx.line);
  if (hy?.line !== undefined) addLine("y", hy.line);
  for (const g of hx?.gaps ?? []) {
    guides.push({ kind: "gap", axis: "x", from: g.from, to: g.to, at: moved.y + moved.h / 2 });
  }
  for (const g of hy?.gaps ?? []) {
    guides.push({ kind: "gap", axis: "y", from: g.from, to: g.to, at: moved.x + moved.w / 2 });
  }
  return { dx, dy, guides };
}

/**
 * Ajusta UNA coordenada (un borde al redimensionar, un vértice de zona) a
 * la más cercana de `targets`; si no hay ninguna a tiro y hay cuadrícula,
 * a la cuadrícula. `hit` = a qué coordenada se pegó (para dibujar la guía).
 */
export function snapCoord(
  v: number,
  targets: number[],
  opts: SnapOptions,
): { v: number; hit: number | null } {
  let best: number | null = null;
  for (const t of targets) {
    if (Math.abs(t - v) > opts.threshold) continue;
    if (best === null || Math.abs(t - v) < Math.abs(best - v)) best = t;
  }
  if (best !== null) return { v: best, hit: best };
  if (opts.grid) return { v: snapToGrid(v, opts.grid), hit: null };
  return { v, hit: null };
}

/** Coordenadas «imantables» de un conjunto de cajas sobre un eje. */
export function snapTargets(boxes: Box[], axis: "x" | "y"): number[] {
  const out: number[] = [];
  for (const b of boxes) {
    const s = span(b, axis);
    out.push(s.start, s.mid, s.end);
  }
  return out;
}

export type AlignMode = "left" | "centerX" | "right" | "top" | "centerY" | "bottom";

/** Cuánto mover cada caja para alinearlas (respecto a la caja del grupo). */
export function alignDeltas(boxes: Box[], mode: AlignMode): Point[] {
  if (boxes.length === 0) return [];
  const axis = mode === "left" || mode === "centerX" || mode === "right" ? "x" : "y";
  const spans = boxes.map((b) => span(b, axis));
  const lo = Math.min(...spans.map((s) => s.start));
  const hi = Math.max(...spans.map((s) => s.end));
  return spans.map((s) => {
    let d = 0;
    if (mode === "left" || mode === "top") d = lo - s.start;
    else if (mode === "right" || mode === "bottom") d = hi - s.end;
    else d = (lo + hi) / 2 - s.mid;
    return axis === "x" ? { x: d, y: 0 } : { x: 0, y: d };
  });
}

/**
 * Cuánto mover cada caja para que queden con la MISMA separación entre
 * sí. Las dos de los extremos no se mueven. Con menos de 3 no hay nada
 * que repartir.
 */
export function distributeDeltas(boxes: Box[], axis: "x" | "y"): Point[] {
  const zero = boxes.map(() => ({ x: 0, y: 0 }));
  if (boxes.length < 3) return zero;
  const order = boxes
    .map((b, i) => ({ i, s: span(b, axis) }))
    .sort((a, b) => a.s.mid - b.s.mid);
  const first = order[0].s;
  const last = order[order.length - 1].s;
  const total = order.reduce((sum, o) => sum + o.s.size, 0);
  const gap = (last.end - first.start - total) / (order.length - 1);
  let cursor = first.start;
  for (const o of order) {
    const d = cursor - o.s.start;
    zero[o.i] = axis === "x" ? { x: d, y: 0 } : { x: 0, y: d };
    cursor += o.s.size + gap;
  }
  return zero;
}
