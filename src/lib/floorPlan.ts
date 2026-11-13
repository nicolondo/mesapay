/**
 * Plano del salón, formato LIBRE (v2).
 *
 * El plano dejó de ser una grilla de celdas: las mesas tienen posición
 * continua, tamaño y rotación; las zonas son polígonos; los elementos
 * (entrada, baños, barra, paredes…) también van libres.
 *
 * Unidades: «unidades del plano». 1 unidad ≈ 1 metro ≈ 1 celda del plano
 * viejo, así un plano antiguo se convierte sin escalar nada. El mundo va
 * de 0 a FLOOR_WORLD en ambos ejes; lo que se dibuja se encuadra solo al
 * contenido (no hay «lienzo» que el dueño tenga que agrandar).
 *
 * COMPATIBILIDAD (deploy blue/green + rollback). Conviven dos formatos:
 *
 *   v1 (celdas)  Restaurant.floorPlan = { cols, rows, zones[{cells}], markers[{x,y}] }
 *                Table.floorPlanX / floorPlanY = celda (Int)
 *   v2 (libre)   Restaurant.floorPlan = { version: 2, v2: { zones, markers }, …proyección v1 }
 *                Table.floorX / floorY / floorW / floorH / floorRotation (Float)
 *
 * Regla única: el blob decide. Si trae `version: 2` manda lo libre (v2 +
 * columnas Float); si no, manda lo viejo y se CONVIERTE AL VUELO
 * (`resolveFloor`). El código viejo, al guardar, escribe el blob sin
 * `version`, así que un guardado hecho durante un rollback gana solo, sin
 * marcas de tiempo ni huellas. Y al revés: cada guardado nuevo escribe
 * además una PROYECCIÓN v1 (`projectToLegacy`) en las claves y columnas
 * de siempre, para que la versión vieja siga leyendo algo coherente.
 *
 * IMPORTANTE: este módulo es PURO (no importa db ni nada de servidor) —
 * lo usan rutas API, Server Components y Client Components (editor,
 * selector de mesa del comensal, mapa del Salón).
 */

export const FLOOR_PLAN_VERSION = 2;

/** Lado del mundo, en unidades. Todo queda entre 0 y este valor. */
export const FLOOR_WORLD = 60;
export const FLOOR_MAX_ZONES = 60;
export const FLOOR_MAX_MARKERS = 150;
export const FLOOR_MAX_ZONE_POINTS = 64;
export const FLOOR_MAX_TABLES = 500;
export const FLOOR_LABEL_MAX = 40;
export const TABLE_SIZE_MIN = 0.3;
export const TABLE_SIZE_MAX = 8;
export const MARKER_SIZE_MIN = 0.1;
export const MARKER_SIZE_MAX = 30;

export type Point = { x: number; y: number };
/** Caja alineada a los ejes; x/y = esquina superior izquierda. */
export type Box = { x: number; y: number; w: number; h: number };

export type TableShape = "square" | "round" | "bar";

export type ZoneKind =
  | "interior"
  | "exterior"
  | "terraza"
  | "jardin"
  | "barra"
  | "cocina"
  | "banos"
  | "custom";

export type MarkerKind =
  | "entrada"
  | "banos"
  | "barra"
  | "escaleras"
  | "cocina"
  | "pared"
  | "columna"
  | "planta";

/**
 * Área del salón, dibujada detrás de las mesas. Polígono simple: un
 * rectángulo son 4 puntos; un salón en L, 6.
 */
export type Zone = {
  id: string;
  kind: ZoneKind;
  /** "" = usa el nombre del tipo (traducido). En `custom`, "" = sin rótulo. */
  label: string;
  points: Point[];
};

/** Elemento del local: x/y = CENTRO; rotación en grados, sentido horario. */
export type Marker = {
  id: string;
  kind: MarkerKind;
  /** null = nombre del tipo (traducido). */
  label: string | null;
  x: number;
  y: number;
  w: number;
  h: number;
  rotation: number;
};

/** Dónde está una mesa: x/y = CENTRO; rotación en grados, sentido horario. */
export type TablePlacement = {
  x: number;
  y: number;
  w: number;
  h: number;
  rotation: number;
};

export type FloorScene = { zones: Zone[]; markers: Marker[] };

export const EMPTY_SCENE: FloorScene = { zones: [], markers: [] };

/**
 * Paleta de zonas. Funciona sobre el fondo claro del comensal y sobre el
 * del panel (claro u oscuro): relleno suave, borde y color del rótulo.
 * Los NOMBRES no viven acá: van por i18n (`floorPlan.zoneKind.*`).
 */
export const ZONE_KINDS: Record<
  ZoneKind,
  { fill: string; stroke: string; text: string }
> = {
  interior: {
    fill: "rgba(138,127,114,0.13)",
    stroke: "rgba(138,127,114,0.55)",
    text: "#6b5e52",
  },
  exterior: {
    fill: "rgba(74,144,184,0.13)",
    stroke: "rgba(74,144,184,0.55)",
    text: "#33688a",
  },
  terraza: {
    fill: "rgba(201,138,46,0.15)",
    stroke: "rgba(201,138,46,0.55)",
    text: "#8f6828",
  },
  jardin: {
    fill: "rgba(46,107,76,0.15)",
    stroke: "rgba(46,107,76,0.55)",
    text: "#1e5339",
  },
  barra: {
    fill: "rgba(125,79,156,0.15)",
    stroke: "rgba(125,79,156,0.55)",
    text: "#5d3a78",
  },
  cocina: {
    fill: "rgba(192,73,46,0.13)",
    stroke: "rgba(192,73,46,0.55)",
    text: "#8f3420",
  },
  banos: {
    fill: "rgba(47,156,147,0.13)",
    stroke: "rgba(47,156,147,0.55)",
    text: "#246b65",
  },
  custom: {
    fill: "rgba(107,114,128,0.13)",
    stroke: "rgba(107,114,128,0.55)",
    text: "#4b5563",
  },
};

