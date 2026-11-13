/**
 * Modelo del editor del plano: el «documento» que se edita (y se deshace)
 * y las operaciones puras sobre él — mover, redimensionar, girar, editar
 * vértices, sumar/recortar rectángulos a una zona. Sin React ni DOM, para
 * poder probarlo.
 */
import {
  FLOOR_MAX_ZONE_POINTS,
  FLOOR_WORLD,
  MARKER_SIZE_MAX,
  MARKER_SIZE_MIN,
  TABLE_SIZE_MAX,
  TABLE_SIZE_MIN,
  cellsToPolygons,
  convexOverlapDepth,
  normalizeRotation,
  pointInPolygon,
  polygonArea,
  polygonBounds,
  rectBounds,
  rectPoints,
  rotatePoint,
  round3,
  tableOutline,
  unionBox,
  type Box,
  type Marker,
  type Point,
  type TablePlacement,
  type TableShape,
  type Zone,
} from "@/lib/floorPlan";

export type DocTable = {
  shape: TableShape;
  capacity: number;
  label: string | null;
  placement: TablePlacement | null;
};

/** Lo que se edita, se deshace y se guarda. Inmutable: cada cambio crea otro. */
export type Doc = {
  tables: Record<string, DocTable>;
  zones: Zone[];
  markers: Marker[];
};

/** Identidad de una mesa (no cambia al editar el plano). */
export type TableMeta = { id: string; number: number };

export type SelType = "t" | "z" | "m";

export function keyOf(type: SelType, id: string): string {
  return `${type}:${id}`;
}
export function splitKey(key: string): { type: SelType; id: string } {
  return { type: key[0] as SelType, id: key.slice(2) };
}

export function newId(prefix: string): string {
  try {
    if (typeof crypto !== "undefined" && crypto.randomUUID) {
      return prefix + crypto.randomUUID().slice(0, 8);
    }
  } catch {
    /* sigue abajo */
  }
  return prefix + Math.random().toString(36).slice(2, 10);
}

const clamp = (n: number, min: number, max: number) => (n < min ? min : n > max ? max : n);

type Rectish = { x: number; y: number; w: number; h: number; rotation: number };

/** Caja de un elemento seleccionado; null si no existe o no está en el plano. */
export function boxOfKey(doc: Doc, key: string): Box | null {
  const { type, id } = splitKey(key);
  if (type === "t") {
    const p = doc.tables[id]?.placement;
    return p ? rectBounds(p) : null;
  }
  if (type === "m") {
    const m = doc.markers.find((x) => x.id === id);
    return m ? rectBounds(m) : null;
  }
  const z = doc.zones.find((x) => x.id === id);
  return z ? polygonBounds(z.points) : null;
}

export function boxOfKeys(doc: Doc, keys: string[]): Box | null {
  let box: Box | null = null;
  for (const k of keys) {
    const b = boxOfKey(doc, k);
    if (b) box = unionBox(box, b);
  }
  return box;
}

/** Quita de la selección lo que ya no existe en el documento. */
export function pruneSelection(doc: Doc, keys: string[]): string[] {
  return keys.filter((k) => boxOfKey(doc, k) !== null);
}

/**
 * Mueve varios elementos el mismo tanto. El grupo se frena en el borde del
 * mundo (se acota el desplazamiento, no cada elemento por separado, para
 * no deformar el grupo).
 */