export const ZONE_KIND_LIST: ZoneKind[] = [
  "interior",
  "exterior",
  "terraza",
  "jardin",
  "barra",
  "cocina",
  "banos",
  "custom",
];

/**
 * Elementos del local. `legacy` = existía en el plano viejo (entra en la
 * proyección v1). `decor` = sin ícono ni rótulo: se dibuja como lo que es
 * (una pared, una columna). Tamaños por defecto en unidades.
 */
export const MARKER_KINDS: Record<
  MarkerKind,
  { w: number; h: number; legacy: boolean; decor: boolean }
> = {
  entrada: { w: 1, h: 0.8, legacy: true, decor: false },
  banos: { w: 0.9, h: 0.9, legacy: true, decor: false },
  barra: { w: 0.9, h: 0.9, legacy: true, decor: false },
  escaleras: { w: 0.9, h: 0.9, legacy: true, decor: false },
  cocina: { w: 0.9, h: 0.9, legacy: true, decor: false },
  pared: { w: 3, h: 0.14, legacy: false, decor: true },
  columna: { w: 0.4, h: 0.4, legacy: false, decor: true },
  planta: { w: 0.6, h: 0.6, legacy: false, decor: true },
};

export const MARKER_KIND_LIST: MarkerKind[] = [
  "entrada",
  "banos",
  "barra",
  "escaleras",
  "cocina",
  "pared",
  "columna",
  "planta",
];

/* ────────────────────────── utilidades ────────────────────────── */

function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}
function isZoneKind(s: unknown): s is ZoneKind {
  return typeof s === "string" && Object.prototype.hasOwnProperty.call(ZONE_KINDS, s);
}
function isMarkerKind(s: unknown): s is MarkerKind {
  return typeof s === "string" && Object.prototype.hasOwnProperty.call(MARKER_KINDS, s);
}
function finite(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n);
}
function clamp(n: number, min: number, max: number): number {
  return n < min ? min : n > max ? max : n;
}
/** 3 decimales: milímetros. Evita 0.30000000000000004 en la BD. */
export function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
/** Grados a [0, 360), con 1 decimal. */
export function normalizeRotation(deg: number): number {
  if (!Number.isFinite(deg)) return 0;
  const r = ((deg % 360) + 360) % 360;
  const rounded = Math.round(r * 10) / 10;
  return rounded >= 360 ? 0 : rounded;
}
function cleanLabel(v: unknown): string {
  return typeof v === "string" ? v.trim().slice(0, FLOOR_LABEL_MAX) : "";
}
function cleanId(v: unknown, fallback: string, used: Set<string>): string {
  let id = typeof v === "string" && v.length > 0 && v.length <= 40 ? v : fallback;
  let n = 2;
  const base = id;
  while (used.has(id)) id = `${base}-${n++}`.slice(-40);
  used.add(id);
  return id;
}

/* ───────────────────────── geometría pura ─────────────────────── */

/** Área con signo (positiva = horario con «y» hacia abajo). */
export function polygonSignedArea(points: Point[]): number {
  let a = 0;
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const q = points[(i + 1) % points.length];
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}
export function polygonArea(points: Point[]): number {
  return Math.abs(polygonSignedArea(points));
}

export function polygonBounds(points: Point[]): Box {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  if (!Number.isFinite(minX)) return { x: 0, y: 0, w: 0, h: 0 };
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/** Centroide por área; si el polígono es degenerado, promedio de vértices. */
export function polygonCentroid(points: Point[]): Point {
  const a = polygonSignedArea(points);
  if (Math.abs(a) < 1e-9) {
    const n = points.length || 1;
    return {
      x: points.reduce((s, p) => s + p.x, 0) / n,
      y: points.reduce((s, p) => s + p.y, 0) / n,
    };
  }
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const q = points[(i + 1) % points.length];
    const f = p.x * q.y - q.x * p.y;
    cx += (p.x + q.x) * f;
    cy += (p.y + q.y) * f;
  }
  return { x: cx / (6 * a), y: cy / (6 * a) };
}

/** Punto dentro de un polígono simple (ray casting, regla par-impar). */
export function pointInPolygon(pt: Point, points: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const a = points[i];
    const b = points[j];
    const crosses =
      a.y > pt.y !== b.y > pt.y &&
      pt.x < ((b.x - a.x) * (pt.y - a.y)) / (b.y - a.y) + a.x;
    if (crosses) inside = !inside;
  }
  return inside;
}

/**
 * Zona en la que cae un punto. Si varias lo contienen (una barra dibujada
 * dentro del interior), gana la más chica: la más específica.
 */
export function zoneAtPoint(zones: Zone[], pt: Point): Zone | null {
  let best: Zone | null = null;
  let bestArea = Infinity;
  for (const z of zones) {
    if (!pointInPolygon(pt, z.points)) continue;
    const area = polygonArea(z.points);
    if (area < bestArea) {
      best = z;
      bestArea = area;
    }
  }
  return best;
}

/** Zona de una mesa: la del CENTRO de la mesa. */
export function zoneOfPlacement(zones: Zone[], p: TablePlacement): Zone | null {
  return zoneAtPoint(zones, { x: p.x, y: p.y });
}

/** ¿El polígono es un rectángulo alineado a los ejes? (4 puntos). */
export function isAxisRect(points: Point[]): boolean {
  if (points.length !== 4) return false;
  const b = polygonBounds(points);
  const eps = 1e-6;
  let corners = 0;
  for (const p of points) {
    const onX = Math.abs(p.x - b.x) < eps || Math.abs(p.x - (b.x + b.w)) < eps;
    const onY = Math.abs(p.y - b.y) < eps || Math.abs(p.y - (b.y + b.h)) < eps;
    if (onX && onY) corners++;
  }
  return corners === 4 && polygonArea(points) > (b.w * b.h) - 1e-6;
}

export function rectPoints(b: Box): Point[] {
  return [
    { x: b.x, y: b.y },
    { x: b.x + b.w, y: b.y },
    { x: b.x + b.w, y: b.y + b.h },
    { x: b.x, y: b.y + b.h },
  ];
}

/** Gira `pt` alrededor de `c` (grados, horario con «y» hacia abajo). */
export function rotatePoint(pt: Point, c: Point, deg: number): Point {
  if (!deg) return pt;
  const r = (deg * Math.PI) / 180;
  const cos = Math.cos(r);
  const sin = Math.sin(r);
  const dx = pt.x - c.x;
  const dy = pt.y - c.y;
  return { x: c.x + dx * cos - dy * sin, y: c.y + dx * sin + dy * cos };
}

type Rectish = { x: number; y: number; w: number; h: number; rotation: number };

/** Las 4 esquinas de un rectángulo girado (sup-izq, sup-der, inf-der, inf-izq). */
export function rectCorners(p: Rectish): Point[] {
  const c = { x: p.x, y: p.y };
  const hw = p.w / 2;
  const hh = p.h / 2;
  return [
    rotatePoint({ x: p.x - hw, y: p.y - hh }, c, p.rotation),
    rotatePoint({ x: p.x + hw, y: p.y - hh }, c, p.rotation),
    rotatePoint({ x: p.x + hw, y: p.y + hh }, c, p.rotation),
    rotatePoint({ x: p.x - hw, y: p.y + hh }, c, p.rotation),
  ];
}

/** Caja alineada a los ejes que envuelve un rectángulo girado. */
export function rectBounds(p: Rectish): Box {
  return polygonBounds(rectCorners(p));
}

/** Contorno convexo de una mesa: rectángulo, o polígono de 16 lados si es redonda. */
export function tableOutline(shape: TableShape, p: TablePlacement): Point[] {
  if (shape !== "round") return rectCorners(p);
  const c = { x: p.x, y: p.y };
  const out: Point[] = [];
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * Math.PI * 2;
    out.push(
      rotatePoint(
        { x: p.x + (Math.cos(a) * p.w) / 2, y: p.y + (Math.sin(a) * p.h) / 2 },
        c,
        p.rotation,
      ),
    );
  }
  return out;
}

/**
 * Cuánto se meten uno en otro dos polígonos CONVEXOS (teorema del eje
 * separador). 0 = no se tocan; > 0 = profundidad mínima del solape.
 */
export function convexOverlapDepth(a: Point[], b: Point[]): number {
  let minDepth = Infinity;
  for (const poly of [a, b]) {
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i];
      const q = poly[(i + 1) % poly.length];
      let nx = q.y - p.y;
      let ny = p.x - q.x;
      const len = Math.hypot(nx, ny);
      if (len < 1e-9) continue;
      nx /= len;
      ny /= len;
      let aMin = Infinity;
      let aMax = -Infinity;
      for (const v of a) {
        const d = v.x * nx + v.y * ny;
        if (d < aMin) aMin = d;
        if (d > aMax) aMax = d;
      }
      let bMin = Infinity;
      let bMax = -Infinity;
      for (const v of b) {
        const d = v.x * nx + v.y * ny;
        if (d < bMin) bMin = d;
        if (d > bMax) bMax = d;
      }
      const depth = Math.min(aMax, bMax) - Math.max(aMin, bMin);
      if (depth <= 0) return 0;
      if (depth < minDepth) minDepth = depth;
    }
  }
  return Number.isFinite(minDepth) ? minDepth : 0;
}

/** Solape mínimo para avisar: mesas que apenas se rozan no cuentan. */
export const OVERLAP_TOLERANCE = 0.04;

/**
 * Ids de las mesas que se pisan con otra. Es un AVISO visual: no bloquea
 * (dos mesas juntas para un grupo grande son legítimas), pero dos mesas
 * exactamente encimadas no pueden pasar inadvertidas.
 */
export function findOverlaps(
  tables: { id: string; shape: TableShape; placement: TablePlacement }[],
): Set<string> {
  const out = new Set<string>();
  const prepared = tables.map((t) => ({
    id: t.id,
    box: rectBounds(t.placement),
    outline: tableOutline(t.shape, t.placement),
  }));
  for (let i = 0; i < prepared.length; i++) {
    const a = prepared[i];
    for (let j = i + 1; j < prepared.length; j++) {
      const b = prepared[j];
      if (
        a.box.x + a.box.w <= b.box.x ||
        b.box.x + b.box.w <= a.box.x ||
        a.box.y + a.box.h <= b.box.y ||
        b.box.y + b.box.h <= a.box.y
      ) {
        continue;
      }
      if (convexOverlapDepth(a.outline, b.outline) > OVERLAP_TOLERANCE) {
        out.add(a.id);
        out.add(b.id);
      }
    }
  }
  return out;
}

export function unionBox(a: Box | null, b: Box): Box {
  if (!a) return b;
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return {
    x,
    y,
    w: Math.max(a.x + a.w, b.x + b.w) - x,
    h: Math.max(a.y + a.h, b.y + b.h) - y,
  };
}

/** Caja que envuelve todo lo dibujado; null si el plano está vacío. */
export function sceneBounds(
  scene: FloorScene,
  placements: TablePlacement[],
): Box | null {
  let box: Box | null = null;
  for (const z of scene.zones) box = unionBox(box, polygonBounds(z.points));
  for (const m of scene.markers) box = unionBox(box, rectBounds(m));
  for (const p of placements) box = unionBox(box, rectBounds(p));
  return box;
}