export function translateKeys(doc: Doc, keys: string[], dx: number, dy: number): Doc {
  const box = boxOfKeys(doc, keys);
  if (!box || (dx === 0 && dy === 0)) return doc;
  const ddx = clamp(dx, -box.x, FLOOR_WORLD - (box.x + box.w));
  const ddy = clamp(dy, -box.y, FLOOR_WORLD - (box.y + box.h));
  if (ddx === 0 && ddy === 0) return doc;
  const set = new Set(keys);
  let tables = doc.tables;
  let zones = doc.zones;
  let markers = doc.markers;
  for (const k of keys) {
    const { type, id } = splitKey(k);
    if (type === "t") {
      const t = tables[id];
      if (!t?.placement) continue;
      if (tables === doc.tables) tables = { ...tables };
      tables[id] = {
        ...t,
        placement: { ...t.placement, x: round3(t.placement.x + ddx), y: round3(t.placement.y + ddy) },
      };
    }
  }
  if (keys.some((k) => k[0] === "m")) {
    markers = markers.map((m) =>
      set.has(keyOf("m", m.id)) ? { ...m, x: round3(m.x + ddx), y: round3(m.y + ddy) } : m,
    );
  }
  if (keys.some((k) => k[0] === "z")) {
    zones = zones.map((z) =>
      set.has(keyOf("z", z.id))
        ? { ...z, points: z.points.map((p) => ({ x: round3(p.x + ddx), y: round3(p.y + ddy) })) }
        : z,
    );
  }
  return { tables, zones, markers };
}

/** Gira mesas y elementos sobre su propio centro (las zonas no giran). */
export function rotateKeys(doc: Doc, keys: string[], deltaDeg: number): Doc {
  const set = new Set(keys);
  let tables = doc.tables;
  for (const k of keys) {
    const { type, id } = splitKey(k);
    if (type !== "t") continue;
    const t = tables[id];
    if (!t?.placement) continue;
    if (tables === doc.tables) tables = { ...tables };
    tables[id] = {
      ...t,
      placement: { ...t.placement, rotation: normalizeRotation(t.placement.rotation + deltaDeg) },
    };
  }
  const markers = keys.some((k) => k[0] === "m")
    ? doc.markers.map((m) =>
        set.has(keyOf("m", m.id)) ? { ...m, rotation: normalizeRotation(m.rotation + deltaDeg) } : m,
      )
    : doc.markers;
  return { tables, zones: doc.zones, markers };
}

/** Manija de redimensionar: qué lado(s) mueve. (1,1) = esquina inf-der. */
export type ResizeHandle = { sx: -1 | 0 | 1; sy: -1 | 0 | 1 };

/**
 * Redimensiona un rectángulo girado arrastrando una manija: el lado (o la
 * esquina) opuesto se queda quieto. `step` redondea el tamaño (5 cm, o el
 * paso de la cuadrícula).
 */
export function resizeRect(
  orig: Rectish,
  handle: ResizeHandle,
  pointer: Point,
  opts: { keepAspect?: boolean; step?: number | null; min: number; max: number },
): Rectish {
  const c = { x: orig.x, y: orig.y };
  const local = rotatePoint(pointer, c, -orig.rotation);
  const lx = local.x - c.x;
  const ly = local.y - c.y;
  const anchor = { x: (-handle.sx * orig.w) / 2, y: (-handle.sy * orig.h) / 2 };
  const snap = (v: number) => (opts.step ? Math.round(v / opts.step) * opts.step : v);
  let w = handle.sx ? clamp(snap((lx - anchor.x) * handle.sx), opts.min, opts.max) : orig.w;
  let h = handle.sy ? clamp(snap((ly - anchor.y) * handle.sy), opts.min, opts.max) : orig.h;
  if (opts.keepAspect && handle.sx && handle.sy && orig.w > 0 && orig.h > 0) {
    const scale = Math.max(w / orig.w, h / orig.h);
    const limited = Math.min(scale, opts.max / orig.w, opts.max / orig.h);
    w = Math.max(opts.min, orig.w * limited);
    h = Math.max(opts.min, orig.h * limited);
  }
  const centerLocal = { x: anchor.x + (handle.sx * w) / 2, y: anchor.y + (handle.sy * h) / 2 };
  const center = rotatePoint({ x: c.x + centerLocal.x, y: c.y + centerLocal.y }, c, orig.rotation);
  return {
    x: round3(clamp(center.x, 0, FLOOR_WORLD)),
    y: round3(clamp(center.y, 0, FLOOR_WORLD)),
    w: round3(w),
    h: round3(h),
    rotation: orig.rotation,
  };
}

export const TABLE_LIMITS = { min: TABLE_SIZE_MIN, max: TABLE_SIZE_MAX };
export const MARKER_LIMITS = { min: MARKER_SIZE_MIN, max: MARKER_SIZE_MAX };

/* ───────────────────────── zonas: vértices ────────────────────── */

const inWorld = (p: Point): Point => ({
  x: round3(clamp(p.x, 0, FLOOR_WORLD)),
  y: round3(clamp(p.y, 0, FLOOR_WORLD)),
});

/** ¿Todos los lados son horizontales o verticales? */
export function isRectilinear(points: Point[]): boolean {
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    if (Math.abs(a.x - b.x) > 1e-6 && Math.abs(a.y - b.y) > 1e-6) return false;
  }
  return points.length >= 4;
}

export function moveVertex(points: Point[], index: number, to: Point): Point[] {
  return points.map((p, i) => (i === index ? inWorld(to) : p));
}

/**
 * Mueve un lado entero (sus dos vértices) en la dirección de su normal:
 * así se agranda o achica un salón rectangular o en L sin torcer esquinas.
 */
export function moveEdge(points: Point[], edge: number, offset: number): Point[] {
  const n = points.length;
  const a = points[edge];
  const b = points[(edge + 1) % n];
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  if (len < 1e-9) return points;
  const nx = (b.y - a.y) / len;
  const ny = -(b.x - a.x) / len;
  return points.map((p, i) =>
    i === edge || i === (edge + 1) % n ? inWorld({ x: p.x + nx * offset, y: p.y + ny * offset }) : p,
  );
}

/** Normal unitaria del lado `edge` (misma convención que `moveEdge`). */
export function edgeNormal(points: Point[], edge: number): Point {
  const a = points[edge];
  const b = points[(edge + 1) % points.length];
  const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
  return { x: (b.y - a.y) / len, y: -(b.x - a.x) / len };
}

/** Agrega un vértice en la mitad del lado `edge`; devuelve su índice. */
export function insertVertex(
  points: Point[],
  edge: number,
): { points: Point[]; index: number } | null {
  if (points.length >= FLOOR_MAX_ZONE_POINTS) return null;
  const a = points[edge];
  const b = points[(edge + 1) % points.length];
  const mid = { x: round3((a.x + b.x) / 2), y: round3((a.y + b.y) / 2) };
  const next = [...points.slice(0, edge + 1), mid, ...points.slice(edge + 1)];
  return { points: next, index: edge + 1 };
}

/** Quita un vértice; null si quedarían menos de 3 o un área nula. */
export function removeVertex(points: Point[], index: number): Point[] | null {
  if (points.length <= 3) return null;
  const next = points.filter((_, i) => i !== index);
  return polygonArea(next) < 0.01 ? null : next;
}

/** Índice del lado más largo (donde conviene agregar un vértice). */
export function longestEdge(points: Point[]): number {
  let best = 0;
  let bestLen = -1;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len > bestLen) {
      bestLen = len;
      best = i;
    }
  }
  return best;
}

function uniqSorted(values: number[]): number[] {
  const sorted = [...values].sort((a, b) => a - b);
  const out: number[] = [];
  for (const v of sorted) {
    if (out.length === 0 || v - out[out.length - 1] > 1e-6) out.push(v);
  }
  return out;
}

/**
 * Suma (`add`) o recorta (`cut`) un rectángulo a una zona de lados rectos.
 * Es la forma fácil de dibujar un salón en L, en T o con un rincón: se
 * arranca con un rectángulo y se le agregan o quitan bloques.
 *
 * Se resuelve sobre la retícula que forman las coordenadas de la zona y
 * del rectángulo (exacto para lados rectos) y se vuelve a trazar el
 * contorno. Si el resultado queda en varios pedazos, se conserva el más
 * grande. null = no quedó nada, o quedó demasiado complejo.
 */