/* ─────────────────── tamaños y sillas por defecto ─────────────── */

/** Ancho que ocupa un puesto a lo largo del borde de una mesa. */
export const SEAT_PITCH = 0.55;

/**
 * Tamaño inicial razonable de una mesa según forma y capacidad (unidades
 * ≈ metros). El dueño lo ajusta después; esto solo evita arrancar con un
 * cuadrado genérico para una mesa de 10.
 */
export function defaultTableSize(
  shape: TableShape,
  capacity: number,
): { w: number; h: number } {
  const cap = clamp(Math.round(Number.isFinite(capacity) ? capacity : 4), 1, 40);
  if (shape === "round") {
    const d =
      cap <= 2 ? 0.7 : cap <= 4 ? 0.95 : cap <= 6 ? 1.25 : cap <= 8 ? 1.55 : cap <= 10 ? 1.85 : 2.1;
    return { w: d, h: d };
  }
  if (shape === "bar") {
    return { w: round3(clamp(cap * SEAT_PITCH + 0.1, 0.7, TABLE_SIZE_MAX)), h: 0.45 };
  }
  if (cap <= 2) return { w: 0.7, h: 0.7 };
  if (cap <= 4) return { w: 0.9, h: 0.9 };
  // 2 puestos en las cabeceras, el resto repartido en los dos lados largos.
  const perSide = Math.ceil((cap - 2) / 2);
  return { w: round3(clamp(perSide * SEAT_PITCH + 0.4, 1.2, TABLE_SIZE_MAX)), h: 0.9 };
}

/** Una silla en el marco LOCAL de la mesa (origen = centro, sin girar). */
export type Seat = { x: number; y: number; angle: number };

/**
 * Sillas alrededor de una mesa, en coordenadas locales. Son un dibujo de
 * referencia: se pintan las que CABEN (hasta `capacity`); la capacidad
 * real es el número de la mesa, no cuántas sillas se ven.
 *
 *   redonda      → repartidas en la circunferencia
 *   barra        → una fila, del lado «de abajo» (el del cliente)
 *   rectangular  → lados largos primero, cabeceras después
 */
export function seatLayout(
  shape: TableShape,
  w: number,
  h: number,
  capacity: number,
  gap = 0.11,
): Seat[] {
  const cap = clamp(Math.round(Number.isFinite(capacity) ? capacity : 0), 0, 24);
  if (cap <= 0 || w <= 0 || h <= 0) return [];
  const seats: Seat[] = [];
  if (shape === "round") {
    const rx = w / 2 + gap;
    const ry = h / 2 + gap;
    const fit = Math.max(1, Math.floor((Math.PI * (rx + ry)) / SEAT_PITCH));
    const n = Math.min(cap, fit);
    for (let i = 0; i < n; i++) {
      const a = -Math.PI / 2 + (i / n) * Math.PI * 2;
      seats.push({
        x: Math.cos(a) * rx,
        y: Math.sin(a) * ry,
        angle: (a * 180) / Math.PI + 90,
      });
    }
    return seats;
  }
  const along = (len: number, n: number, i: number) => -len / 2 + ((i + 0.5) * len) / n;
  if (shape === "bar") {
    const n = Math.min(cap, Math.max(1, Math.floor(w / SEAT_PITCH)));
    for (let i = 0; i < n; i++) {
      seats.push({ x: along(w, n, i), y: h / 2 + gap, angle: 180 });
    }
    return seats;
  }
  // Rectangular: los lados largos son los horizontales si w >= h.
  const horizontalLong = w >= h;
  const longLen = horizontalLong ? w : h;
  const shortLen = horizontalLong ? h : w;
  const longFit = Math.max(1, Math.floor(longLen / SEAT_PITCH));
  const shortFit = Math.max(1, Math.floor(shortLen / SEAT_PITCH));
  let left = cap;
  // Lado largo A y B.
  const onLong = Math.min(left, longFit * 2);
  const longA = Math.ceil(onLong / 2);
  const longB = onLong - longA;
  left -= onLong;
  const onShort = Math.min(left, shortFit * 2);
  const shortA = Math.ceil(onShort / 2);
  const shortB = onShort - shortA;
  const push = (side: "top" | "bottom" | "left" | "right", n: number) => {
    for (let i = 0; i < n; i++) {
      if (side === "top") seats.push({ x: along(w, n, i), y: -h / 2 - gap, angle: 0 });
      if (side === "bottom") seats.push({ x: along(w, n, i), y: h / 2 + gap, angle: 180 });
      if (side === "left") seats.push({ x: -w / 2 - gap, y: along(h, n, i), angle: 270 });
      if (side === "right") seats.push({ x: w / 2 + gap, y: along(h, n, i), angle: 90 });
    }
  };
  if (horizontalLong) {
    push("top", longA);
    push("bottom", longB);
    push("left", shortA);
    push("right", shortB);
  } else {
    push("left", longA);
    push("right", longB);
    push("top", shortA);
    push("bottom", shortB);
  }
  return seats;
}

/* ───────────────────── parseo defensivo (v2) ──────────────────── */

function cleanPoint(v: unknown): Point | null {
  if (!isObj(v) || !finite(v.x) || !finite(v.y)) return null;
  return {
    x: round3(clamp(v.x, 0, FLOOR_WORLD)),
    y: round3(clamp(v.y, 0, FLOOR_WORLD)),
  };
}

/** Limpia la lista de vértices: finitos, dentro del mundo, sin repetidos seguidos. */
export function cleanPolygon(raw: unknown): Point[] | null {
  if (!Array.isArray(raw)) return null;
  const pts: Point[] = [];
  for (const v of raw) {
    const p = cleanPoint(v);
    if (!p) continue;
    const last = pts[pts.length - 1];
    if (last && last.x === p.x && last.y === p.y) continue;
    pts.push(p);
    if (pts.length > FLOOR_MAX_ZONE_POINTS) return null;
  }
  if (pts.length > 1) {
    const first = pts[0];
    const last = pts[pts.length - 1];
    if (first.x === last.x && first.y === last.y) pts.pop();
  }
  if (pts.length < 3) return null;
  if (polygonArea(pts) < 0.01) return null;
  return pts;
}

/**
 * Normaliza una colocación (de mesa o de elemento). Devuelve null si
 * falta algo o no es un número finito: una mesa con datos rotos queda
 * «sin ubicar», nunca en NaN.
 */
export function sanitizePlacement(
  v: unknown,
  minSize = TABLE_SIZE_MIN,
  maxSize = TABLE_SIZE_MAX,
): TablePlacement | null {
  if (!isObj(v)) return null;
  if (!finite(v.x) || !finite(v.y) || !finite(v.w) || !finite(v.h)) return null;
  return {
    x: round3(clamp(v.x, 0, FLOOR_WORLD)),
    y: round3(clamp(v.y, 0, FLOOR_WORLD)),
    w: round3(clamp(v.w, minSize, maxSize)),
    h: round3(clamp(v.h, minSize, maxSize)),
    rotation: finite(v.rotation) ? normalizeRotation(v.rotation) : 0,
  };
}

/**
 * Parsea una escena v2 que viene de la BD o del navegador. Nunca tira:
 * descarta lo imposible (tipos desconocidos, NaN, polígonos de 2 puntos)
 * y acota todo al mundo y a los máximos.
 */
export function sanitizeScene(input: unknown): FloorScene {
  const o = isObj(input) ? input : {};
  const zones: Zone[] = [];
  const usedZ = new Set<string>();
  if (Array.isArray(o.zones)) {
    o.zones.forEach((raw, i) => {
      if (zones.length >= FLOOR_MAX_ZONES) return;
      if (!isObj(raw) || !isZoneKind(raw.kind)) return;
      const points = cleanPolygon(raw.points);
      if (!points) return;
      zones.push({
        id: cleanId(raw.id, `z${i}`, usedZ),
        kind: raw.kind,
        label: cleanLabel(raw.label),
        points,
      });
    });
  }
  const markers: Marker[] = [];
  const usedM = new Set<string>();
  if (Array.isArray(o.markers)) {
    o.markers.forEach((raw, i) => {
      if (markers.length >= FLOOR_MAX_MARKERS) return;
      if (!isObj(raw) || !isMarkerKind(raw.kind)) return;
      const def = MARKER_KINDS[raw.kind];
      const p = sanitizePlacement(
        { ...raw, w: finite(raw.w) ? raw.w : def.w, h: finite(raw.h) ? raw.h : def.h },
        MARKER_SIZE_MIN,
        MARKER_SIZE_MAX,
      );
      if (!p) return;
      const label = cleanLabel(raw.label);
      markers.push({
        id: cleanId(raw.id, `m${i}`, usedM),
        kind: raw.kind,
        label: label || null,
        ...p,
      });
    });
  }
  return { zones, markers };
}

/* ───────────────────── formato viejo (v1, celdas) ─────────────── */

export const LEGACY_MIN_COLS = 4;
export const LEGACY_MAX_COLS = 24;
export const LEGACY_MIN_ROWS = 4;
export const LEGACY_MAX_ROWS = 40;
const LEGACY_DEFAULT_COLS = 10;
const LEGACY_DEFAULT_ROWS = 6;
const LEGACY_MAX_ZONE_CELLS = 400;

export type LegacyCell = { x: number; y: number };
export type LegacyMarkerKind = "entrada" | "banos" | "barra" | "escaleras" | "cocina";
export type LegacyZone = { id: string; kind: ZoneKind; label: string; cells: LegacyCell[] };
export type LegacyMarker = {
  id: string;
  kind: LegacyMarkerKind;
  label: string | null;
  x: number;
  y: number;
};
export type LegacyFloorPlan = {
  cols: number;
  rows: number;
  zones: LegacyZone[];
  markers: LegacyMarker[];
};

/**
 * Nombre por defecto que el editor VIEJO guardaba en el rótulo de una
 * zona de tipo conocido. En v2 ese texto no se guarda (el nombre del tipo
 * se traduce): al convertir, un rótulo igual a este cuenta como vacío.
 */
export const LEGACY_ZONE_LABELS: Record<ZoneKind, string> = {
  interior: "Interior",
  exterior: "Exterior",
  terraza: "Terraza",
  jardin: "Jardín",
  barra: "Barra",
  cocina: "Cocina",
  banos: "Baños",
  custom: "Personalizada",
};

function clampInt(n: unknown, min: number, max: number, fallback: number): number {
  if (!finite(n)) return fallback;
  return clamp(Math.round(n), min, max);
}
function isLegacyMarkerKind(s: unknown): s is LegacyMarkerKind {
  return isMarkerKind(s) && MARKER_KINDS[s].legacy;
}

/**
 * Lee un blob v1 (grilla de celdas). Es, tal cual, el parseo del editor
 * viejo: acota a la grilla y descarta lo imposible. También lee la
 * proyección v1 que acompaña a un blob v2 (mismas claves).
 */