export function zoneRectBoolean(points: Point[], rect: Box, op: "add" | "cut"): Point[] | null {
  const xs = uniqSorted([...points.map((p) => p.x), rect.x, rect.x + rect.w]);
  const ys = uniqSorted([...points.map((p) => p.y), rect.y, rect.y + rect.h]);
  const cells: { x: number; y: number }[] = [];
  for (let j = 0; j < ys.length - 1; j++) {
    for (let i = 0; i < xs.length - 1; i++) {
      const cx = (xs[i] + xs[i + 1]) / 2;
      const cy = (ys[j] + ys[j + 1]) / 2;
      const inRect =
        cx > rect.x && cx < rect.x + rect.w && cy > rect.y && cy < rect.y + rect.h;
      const inZone = pointInPolygon({ x: cx, y: cy }, points);
      if (op === "add" ? inZone || inRect : inZone && !inRect) cells.push({ x: i, y: j });
    }
  }
  if (cells.length === 0) return null;
  let best: Point[] | null = null;
  let bestArea = 0;
  for (const poly of cellsToPolygons(cells)) {
    const mapped = poly.map((p) => ({ x: round3(xs[p.x]), y: round3(ys[p.y]) }));
    const area = polygonArea(mapped);
    if (area > bestArea) {
      best = mapped;
      bestArea = area;
    }
  }
  if (!best || best.length > FLOOR_MAX_ZONE_POINTS || bestArea < 0.01) return null;
  return best;
}

/** Rectángulo (normalizado) entre dos puntos. */
export function boxFromPoints(a: Point, b: Point): Box {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    w: Math.abs(a.x - b.x),
    h: Math.abs(a.y - b.y),
  };
}

export function boxesIntersect(a: Box, b: Box): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

export { rectPoints };

/* ─────────────────── ubicar mesas desde la bandeja ────────────── */

/**
 * Sitio libre para una mesa nueva cerca de `near`: prueba en espiral
 * hasta no pisar otra mesa. Si no hay hueco razonable, devuelve `near`
 * (quedará con aviso de solape, a la vista).
 */
export function freeSpotNear(
  doc: Doc,
  shape: TableShape,
  size: { w: number; h: number },
  near: Point,
): Point {
  const others = Object.values(doc.tables)
    .filter((t) => t.placement)
    .map((t) => tableOutline(t.shape, t.placement as TablePlacement));
  const fits = (p: Point) => {
    const outline = tableOutline(shape, { x: p.x, y: p.y, w: size.w, h: size.h, rotation: 0 });
    return others.every((o) => convexOverlapDepth(outline, o) <= 0.02);
  };
  const step = Math.max(size.w, size.h) + 0.4;
  const half = { w: size.w / 2, h: size.h / 2 };
  const ok = (p: Point) =>
    p.x - half.w >= 0 && p.y - half.h >= 0 && p.x + half.w <= FLOOR_WORLD && p.y + half.h <= FLOOR_WORLD;
  const start = {
    x: clamp(near.x, half.w, FLOOR_WORLD - half.w),
    y: clamp(near.y, half.h, FLOOR_WORLD - half.h),
  };
  if (fits(start)) return inWorld(start);
  for (let ring = 1; ring <= 12; ring++) {
    for (let dy = -ring; dy <= ring; dy++) {
      for (let dx = -ring; dx <= ring; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue;
        const p = { x: start.x + dx * step, y: start.y + dy * step };
        if (ok(p) && fits(p)) return inWorld(p);
      }
    }
  }
  return inWorld(start);
}

/**
 * Ubica en filas las mesas que faltan, debajo de lo que ya hay dibujado
 * (o desde la esquina si el plano está vacío). Para arrancar rápido un
 * plano: quedan ordenadas por número y después se arrastran a su sitio.
 */
export function arrangeInRows(
  items: { id: string; w: number; h: number }[],
  origin: Point,
  maxRowWidth: number,
  gap = 0.6,
): Record<string, Point> {
  const out: Record<string, Point> = {};
  let x = origin.x;
  let y = origin.y;
  let rowH = 0;
  for (const it of items) {
    if (x > origin.x && x + it.w > origin.x + maxRowWidth) {
      x = origin.x;
      y += rowH + gap;
      rowH = 0;
    }
    out[it.id] = inWorld({ x: x + it.w / 2, y: y + it.h / 2 });
    x += it.w + gap;
    rowH = Math.max(rowH, it.h);
  }
  return out;
}