export function resolveLegacyFloorPlan(stored: unknown): LegacyFloorPlan {
  if (!isObj(stored)) {
    return { cols: LEGACY_DEFAULT_COLS, rows: LEGACY_DEFAULT_ROWS, zones: [], markers: [] };
  }
  const o = stored;
  const cols = clampInt(o.cols, LEGACY_MIN_COLS, LEGACY_MAX_COLS, LEGACY_DEFAULT_COLS);
  const rows = clampInt(o.rows, LEGACY_MIN_ROWS, LEGACY_MAX_ROWS, LEGACY_DEFAULT_ROWS);

  const zones: LegacyZone[] = [];
  if (Array.isArray(o.zones)) {
    o.zones.forEach((raw, i) => {
      if (!isObj(raw) || !isZoneKind(raw.kind)) return;
      const cells: LegacyCell[] = [];
      if (Array.isArray(raw.cells)) {
        const seen = new Set<string>();
        for (const c of raw.cells) {
          if (!isObj(c) || !finite(c.x) || !finite(c.y)) continue;
          const cx = Math.round(c.x);
          const cy = Math.round(c.y);
          if (cx < 0 || cy < 0 || cx >= cols || cy >= rows) continue;
          const key = `${cx},${cy}`;
          if (seen.has(key)) continue;
          seen.add(key);
          cells.push({ x: cx, y: cy });
          if (cells.length >= LEGACY_MAX_ZONE_CELLS) break;
        }
      } else {
        // Aún más viejo: la zona era un rectángulo {x,y,w,h}.
        const x = clampInt(raw.x, 0, cols - 1, 0);
        const y = clampInt(raw.y, 0, rows - 1, 0);
        const w = clampInt(raw.w, 1, cols - x, 1);
        const h = clampInt(raw.h, 1, rows - y, 1);
        for (let dy = 0; dy < h; dy++) {
          for (let dx = 0; dx < w; dx++) cells.push({ x: x + dx, y: y + dy });
        }
      }
      if (cells.length === 0) return;
      const rawLabel = cleanLabel(raw.label);
      const label = rawLabel || (raw.kind === "custom" ? "" : LEGACY_ZONE_LABELS[raw.kind]);
      const id = typeof raw.id === "string" && raw.id ? raw.id : `z${i}`;
      zones.push({ id, kind: raw.kind, label, cells });
    });
  }

  const markers: LegacyMarker[] = [];
  if (Array.isArray(o.markers)) {
    o.markers.forEach((raw, i) => {
      if (!isObj(raw) || !isLegacyMarkerKind(raw.kind)) return;
      const label = cleanLabel(raw.label) || null;
      const id = typeof raw.id === "string" && raw.id ? raw.id : `m${i}`;
      markers.push({
        id,
        kind: raw.kind,
        label,
        x: clampInt(raw.x, 0, cols - 1, 0),
        y: clampInt(raw.y, 0, rows - 1, 0),
      });
    });
  }
  return { cols, rows, zones, markers };
}

/**
 * Contorno(s) de un conjunto de celdas. Cada grupo de celdas pegadas por
 * un lado da UN polígono (su borde exterior, con los puntos alineados
 * fundidos). Un hueco interior se rellena: el plano viejo casi nunca los
 * tenía y un polígono simple es lo que el editor nuevo sabe editar.
 */
export function cellsToPolygons(cells: LegacyCell[]): Point[][] {
  const key = (x: number, y: number) => `${x},${y}`;
  const all = new Map<string, LegacyCell>();
  for (const c of cells) all.set(key(c.x, c.y), c);
  const seen = new Set<string>();
  const out: Point[][] = [];

  const ordered = [...all.values()].sort((a, b) => a.y - b.y || a.x - b.x);
  for (const start of ordered) {
    if (seen.has(key(start.x, start.y))) continue;
    // Componente conexa (vecindad de 4).
    const comp = new Set<string>();
    const stack = [start];
    seen.add(key(start.x, start.y));
    while (stack.length) {
      const c = stack.pop() as LegacyCell;
      comp.add(key(c.x, c.y));
      for (const [dx, dy] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ]) {
        const k = key(c.x + dx, c.y + dy);
        if (all.has(k) && !seen.has(k)) {
          seen.add(k);
          stack.push({ x: c.x + dx, y: c.y + dy });
        }
      }
    }
    const has = (x: number, y: number) => comp.has(key(x, y));

    // Aristas del borde, orientadas en sentido horario (interior a la
    // derecha). from → [to…]
    const edges = new Map<string, Point[]>();
    const add = (ax: number, ay: number, bx: number, by: number) => {
      const k = key(ax, ay);
      const list = edges.get(k);
      if (list) list.push({ x: bx, y: by });
      else edges.set(k, [{ x: bx, y: by }]);
    };
    for (const k of comp) {
      const [x, y] = k.split(",").map(Number);
      if (!has(x, y - 1)) add(x, y, x + 1, y);
      if (!has(x + 1, y)) add(x + 1, y, x + 1, y + 1);
      if (!has(x, y + 1)) add(x + 1, y + 1, x, y + 1);
      if (!has(x - 1, y)) add(x, y + 1, x, y);
    }

    // Recorrido desde la esquina superior izquierda (siempre borde
    // exterior). En un vértice donde dos celdas se tocan en diagonal hay
    // dos salidas: se toma el giro a la IZQUIERDA para seguir por fuera.
    const origin = { x: start.x, y: start.y };
    const loop: Point[] = [origin];
    let prev = origin;
    let cur = { x: start.x + 1, y: start.y };
    const maxSteps = comp.size * 4 + 8;
    for (let step = 0; step < maxSteps; step++) {
      if (cur.x === origin.x && cur.y === origin.y) break;
      loop.push(cur);
      const options = edges.get(key(cur.x, cur.y)) ?? [];
      if (options.length === 0) break;
      let next = options[0];
      if (options.length > 1) {
        const dx = cur.x - prev.x;
        const dy = cur.y - prev.y;
        // Giro a la izquierda (con «y» hacia abajo): (dx,dy) → (dy,-dx).
        const lx = dy;
        const ly = -dx;
        next =
          options.find((o) => o.x - cur.x === lx && o.y - cur.y === ly) ??
          options.find((o) => o.x - cur.x === dx && o.y - cur.y === dy) ??
          options[0];
      }
      prev = cur;
      cur = next;
    }

    // Fundir puntos alineados.
    const simplified: Point[] = [];
    for (let i = 0; i < loop.length; i++) {
      const a = loop[(i - 1 + loop.length) % loop.length];
      const b = loop[i];
      const c = loop[(i + 1) % loop.length];
      const collinear = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x) === 0;
      if (!collinear) simplified.push(b);
    }
    if (simplified.length >= 3 && simplified.length <= FLOOR_MAX_ZONE_POINTS) {
      out.push(simplified);
    } else {
      // Contorno imposible de editar (dentado extremo): su caja.
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (const k of comp) {
        const [x, y] = k.split(",").map(Number);
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x + 1);
        maxY = Math.max(maxY, y + 1);
      }
      out.push(rectPoints({ x: minX, y: minY, w: maxX - minX, h: maxY - minY }));
    }
  }
  return out;
}

/** Tamaño de una mesa que viene de una celda: deja sitio a las sillas. */
export const LEGACY_TABLE_SIZE = 0.7;

/**
 * Margen con el que se ubica un plano viejo dentro del mundo. La celda 0,0
 * era el borde del lienzo; corriéndolo 2 unidades queda espacio para
 * dibujar a la izquierda y arriba (una vereda, un ingreso). La proyección
 * de vuelta a celdas se corre al contenido, así que el plano viejo no cambia.
 */
export const LEGACY_OFFSET = 2;

/** Celda del plano viejo → colocación libre equivalente (centro de la celda). */
export function legacyCellToPlacement(
  shape: TableShape,
  cellX: number,
  cellY: number,
): TablePlacement {
  const bar = shape === "bar";
  return {
    x: clamp(cellX + 0.5 + LEGACY_OFFSET, 0, FLOOR_WORLD),
    y: clamp(cellY + 0.5 + LEGACY_OFFSET, 0, FLOOR_WORLD),
    w: bar ? 0.86 : LEGACY_TABLE_SIZE,
    h: bar ? 0.42 : LEGACY_TABLE_SIZE,
    rotation: 0,
  };
}

/** Plano viejo → escena libre equivalente. */
export function legacyToScene(legacy: LegacyFloorPlan): FloorScene {
  const zones: Zone[] = [];
  const used = new Set<string>();
  for (const z of legacy.zones) {
    const label = z.label === LEGACY_ZONE_LABELS[z.kind] ? "" : z.label;
    cellsToPolygons(z.cells).forEach((points, i) => {
      if (zones.length >= FLOOR_MAX_ZONES) return;
      zones.push({
        id: cleanId(i === 0 ? z.id : `${z.id}-${i + 1}`, `z${zones.length}`, used),
        kind: z.kind,
        label,
        points: points.map((p) => ({ x: p.x + LEGACY_OFFSET, y: p.y + LEGACY_OFFSET })),
      });
    });
  }
  const usedM = new Set<string>();
  const markers: Marker[] = legacy.markers.slice(0, FLOOR_MAX_MARKERS).map((m, i) => ({
    id: cleanId(m.id, `m${i}`, usedM),
    kind: m.kind,
    label: m.label,
    x: m.x + 0.5 + LEGACY_OFFSET,
    y: m.y + 0.5 + LEGACY_OFFSET,
    w: MARKER_KINDS[m.kind].w,
    h: MARKER_KINDS[m.kind].h,
    rotation: 0,
  }));
  return { zones, markers };
}

/* ─────────────── lectura unificada (lo que usa la app) ────────── */

/** Columnas de `Table` que hablan del plano. */
export type FloorTableRow = {
  id: string;
  shape: TableShape;
  floorPlanX: number | null;
  floorPlanY: number | null;
  floorX: number | null;
  floorY: number | null;
  floorW: number | null;
  floorH: number | null;
  floorRotation: number | null;
};

export type FloorSource = "v2" | "legacy";

/** ¿El blob guardado está en formato libre? */
export function isV2Stored(stored: unknown): boolean {
  return isObj(stored) && stored.version === FLOOR_PLAN_VERSION && isObj(stored.v2);
}

/**
 * LA lectura del plano. Devuelve la escena y dónde va cada mesa, venga
 * de donde venga:
 *   - blob v2 → escena v2 + columnas Float de cada mesa;
 *   - si no  → convierte al vuelo el plano de celdas (zonas → polígonos,
 *     íconos y mesas → centro de su celda).
 * Una mesa que no aparece en `placements` está «sin ubicar».
 */
export function resolveFloor(
  stored: unknown,
  rows: FloorTableRow[],
): { scene: FloorScene; placements: Record<string, TablePlacement>; source: FloorSource } {
  const placements: Record<string, TablePlacement> = {};
  if (isV2Stored(stored)) {
    const scene = sanitizeScene((stored as Record<string, unknown>).v2);
    for (const r of rows) {
      const p = sanitizePlacement({
        x: r.floorX,
        y: r.floorY,
        w: r.floorW,
        h: r.floorH,
        rotation: r.floorRotation ?? 0,
      });
      if (p) placements[r.id] = p;
    }
    return { scene, placements, source: "v2" };
  }
  const scene = legacyToScene(resolveLegacyFloorPlan(stored));
  for (const r of rows) {
    if (!finite(r.floorPlanX) || !finite(r.floorPlanY)) continue;
    placements[r.id] = legacyCellToPlacement(r.shape, r.floorPlanX, r.floorPlanY);
  }
  return { scene, placements, source: "legacy" };
}

/* ───────────── proyección v2 → v1 (para la versión vieja) ─────── */

/**
 * Versión «en celdas» de un plano libre, para que el código anterior
 * (durante el deploy blue/green o tras un rollback) siga mostrando un
 * plano coherente. Es una aproximación a propósito: cada mesa cae en la
 * celda de su centro (si está tomada, en la libre más cercana), las zonas
 * se rasterizan y los elementos nuevos (pared, columna, planta) no
 * existen allá.
 */
export function projectToLegacy(
  scene: FloorScene,
  tables: { id: string; number: number; placement: TablePlacement }[],
): { plan: LegacyFloorPlan; cells: Record<string, LegacyCell> } {
  const bounds = sceneBounds(
    scene,
    tables.map((t) => t.placement),
  );
  const ox = bounds ? Math.max(0, Math.floor(bounds.x)) : 0;
  const oy = bounds ? Math.max(0, Math.floor(bounds.y)) : 0;
  const cx = (x: number) => clamp(Math.floor(x - ox), 0, LEGACY_MAX_COLS - 1);
  const cy = (y: number) => clamp(Math.floor(y - oy), 0, LEGACY_MAX_ROWS - 1);
  let maxX = 0;
  let maxY = 0;
  const grow = (x: number, y: number) => {
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  };

  // Mesas: una por celda.
  const taken = new Set<string>();
  const cells: Record<string, LegacyCell> = {};
  const sorted = [...tables].sort((a, b) => a.number - b.number);
  for (const t of sorted) {
    const want = { x: cx(t.placement.x), y: cy(t.placement.y) };
    let cell = want;
    if (taken.has(`${want.x},${want.y}`)) {
      let found: LegacyCell | null = null;
      for (let r = 1; r <= 8 && !found; r++) {
        let bestD = Infinity;
        for (let dy = -r; dy <= r; dy++) {
          for (let dx = -r; dx <= r; dx++) {
            if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
            const x = want.x + dx;
            const y = want.y + dy;
            if (x < 0 || y < 0 || x >= LEGACY_MAX_COLS || y >= LEGACY_MAX_ROWS) continue;
            if (taken.has(`${x},${y}`)) continue;
            const d = dx * dx + dy * dy;
            if (d < bestD) {
              bestD = d;
              found = { x, y };
            }
          }
        }
      }
      if (found) cell = found;
    }
    taken.add(`${cell.x},${cell.y}`);
    cells[t.id] = cell;
    grow(cell.x, cell.y);
  }

  // Zonas: celdas cuyo centro cae dentro del polígono.
  const zones: LegacyZone[] = [];
  for (const z of scene.zones) {
    const b = polygonBounds(z.points);
    const zc: LegacyCell[] = [];
    const x0 = cx(b.x);
    const x1 = cx(b.x + b.w);
    const y0 = cy(b.y);
    const y1 = cy(b.y + b.h);
    for (let y = y0; y <= y1 && zc.length < LEGACY_MAX_ZONE_CELLS; y++) {
      for (let x = x0; x <= x1 && zc.length < LEGACY_MAX_ZONE_CELLS; x++) {
        if (pointInPolygon({ x: x + ox + 0.5, y: y + oy + 0.5 }, z.points)) {
          zc.push({ x, y });
        }
      }
    }
    if (zc.length === 0) {
      const c = polygonCentroid(z.points);
      zc.push({ x: cx(c.x), y: cy(c.y) });
    }
    for (const c of zc) grow(c.x, c.y);
    // Igual que el editor viejo: una zona de tipo conocido sin rótulo
    // propio lleva el nombre del tipo.
    const label = z.label || (z.kind === "custom" ? "" : LEGACY_ZONE_LABELS[z.kind]);
    zones.push({ id: z.id, kind: z.kind, label, cells: zc });
  }

  const markers: LegacyMarker[] = [];
  for (const m of scene.markers) {
    if (!isLegacyMarkerKind(m.kind)) continue;
    const x = cx(m.x);
    const y = cy(m.y);
    grow(x, y);
    markers.push({ id: m.id, kind: m.kind, label: m.label, x, y });
  }

  return {
    plan: {
      cols: clamp(maxX + 1, LEGACY_MIN_COLS, LEGACY_MAX_COLS),
      rows: clamp(maxY + 1, LEGACY_MIN_ROWS, LEGACY_MAX_ROWS),
      zones,
      markers,
    },
    cells,
  };
}

/**
 * Lo que se guarda en `Restaurant.floorPlan` desde el editor nuevo: la
 * escena libre bajo `v2`, `version: 2`, y las claves v1 de siempre con la
 * proyección (el código viejo lee solo esas y sigue funcionando).
 */
export function buildStoredFloorPlan(
  scene: FloorScene,
  legacy: LegacyFloorPlan,
): LegacyFloorPlan & { version: typeof FLOOR_PLAN_VERSION; v2: FloorScene } {
  return { ...legacy, version: FLOOR_PLAN_VERSION, v2: scene };
}

/* ───────────────────────── rótulos ────────────────────────────── */

/**
 * Dónde se ancla el rótulo de una zona: su vértice más arriba (y, entre
 * esos, el más a la izquierda). El rótulo se monta SOBRE el borde, como
 * la leyenda de un recuadro, así no tapa las mesas de adentro.
 */
export function zoneLabelAnchor(points: Point[]): Point {
  let best = points[0] ?? { x: 0, y: 0 };
  for (const p of points) {
    if (p.y < best.y - 1e-9 || (Math.abs(p.y - best.y) < 1e-9 && p.x < best.x)) best = p;
  }
  return best;
}
