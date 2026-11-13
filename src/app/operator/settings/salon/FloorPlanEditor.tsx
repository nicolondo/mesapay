"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import type { Locale } from "@/i18n/config";
import { formatDate, formatNumber } from "@/lib/format";
import {
  FLOOR_MAX_MARKERS,
  FLOOR_MAX_ZONES,
  FLOOR_WORLD,
  MARKER_KINDS,
  MARKER_KIND_LIST,
  ZONE_KINDS,
  ZONE_KIND_LIST,
  defaultTableSize,
  findOverlaps,
  isAxisRect,
  normalizeRotation,
  polygonArea,
  polygonBounds,
  rectBounds,
  rectPoints,
  round3,
  sanitizePlacement,
  sanitizeScene,
  sceneBounds,
  type Box,
  type FloorScene,
  type Marker,
  type MarkerKind,
  type Point,
  type TablePlacement,
  type TableShape,
  type Zone,
  type ZoneKind,
} from "@/lib/floorPlan";
import {
  alignDeltas,
  distributeDeltas,
  snapCoord,
  snapMove,
  type AlignMode,
  type SnapGuide,
} from "@/lib/floorPlanSnap";
import {
  FloorPlanCanvas,
  TONE_NEUTRAL,
  type CanvasTable,
  type TableState,
} from "@/components/floorplan/FloorPlanCanvas";
import { Glyph, MarkerGlyph, type UiGlyph } from "@/components/floorplan/glyphs";
import {
  MARKER_LIMITS,
  TABLE_LIMITS,
  arrangeInRows,
  boxFromPoints,
  boxOfKey,
  boxOfKeys,
  boxesIntersect,
  edgeNormal,
  freeSpotNear,
  insertVertex,
  keyOf,
  longestEdge,
  moveEdge,
  moveVertex,
  newId,
  pruneSelection,
  removeVertex,
  resizeRect,
  rotateKeys,
  splitKey,
  translateKeys,
  zoneRectBoolean,
  type Doc,
  type DocTable,
  type ResizeHandle,
  type TableMeta,
} from "./editorModel";
import { EditorOverlay, type Draft } from "./EditorOverlay";
import { Inspector, type InspectorActions } from "./Inspector";
import { useUnsavedGuard } from "./useUnsavedGuard";

export type EditorTable = {
  id: string;
  number: number;
  label: string | null;
  capacity: number;
  shape: TableShape;
  placement: TablePlacement | null;
};

type Tool =
  | { type: "select" }
  | { type: "zone"; kind: ZoneKind }
  | { type: "marker"; kind: MarkerKind }
  | { type: "bool"; zoneId: string; op: "add" | "cut" };

type Camera = { x: number; y: number; scale: number };
type Hist = { past: Doc[]; present: Doc; future: Doc[]; saved: Doc };
type Rectish = { x: number; y: number; w: number; h: number; rotation: number };

type Gesture =
  | {
      type: "pan";
      startX: number;
      startY: number;
      cam: Camera;
      moved: boolean;
      /** Zona bajo el puntero: se selecciona si fue un toque, no un arrastre. */
      tapKey: string | null;
      additive: boolean;
    }
  | { type: "pinch"; d0: number; mx: number; my: number; cam: Camera }
  | {
      type: "move";
      base: Doc;
      keys: string[];
      box: Box;
      others: Box[];
      startX: number;
      startY: number;
      moved: boolean;
      /** Al soltar sin arrastrar: dejar seleccionado solo este. */
      collapseTo: string | null;
      /** Al soltar sin arrastrar: quitar este de la selección. */
      removeOnTap: string | null;
    }
  | { type: "resize"; base: Doc; key: string; handle: ResizeHandle; orig: Rectish; round: boolean }
  | { type: "rotate"; base: Doc; key: string; orig: Rectish }
  | {
      type: "vertex";
      base: Doc;
      zoneId: string;
      index: number;
      points: Point[];
      /** Zona rectangular: la esquina opuesta queda fija y sigue siendo rectángulo. */
      fixed: Point | null;
      tx: number[];
      ty: number[];
    }
  | {
      type: "edge";
      base: Doc;
      zoneId: string;
      edge: number;
      points: Point[];
      start: Point;
      normal: Point;
      axis: "x" | "y" | null;
      coord: number;
      targets: number[];
    }
  | {
      type: "draw";
      mode: "zone" | "bool" | "marquee" | "wall" | "marker";
      start: Point;
      startX: number;
      startY: number;
      moved: boolean;
      additive: boolean;
    };

const MIN_SCALE = 10;
const MAX_SCALE = 200;
const FIT_MAX_SCALE = 84;
const GRID_STEP = 0.25;
const SIZE_STEP = 0.05;
const NUDGE = 0.05;
const NUDGE_BIG = 0.5;
const SNAP_PX = 7;
const WALL_THICKNESS = 0.14;
const HISTORY_LIMIT = 100;
const SELECT: Tool = { type: "select" };

const clamp = (n: number, min: number, max: number) => (n < min ? min : n > max ? max : n);

/** Mesa del documento → su objeto de dibujo (ver `canvasTables`). */
const CANVAS_CACHE = new WeakMap<DocTable, CanvasTable>();

function buildDoc(tables: EditorTable[], scene: FloorScene): Doc {
  const map: Doc["tables"] = {};
  for (const tb of tables) {
    map[tb.id] = { shape: tb.shape, capacity: tb.capacity, label: tb.label, placement: tb.placement };
  }
  return { tables: map, zones: scene.zones, markers: scene.markers };
}

function placedBounds(doc: Doc): Box | null {
  const placements: TablePlacement[] = [];
  for (const t of Object.values(doc.tables)) if (t.placement) placements.push(t.placement);
  return sceneBounds({ zones: doc.zones, markers: doc.markers }, placements);
}

/** Cámara que encuadra todo lo dibujado (o un salón vacío de 12 × 8). */
function fitCamera(doc: Doc, size: { w: number; h: number }): Camera {
  if (size.w <= 0 || size.h <= 0) return { x: 0, y: 0, scale: 48 };
  const b = placedBounds(doc) ?? { x: 1, y: 1, w: 12, h: 8 };
  const pad = 1;
  const scale = clamp(
    Math.min(size.w / (b.w + pad * 2), size.h / (b.h + pad * 2)),
    MIN_SCALE,
    FIT_MAX_SCALE,
  );
  return {
    x: b.x + b.w / 2 - size.w / scale / 2,
    y: b.y + b.h / 2 - size.h / scale / 2,
    scale,
  };
}

function clampCamera(cam: Camera, size: { w: number; h: number }): Camera {
  const vw = size.w / cam.scale;
  const vh = size.h / cam.scale;
  // Siempre queda a la vista un trozo del mundo.
  return {
    scale: cam.scale,
    x: clamp(cam.x, -vw + 2, FLOOR_WORLD - 2),
    y: clamp(cam.y, -vh + 2, FLOOR_WORLD - 2),
  };
}

function hashString(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return String(h >>> 0);
}

function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || !el.tagName) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable;
}

function withRect(doc: Doc, key: string, r: Rectish): Doc {
  const { type, id } = splitKey(key);
  if (type === "t") {
    const t = doc.tables[id];
    if (!t) return doc;
    return { ...doc, tables: { ...doc.tables, [id]: { ...t, placement: r } } };
  }
  if (type === "m") {
    return { ...doc, markers: doc.markers.map((m) => (m.id === id ? { ...m, ...r } : m)) };
  }
  return doc;
}

function withZonePoints(doc: Doc, zoneId: string, points: Point[]): Doc {
  return { ...doc, zones: doc.zones.map((z) => (z.id === zoneId ? { ...z, points } : z)) };
}

/** Largo «redondo» para la regla de escala: el que mida 56–150 px. */
function scaleBarUnits(scale: number): number {
  for (const u of [0.5, 1, 2, 5, 10, 20]) {
    if (u * scale >= 56) return u;
  }
  return 20;
}

export function FloorPlanEditor({
  restaurantId,
  initialTables,
  initialScene,
}: {
  restaurantId: string;
  initialTables: EditorTable[];
  initialScene: FloorScene;
}) {
  const t = useTranslations("opSalon");
  const tf = useTranslations("floorPlan");
  const locale = useLocale() as Locale;

  const [metas, setMetas] = useState<TableMeta[]>(() =>
    initialTables.map((tb) => ({ id: tb.id, number: tb.number })),
  );
  const [hist, setHist] = useState<Hist>(() => {
    const doc = buildDoc(initialTables, initialScene);
    return { past: [], present: doc, future: [], saved: doc };
  });
  const doc = hist.present;
  const dirty = hist.present !== hist.saved;

  const [rawSel, setSel] = useState<string[]>([]);
  const sel = useMemo(() => pruneSelection(doc, rawSel), [doc, rawSel]);
  const [tool, setTool] = useState<Tool>(SELECT);
  const [multi, setMulti] = useState(false);
  const [magnet, setMagnet] = useState(true);
  const [grid, setGrid] = useState(false);
  const [menu, setMenu] = useState<"zone" | "marker" | null>(null);
  const [camState, setCam] = useState<Camera | null>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [guides, setGuides] = useState<SnapGuide[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [readout, setReadout] = useState<{ x: number; y: number; text: string } | null>(null);
  const [activeVertex, setActiveVertex] = useState<number | null>(null);
  const [coarse, setCoarse] = useState(false);
  const [gesturing, setGesturing] = useState(false);
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [newOpen, setNewOpen] = useState(false);
  const [trayGhost, setTrayGhost] = useState<{ id: string; x: number; y: number } | null>(null);
  const [draftOffer, setDraftOffer] = useState<{ at: number; doc: Doc } | null>(null);

  const rootRef = useRef<HTMLDivElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const inspectorRef = useRef<HTMLDivElement>(null);
  const gesture = useRef<Gesture | null>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const lastTag = useRef<{ tag: string; at: number } | null>(null);
  const trayDrag = useRef<{
    id: string;
    base: Doc;
    startX: number;
    startY: number;
    moved: boolean;
    over: boolean;
  } | null>(null);

  const cam = useMemo(() => camState ?? fitCamera(doc, size), [camState, doc, size]);
  const view: Box = { x: cam.x, y: cam.y, w: size.w / cam.scale, h: size.h / cam.scale };

  useUnsavedGuard(dirty, t("leaveConfirm"));

  /* ───────────────────────── historial ───────────────────────── */

  /** Cambio discreto: entra al historial. `tag` funde cambios seguidos del mismo campo. */
  const apply = useCallback((fn: (d: Doc) => Doc, tag?: string) => {
    const now = Date.now();
    const coalesce = !!tag && lastTag.current?.tag === tag && now - lastTag.current.at < 1500;
    lastTag.current = tag ? { tag, at: now } : null;
    setStatus("idle");
    setHist((h) => {
      const next = fn(h.present);
      if (next === h.present) return h;
      if (coalesce) return { ...h, present: next };
      return {
        ...h,
        past: [...h.past, h.present].slice(-HISTORY_LIMIT),
        present: next,
        future: [],
      };
    });
  }, []);

  /** Durante un gesto: muestra el resultado sin tocar el historial. */
  const preview = useCallback((next: Doc) => {
    setHist((h) => (h.present === next ? h : { ...h, present: next }));
  }, []);

  /** Fin de un gesto: una sola entrada en el historial, desde `base`. */
  const commitFrom = useCallback((base: Doc) => {
    lastTag.current = null;
    setStatus("idle");
    setHist((h) =>
      h.present === base
        ? h
        : { ...h, past: [...h.past, base].slice(-HISTORY_LIMIT), future: [] },
    );
  }, []);

  const undo = useCallback(() => {
    lastTag.current = null;
    setStatus("idle");
    setHist((h) =>
      h.past.length === 0
        ? h
        : {
            ...h,
            past: h.past.slice(0, -1),
            present: h.past[h.past.length - 1],
            future: [h.present, ...h.future],
          },
    );
  }, []);

  const redo = useCallback(() => {
    lastTag.current = null;
    setStatus("idle");
    setHist((h) =>
      h.future.length === 0
        ? h
        : {
            ...h,
            past: [...h.past, h.present],
            present: h.future[0],
            future: h.future.slice(1),
          },
    );
  }, []);

  /* ───────────────────── tamaño del lienzo y zoom ─────────────── */

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const update = () => setSize({ w: el.clientWidth, h: el.clientHeight });
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const zoomAt = useCallback(
    (factor: number, clientX?: number, clientY?: number) => {
      const svg = svgRef.current;
      if (!svg) return;
      const r = svg.getBoundingClientRect();
      const px = clientX === undefined ? r.width / 2 : clientX - r.left;
      const py = clientY === undefined ? r.height / 2 : clientY - r.top;
      const scale = clamp(cam.scale * factor, MIN_SCALE, MAX_SCALE);
      const wx = cam.x + px / cam.scale;
      const wy = cam.y + py / cam.scale;
      setCam(clampCamera({ x: wx - px / scale, y: wy - py / scale, scale }, size));
    },
    [cam, size],
  );

  // La rueda necesita un listener NO pasivo para poder frenar el scroll.
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      // Pellizco del trackpad llega como rueda + ctrl, con deltas chicos.
      const k = e.ctrlKey ? 0.012 : 0.0016;
      const delta = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
      zoomAt(Math.exp(-delta * k), e.clientX, e.clientY);
    };
    svg.addEventListener("wheel", onWheel, { passive: false });
    return () => svg.removeEventListener("wheel", onWheel);
  }, [zoomAt]);

  /* ───────────────────── datos derivados para dibujar ─────────── */

  const metaById = useMemo(() => new Map(metas.map((m) => [m.id, m])), [metas]);

  // Una mesa que no cambió conserva el MISMO objeto entre renders (caché
  // por identidad de DocTable): así, al arrastrar una, las otras 80 no se
  // vuelven a dibujar.
  const canvasTables = useMemo<CanvasTable[]>(() => {
    const out: CanvasTable[] = [];
    for (const m of metas) {
      const tb = doc.tables[m.id];
      if (!tb?.placement) continue;
      let c = CANVAS_CACHE.get(tb);
      if (!c || c.id !== m.id || c.number !== m.number) {
        c = {
          id: m.id,
          number: m.number,
          label: tb.label,
          capacity: tb.capacity,
          shape: tb.shape,
          placement: tb.placement,
        };
        CANVAS_CACHE.set(tb, c);
      }
      out.push(c);
    }
    return out;
  }, [doc.tables, metas]);

  const unplaced = useMemo(
    () => metas.filter((m) => doc.tables[m.id] && !doc.tables[m.id].placement),
    [doc.tables, metas],
  );

  const overlaps = useMemo(
    () => findOverlaps(canvasTables.map((c) => ({ id: c.id, shape: c.shape, placement: c.placement }))),
    [canvasTables],
  );

  const scene = useMemo<FloorScene>(
    () => ({ zones: doc.zones, markers: doc.markers }),
    [doc.zones, doc.markers],
  );

  const selSet = useMemo(() => new Set(sel), [sel]);
  const selectedZoneIds = useMemo(
    () => new Set(sel.filter((k) => k[0] === "z").map((k) => k.slice(2))),
    [sel],
  );

  const tableState = useCallback(
    (c: CanvasTable): TableState => ({
      tone: TONE_NEUTRAL,
      ariaLabel: c.label
        ? t("tableAriaLabel", { number: c.number, label: c.label, count: c.capacity })
        : t("tableAria", { number: c.number, count: c.capacity }),
      pressed: selSet.has(keyOf("t", c.id)),
      warn: overlaps.has(c.id),
    }),
    [overlaps, selSet, t],
  );

  const selectTableByKeyboard = useCallback((id: string) => setSel([keyOf("t", id)]), []);

  const fmtMeters = useCallback(
    (v: number) => formatNumber(v, { locale, minimumFractionDigits: 2, maximumFractionDigits: 2 }),
    [locale],
  );

  /* ───────────────────────── utilidades ───────────────────────── */

  function clientToWorld(clientX: number, clientY: number): Point {
    const r = svgRef.current?.getBoundingClientRect();
    if (!r) return { x: 0, y: 0 };
    return { x: cam.x + (clientX - r.left) / cam.scale, y: cam.y + (clientY - r.top) / cam.scale };
  }

  function overCanvas(clientX: number, clientY: number): boolean {
    const r = svgRef.current?.getBoundingClientRect();
    return !!r && clientX >= r.left && clientX <= r.right && clientY >= r.top && clientY <= r.bottom;
  }

  function snapOpts(noSnap: boolean) {
    return {
      threshold: magnet && !noSnap ? SNAP_PX / cam.scale : 0,
      grid: grid && !noSnap ? GRID_STEP : null,
    };
  }

  function showReadout(clientX: number, clientY: number, text: string) {
    const r = wrapRef.current?.getBoundingClientRect();
    if (!r) return;
    setReadout({
      x: clamp(clientX - r.left + 14, 8, Math.max(8, r.width - 120)),
      y: clamp(clientY - r.top - 34, 8, Math.max(8, r.height - 36)),
      text,
    });
  }

  function sizeText(w: number, h: number): string {
    return t("readoutSize", { w: fmtMeters(w), h: fmtMeters(h) });
  }

  /** Coordenadas imantables de los vértices de las zonas (menos la excluida). */
  function zoneTargets(d: Doc, skipZone: string | null, skipIndex: number | null) {
    const tx: number[] = [];
    const ty: number[] = [];
    for (const z of d.zones) {
      z.points.forEach((p, i) => {
        if (z.id === skipZone && (skipIndex === null || i === skipIndex)) return;
        tx.push(p.x);
        ty.push(p.y);
      });
    }
    return { tx, ty };
  }

  function snapPoint(p: Point, tx: number[], ty: number[], noSnap: boolean): { p: Point; guides: SnapGuide[] } {
    const opts = snapOpts(noSnap);
    const sx = snapCoord(p.x, tx, opts);
    const sy = snapCoord(p.y, ty, opts);
    const g: SnapGuide[] = [];
    if (sx.hit !== null) g.push({ kind: "v", x: sx.hit, y1: view.y, y2: view.y + view.h });
    if (sy.hit !== null) g.push({ kind: "h", y: sy.hit, x1: view.x, x2: view.x + view.w });
    return {
      p: { x: clamp(sx.v, 0, FLOOR_WORLD), y: clamp(sy.v, 0, FLOOR_WORLD) },
      guides: g,
    };
  }

  function othersFor(base: Doc, keys: string[]): Box[] {
    const moving = new Set(keys);
    const out: Box[] = [];
    if (keys.every((k) => k[0] === "z")) {
      for (const z of base.zones) if (!moving.has(keyOf("z", z.id))) out.push(polygonBounds(z.points));
      return out;
    }
    for (const [id, tb] of Object.entries(base.tables)) {
      if (tb.placement && !moving.has(keyOf("t", id))) out.push(rectBounds(tb.placement));
    }
    for (const m of base.markers) if (!moving.has(keyOf("m", m.id))) out.push(rectBounds(m));
    return out;
  }

  function endGestureUi() {
    gesture.current = null;
    setGuides([]);
    setDraft(null);
    setReadout(null);
    setGesturing(false);
  }

  /* ─────────────────────── gestos en el lienzo ────────────────── */

  function onPointerDown(e: React.PointerEvent<SVGSVGElement>) {
    if (e.pointerType === "mouse" && e.button !== 0 && e.button !== 1) return;
    const svg = e.currentTarget;
    try {
      svg.setPointerCapture(e.pointerId);
    } catch {
      /* sin captura: el gesto igual sigue mientras el puntero esté encima */
    }
    setMenu(null);
    // Si se estaba escribiendo en el panel, tocar el lienzo termina esa
    // edición: así las flechas y Supr vuelven a actuar sobre el plano.
    if (isTypingTarget(document.activeElement)) (document.activeElement as HTMLElement).blur();
    const isCoarse = e.pointerType !== "mouse";
    if (isCoarse !== coarse) setCoarse(isCoarse);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    // Congelar la cámara: mientras se arrastra, el encuadre no debe moverse solo.
    if (!camState) setCam(cam);

    // Segundo dedo: se cancela lo que hubiera y se pasa a pellizco.
    if (pointers.current.size === 2) {
      const g = gesture.current;
      if (g && "base" in g) preview(g.base);
      endGestureUi();
      const [a, b] = [...pointers.current.values()];
      gesture.current = {
        type: "pinch",
        d0: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)),
        mx: (a.x + b.x) / 2,
        my: (a.y + b.y) / 2,
        cam,
      };
      return;
    }
    if (pointers.current.size > 2) return;

    const world = clientToWorld(e.clientX, e.clientY);
    const additive = multi || e.shiftKey || e.metaKey || e.ctrlKey;
    const startPan = (tapKey: string | null) => {
      gesture.current = {
        type: "pan",
        startX: e.clientX,
        startY: e.clientY,
        cam,
        moved: false,
        tapKey,
        additive,
      };
    };

    // Botón del medio: siempre desplaza.
    if (e.pointerType === "mouse" && e.button === 1) {
      e.preventDefault();
      startPan(null);
      return;
    }

    // Herramientas de dibujo.
    if (tool.type !== "select") {
      const mode =
        tool.type === "zone" ? "zone" : tool.type === "bool" ? "bool" : tool.kind === "pared" ? "wall" : "marker";
      const { tx, ty } = zoneTargets(doc, null, null);
      const start = mode === "marker" ? world : snapPoint(world, tx, ty, e.altKey).p;
      gesture.current = {
        type: "draw",
        mode,
        start,
        startX: e.clientX,
        startY: e.clientY,
        moved: false,
        additive: false,
      };
      setGesturing(true);
      return;
    }

    const el = (e.target as Element).closest?.("[data-fp]");
    const kind = el?.getAttribute("data-fp") ?? null;

    // Manijas de lo seleccionado.
    if (kind === "handle" && sel.length === 1) {
      const h = el?.getAttribute("data-h") ?? "";
      const key = sel[0];
      const { type, id } = splitKey(key);
      if (h === "rot" || h.startsWith("r:")) {
        const orig: Rectish | null =
          type === "t"
            ? (doc.tables[id]?.placement ?? null)
            : (doc.markers.find((m) => m.id === id) ?? null);
        if (!orig) return;
        if (h === "rot") {
          gesture.current = { type: "rotate", base: doc, key, orig };
        } else {
          const [, sx, sy] = h.split(":");
          gesture.current = {
            type: "resize",
            base: doc,
            key,
            handle: { sx: Number(sx) as -1 | 0 | 1, sy: Number(sy) as -1 | 0 | 1 },
            orig,
            round: type === "t" && doc.tables[id]?.shape === "round",
          };
        }
        setGesturing(true);
        return;
      }
      const zone = type === "z" ? doc.zones.find((z) => z.id === id) : null;
      if (zone && h.startsWith("v:")) {
        const index = Number(h.slice(2));
        const rect = isAxisRect(zone.points) && !e.altKey;
        const { tx, ty } = zoneTargets(doc, zone.id, rect ? null : index);
        setActiveVertex(index);
        gesture.current = {
          type: "vertex",
          base: doc,
          zoneId: zone.id,
          index,
          points: zone.points,
          fixed: rect ? zone.points[(index + 2) % 4] : null,
          tx,
          ty,
        };
        setGesturing(true);
        return;
      }
      if (zone && h.startsWith("e:")) {
        const edge = Number(h.slice(2));
        const a = zone.points[edge];
        const b = zone.points[(edge + 1) % zone.points.length];
        const vertical = Math.abs(a.x - b.x) < 1e-6;
        const horizontal = Math.abs(a.y - b.y) < 1e-6;
        const axis = vertical ? "x" : horizontal ? "y" : null;
        const { tx, ty } = zoneTargets(doc, zone.id, null);
        gesture.current = {
          type: "edge",
          base: doc,
          zoneId: zone.id,
          edge,
          points: zone.points,
          start: world,
          normal: edgeNormal(zone.points, edge),
          axis,
          coord: axis === "x" ? a.x : a.y,
          targets: axis === "x" ? tx : ty,
        };
        setGesturing(true);
        return;
      }
    }

    // Mesa, elemento, o el cuerpo de lo ya seleccionado.
    let key: string | null = null;
    if (kind === "table") key = keyOf("t", el?.getAttribute("data-id") ?? "");
    else if (kind === "marker") key = keyOf("m", el?.getAttribute("data-id") ?? "");
    else if (kind === "grab" && sel.length === 1) key = sel[0];
    else if (kind === "zone") {
      const zk = keyOf("z", el?.getAttribute("data-id") ?? "");
      // Una zona es fondo: arrastrarla desplaza el plano, salvo que ya esté
      // seleccionada (entonces sí se mueve). Tocarla la selecciona.
      if (selSet.has(zk) && !additive) key = zk;
      else {
        startPan(zk);
        return;
      }
    }

    if (key) {
      let keys = sel;
      let collapseTo: string | null = null;
      let removeOnTap: string | null = null;
      if (additive) {
        if (selSet.has(key)) removeOnTap = key;
        else keys = [...sel, key];
      } else if (!selSet.has(key)) {
        keys = [key];
      } else if (sel.length > 1) {
        collapseTo = key;
      }
      if (keys !== sel) setSel(keys);
      setActiveVertex(null);
      const box = boxOfKeys(doc, keys);
      if (!box) return;
      gesture.current = {
        type: "move",
        base: doc,
        keys,
        box,
        others: othersFor(doc, keys),
        startX: e.clientX,
        startY: e.clientY,
        moved: false,
        collapseTo,
        removeOnTap,
      };
      return;
    }

    // Fondo vacío.
    if (additive) {
      gesture.current = {
        type: "draw",
        mode: "marquee",
        start: world,
        startX: e.clientX,
        startY: e.clientY,
        moved: false,
        additive: true,
      };
      return;
    }
    startPan(null);
  }

  function onPointerMove(e: React.PointerEvent<SVGSVGElement>) {
    if (pointers.current.has(e.pointerId)) {
      pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    }
    const g = gesture.current;
    if (!g) return;
    const slop = e.pointerType === "mouse" ? 3 : 8;

    if (g.type === "pinch") {
      if (pointers.current.size < 2) return;
      const [a, b] = [...pointers.current.values()];
      const d = Math.max(1, Math.hypot(a.x - b.x, a.y - b.y));
      const mx = (a.x + b.x) / 2;
      const my = (a.y + b.y) / 2;
      const r = e.currentTarget.getBoundingClientRect();
      const scale = clamp((g.cam.scale * d) / g.d0, MIN_SCALE, MAX_SCALE);
      const wx = g.cam.x + (g.mx - r.left) / g.cam.scale;
      const wy = g.cam.y + (g.my - r.top) / g.cam.scale;
      setCam(clampCamera({ x: wx - (mx - r.left) / scale, y: wy - (my - r.top) / scale, scale }, size));
      return;
    }

    if (g.type === "pan") {
      const dx = e.clientX - g.startX;
      const dy = e.clientY - g.startY;
      if (!g.moved && Math.hypot(dx, dy) < slop) return;
      g.moved = true;
      setCam(
        clampCamera(
          { x: g.cam.x - dx / g.cam.scale, y: g.cam.y - dy / g.cam.scale, scale: g.cam.scale },
          size,
        ),
      );
      return;
    }

    const world = clientToWorld(e.clientX, e.clientY);

    if (g.type === "move") {
      let dx = (e.clientX - g.startX) / cam.scale;
      let dy = (e.clientY - g.startY) / cam.scale;
      if (!g.moved) {
        if (Math.hypot(e.clientX - g.startX, e.clientY - g.startY) < slop) return;
        g.moved = true;
        setGesturing(true);
      }
      // Mayús: mover solo en horizontal o solo en vertical.
      if (e.shiftKey && !multi) {
        if (Math.abs(dx) > Math.abs(dy)) dy = 0;
        else dx = 0;
      }
      const opts = snapOpts(e.altKey);
      if (opts.threshold > 0 || opts.grid) {
        const s = snapMove({ ...g.box, x: g.box.x + dx, y: g.box.y + dy }, g.others, opts);
        dx += s.dx;
        dy += s.dy;
        setGuides(s.guides);
      } else {
        setGuides([]);
      }
      preview(translateKeys(g.base, g.keys, dx, dy));
      return;
    }

    if (g.type === "resize") {
      const step = e.altKey ? null : grid ? GRID_STEP : magnet ? SIZE_STEP : null;
      const isTable = g.key[0] === "t";
      let next = resizeRect(g.orig, g.handle, world, {
        keepAspect: g.round || e.shiftKey,
        step,
        ...(isTable ? TABLE_LIMITS : MARKER_LIMITS),
      });
      if (g.round) {
        const d = g.handle.sx ? next.w : next.h;
        next = { ...next, w: d, h: d };
      }
      preview(withRect(g.base, g.key, next));
      showReadout(e.clientX, e.clientY, sizeText(next.w, next.h));
      return;
    }

    if (g.type === "rotate") {
      let deg = (Math.atan2(world.y - g.orig.y, world.x - g.orig.x) * 180) / Math.PI + 90;
      const near = Math.round(deg / 15) * 15;
      if (e.shiftKey || (magnet && !e.altKey && Math.abs(near - deg) < 4)) deg = near;
      const rotation = normalizeRotation(deg);
      preview(withRect(g.base, g.key, { ...g.orig, rotation }));
      showReadout(e.clientX, e.clientY, t("readoutAngle", { deg: Math.round(rotation) }));
      return;
    }

    if (g.type === "vertex") {
      const s = snapPoint(world, g.tx, g.ty, e.altKey);
      let points: Point[];
      if (g.fixed) {
        const box = boxFromPoints(g.fixed, s.p);
        if (box.w < 0.3 || box.h < 0.3) return;
        points = rectPoints(box).map((p) => ({ x: round3(p.x), y: round3(p.y) }));
        showReadout(e.clientX, e.clientY, sizeText(box.w, box.h));
      } else {
        points = moveVertex(g.points, g.index, s.p);
        if (polygonArea(points) < 0.05) return;
      }
      setGuides(s.guides);
      preview(withZonePoints(g.base, g.zoneId, points));
      return;
    }

    if (g.type === "edge") {
      let offset = (world.x - g.start.x) * g.normal.x + (world.y - g.start.y) * g.normal.y;
      const gs: SnapGuide[] = [];
      if (g.axis) {
        const sign = g.axis === "x" ? g.normal.x : g.normal.y;
        const s = snapCoord(g.coord + offset * sign, g.targets, snapOpts(e.altKey));
        offset = (s.v - g.coord) * sign;
        if (s.hit !== null) {
          gs.push(
            g.axis === "x"
              ? { kind: "v", x: s.hit, y1: view.y, y2: view.y + view.h }
              : { kind: "h", y: s.hit, x1: view.x, x2: view.x + view.w },
          );
        }
      }
      const points = moveEdge(g.points, g.edge, offset);
      if (polygonArea(points) < 0.05) return;
      setGuides(gs);
      preview(withZonePoints(g.base, g.zoneId, points));
      const b = polygonBounds(points);
      showReadout(e.clientX, e.clientY, sizeText(b.w, b.h));
      return;
    }

    // g.type === "draw"
    if (!g.moved) {
      if (Math.hypot(e.clientX - g.startX, e.clientY - g.startY) < slop) return;
      g.moved = true;
    }
    if (g.mode === "marker") return;
    if (g.mode === "marquee") {
      setDraft({ type: "marquee", box: boxFromPoints(g.start, world) });
      return;
    }
    if (g.mode === "wall") {
      const wall = wallFrom(g.start, world, e.altKey);
      setDraft({ type: "wall", ...wall });
      showReadout(e.clientX, e.clientY, t("readoutLength", { len: fmtMeters(wall.w) }));
      return;
    }
    const { tx, ty } = zoneTargets(doc, null, null);
    const s = snapPoint(world, tx, ty, e.altKey);
    const box = boxFromPoints(g.start, s.p);
    setGuides(s.guides);
    if (g.mode === "zone" && tool.type === "zone") setDraft({ type: "zone", box, kind: tool.kind });
    else if (g.mode === "bool" && tool.type === "bool") setDraft({ type: "bool", box, op: tool.op });
    showReadout(e.clientX, e.clientY, sizeText(box.w, box.h));
  }

  function wallFrom(a: Point, b: Point, noSnap: boolean): Rectish {
    let angle = (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
    let len = Math.hypot(b.x - a.x, b.y - a.y);
    if (magnet && !noSnap) {
      angle = Math.round(angle / 15) * 15;
      len = Math.round(len / SIZE_STEP) * SIZE_STEP;
    }
    len = clamp(len, 0.3, MARKER_LIMITS.max);
    const rad = (angle * Math.PI) / 180;
    return {
      x: round3(clamp(a.x + (Math.cos(rad) * len) / 2, 0, FLOOR_WORLD)),
      y: round3(clamp(a.y + (Math.sin(rad) * len) / 2, 0, FLOOR_WORLD)),
      w: round3(len),
      h: WALL_THICKNESS,
      rotation: normalizeRotation(angle),
    };
  }

  function onPointerUp(e: React.PointerEvent<SVGSVGElement>) {
    pointers.current.delete(e.pointerId);
    const g = gesture.current;
    if (!g) return;

    if (g.type === "pinch") {
      // Queda un dedo: no se retoma ningún gesto hasta soltar todo.
      if (pointers.current.size === 0) gesture.current = null;
      return;
    }

    if (g.type === "pan") {
      gesture.current = null;
      if (g.moved) return;
      setActiveVertex(null);
      if (g.tapKey) {
        const key = g.tapKey;
        if (g.additive) {
          setSel(selSet.has(key) ? sel.filter((k) => k !== key) : [...sel, key]);
        } else {
          setSel([key]);
        }
      } else {
        setSel([]);
      }
      return;
    }

    if (g.type === "move") {
      if (g.moved) commitFrom(g.base);
      else if (g.removeOnTap) setSel(sel.filter((k) => k !== g.removeOnTap));
      else if (g.collapseTo) setSel([g.collapseTo]);
      endGestureUi();
      return;
    }

    if (g.type === "resize" || g.type === "rotate" || g.type === "vertex" || g.type === "edge") {
      commitFrom(g.base);
      endGestureUi();
      return;
    }

    // g.type === "draw"
    const world = clientToWorld(e.clientX, e.clientY);
    if (g.mode === "marquee") {
      if (g.moved) {
        const box = boxFromPoints(g.start, world);
        const hit: string[] = [];
        for (const c of canvasTables) {
          if (boxesIntersect(box, rectBounds(c.placement))) hit.push(keyOf("t", c.id));
        }
        for (const m of doc.markers) {
          if (boxesIntersect(box, rectBounds(m))) hit.push(keyOf("m", m.id));
        }
        setSel([...new Set([...sel, ...hit])]);
      }
      endGestureUi();
      return;
    }

    if (g.mode === "marker" && tool.type === "marker") {
      const def = MARKER_KINDS[tool.kind];
      const at = grid
        ? { x: Math.round(world.x / GRID_STEP) * GRID_STEP, y: Math.round(world.y / GRID_STEP) * GRID_STEP }
        : world;
      addMarker({
        kind: tool.kind,
        x: round3(clamp(at.x, 0, FLOOR_WORLD)),
        y: round3(clamp(at.y, 0, FLOOR_WORLD)),
        w: def.w,
        h: def.h,
        rotation: 0,
      });
    } else if (g.mode === "wall") {
      const wall = g.moved
        ? wallFrom(g.start, world, e.altKey)
        : { x: g.start.x, y: g.start.y, w: MARKER_KINDS.pared.w, h: WALL_THICKNESS, rotation: 0 };
      addMarker({ kind: "pared", ...wall });
    } else if (g.mode === "zone" && tool.type === "zone") {
      const { tx, ty } = zoneTargets(doc, null, null);
      let box = boxFromPoints(g.start, snapPoint(world, tx, ty, e.altKey).p);
      // Un toque sin arrastrar: una zona de tamaño cómodo desde ese punto.
      if (!g.moved || box.w < 0.3 || box.h < 0.3) {
        box = {
          x: clamp(g.start.x, 0, FLOOR_WORLD - 4),
          y: clamp(g.start.y, 0, FLOOR_WORLD - 3),
          w: 4,
          h: 3,
        };
      }
      addZone(tool.kind, box);
    } else if (g.mode === "bool" && tool.type === "bool" && g.moved) {
      const { tx, ty } = zoneTargets(doc, null, null);
      const box = boxFromPoints(g.start, snapPoint(world, tx, ty, e.altKey).p);
      const zone = doc.zones.find((z) => z.id === tool.zoneId);
      if (zone && box.w > 0.05 && box.h > 0.05) {
        const points = zoneRectBoolean(zone.points, box, tool.op);
        if (points) {
          apply((d) => withZonePoints(d, zone.id, points));
          setNotice(null);
        } else {
          setNotice(t("zoneBoolFailed"));
        }
      }
      setTool(SELECT);
    }
    endGestureUi();
  }

  function onPointerCancel(e: React.PointerEvent<SVGSVGElement>) {
    pointers.current.delete(e.pointerId);
    const g = gesture.current;
    if (g && "base" in g) preview(g.base);
    if (pointers.current.size === 0) endGestureUi();
  }

  /* ───────────────────────── acciones ─────────────────────────── */

  function addZone(kind: ZoneKind, box: Box) {
    if (doc.zones.length >= FLOOR_MAX_ZONES) {
      setNotice(t("limitReached"));
      setTool(SELECT);
      return;
    }
    const id = newId("z");
    const points = rectPoints(box).map((p) => ({ x: round3(p.x), y: round3(p.y) }));
    // Las zonas nuevas van al fondo de lo ya dibujado solo si son más
    // grandes; así una barra dibujada después queda encima del interior.
    apply((d) => ({ ...d, zones: [...d.zones, { id, kind, label: "", points }] }));
    setSel([keyOf("z", id)]);
    setActiveVertex(null);
    setTool(SELECT);
    setNotice(null);
  }

  function addMarker(m: Omit<Marker, "id" | "label">) {
    if (doc.markers.length >= FLOOR_MAX_MARKERS) {
      setNotice(t("limitReached"));
      setTool(SELECT);
      return;
    }
    const id = newId("m");
    apply((d) => ({ ...d, markers: [...d.markers, { id, label: null, ...m }] }));
    setSel([keyOf("m", id)]);
    setTool(SELECT);
    setNotice(null);
  }

  function viewCenter(): Point {
    return { x: view.x + view.w / 2, y: view.y + view.h / 2 };
  }

  /** Pone en el plano una mesa de la bandeja, cerca de `near`. */
  function placeTable(id: string, near: Point) {
    apply((d) => {
      const tb = d.tables[id];
      if (!tb || tb.placement) return d;
      const s = defaultTableSize(tb.shape, tb.capacity);
      const spot = freeSpotNear(d, tb.shape, s, near);
      return {
        ...d,
        tables: { ...d.tables, [id]: { ...tb, placement: { ...spot, ...s, rotation: 0 } } },
      };
    });
    setSel([keyOf("t", id)]);
  }

  function placeAll() {
    if (unplaced.length === 0) return;
    apply((d) => {
      const b = placedBounds(d);
      const origin = b ? { x: b.x, y: b.y + b.h + 1 } : { x: 1.5, y: 1.5 };
      const items = unplaced.map((m) => ({ id: m.id, ...defaultTableSize(d.tables[m.id].shape, d.tables[m.id].capacity) }));
      const spots = arrangeInRows(items, origin, Math.max(b?.w ?? 0, 10));
      const tables = { ...d.tables };
      for (const it of items) {
        tables[it.id] = {
          ...tables[it.id],
          placement: { ...spots[it.id], w: it.w, h: it.h, rotation: 0 },
        };
      }
      return { ...d, tables };
    });
    setSel(unplaced.map((m) => keyOf("t", m.id)));
    setCam(null);
  }

  /** Crea una mesa de verdad (queda en Mesas, con su QR) y la deja en la bandeja. */
  async function createTable(input: {
    number: number;
    capacity: number;
    shape: TableShape;
  }): Promise<{ id: string } | { error: "taken" | "failed" }> {
    let res: Response;
    try {
      res = await fetch("/api/operator/tables", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      });
    } catch {
      return { error: "failed" };
    }
    if (!res.ok) {
      const j = (await res.json().catch(() => ({}))) as { error?: string };
      return { error: j.error === "number_taken" ? "taken" : "failed" };
    }
    const j = (await res.json()) as { id: string };
    const entry: DocTable = { shape: input.shape, capacity: input.capacity, label: null, placement: null };
    // La mesa existe ya en el servidor: entra a TODO el historial (y a lo
    // guardado) para que deshacer no la «desaparezca» del editor.
    setHist((h) => {
      const seen = new Map<Doc, Doc>();
      const add = (d: Doc): Doc => {
        const hit = seen.get(d);
        if (hit) return hit;
        const next = { ...d, tables: { ...d.tables, [j.id]: entry } };
        seen.set(d, next);
        return next;
      };
      return {
        past: h.past.map(add),
        present: add(h.present),
        future: h.future.map(add),
        saved: add(h.saved),
      };
    });
    setMetas((ms) => [...ms, { id: j.id, number: input.number }].sort((a, b) => a.number - b.number));
    return { id: j.id };
  }

  function nextTableNumber(): number {
    return metas.reduce((mx, m) => Math.max(mx, m.number), 0) + 1;
  }

  async function duplicate() {
    if (sel.length === 0 || busy) return;
    const made: string[] = [];
    const tableKeys = sel.filter((k) => k[0] === "t");
    const others = sel.filter((k) => k[0] !== "t");
    const offset = 0.5;

    if (others.length > 0) {
      const clones: { key: string; zone?: Zone; marker?: Marker }[] = [];
      for (const k of others) {
        const { type, id } = splitKey(k);
        if (type === "z") {
          const z = doc.zones.find((x) => x.id === id);
          if (z && doc.zones.length + clones.length < FLOOR_MAX_ZONES) {
            const nid = newId("z");
            clones.push({ key: keyOf("z", nid), zone: { ...z, id: nid } });
          }
        } else {
          const m = doc.markers.find((x) => x.id === id);
          if (m && doc.markers.length + clones.length < FLOOR_MAX_MARKERS) {
            const nid = newId("m");
            clones.push({ key: keyOf("m", nid), marker: { ...m, id: nid } });
          }
        }
      }
      apply((d) => {
        const withClones: Doc = {
          ...d,
          zones: [...d.zones, ...clones.flatMap((c) => (c.zone ? [c.zone] : []))],
          markers: [...d.markers, ...clones.flatMap((c) => (c.marker ? [c.marker] : []))],
        };
        return translateKeys(
          withClones,
          clones.map((c) => c.key),
          offset,
          offset,
        );
      });
      made.push(...clones.map((c) => c.key));
    }

    if (tableKeys.length > 0) {
      setBusy(true);
      setNotice(null);
      const pool = unplaced.map((m) => m.id);
      let nextNumber = nextTableNumber();
      for (const k of tableKeys) {
        const srcId = k.slice(2);
        const src = doc.tables[srcId];
        if (!src?.placement) continue;
        let targetId = pool.shift() ?? null;
        if (!targetId) {
          const created = await createTable({
            number: nextNumber,
            capacity: src.capacity,
            shape: src.shape,
          });
          if ("error" in created) {
            setNotice(t(created.error === "taken" ? "newTableTaken" : "newTableFailed"));
            break;
          }
          nextNumber += 1;
          targetId = created.id;
        }
        const tid = targetId;
        const from = src.placement;
        apply((d) => {
          const target = d.tables[tid];
          if (!target) return d;
          const spot = freeSpotNear(d, src.shape, { w: from.w, h: from.h }, {
            x: from.x + rectBounds(from).w + 0.4,
            y: from.y,
          });
          return {
            ...d,
            tables: {
              ...d.tables,
              [tid]: {
                ...target,
                shape: src.shape,
                capacity: src.capacity,
                placement: { ...from, ...spot },
              },
            },
          };
        });
        made.push(keyOf("t", tid));
      }
      setBusy(false);
    }
    if (made.length > 0) setSel(made);
  }

  /** Mesas → vuelven a la bandeja (la mesa NO se borra). Zonas y elementos → se eliminan. */
  function removeSelected() {
    if (sel.length === 0) return;
    const set = new Set(sel);
    apply((d) => {
      let tables = d.tables;
      for (const k of sel) {
        if (k[0] !== "t") continue;
        const id = k.slice(2);
        const tb = tables[id];
        if (!tb?.placement) continue;
        if (tables === d.tables) tables = { ...tables };
        tables[id] = { ...tb, placement: null };
      }
      return {
        tables,
        zones: d.zones.filter((z) => !set.has(keyOf("z", z.id))),
        markers: d.markers.filter((m) => !set.has(keyOf("m", m.id))),
      };
    });
    setSel([]);
    setActiveVertex(null);
  }

  function rotateSelected(delta: number) {
    apply((d) => rotateKeys(d, sel, delta), "rotate");
  }

  function alignSelected(mode: AlignMode) {
    apply((d) => {
      const keys = pruneSelection(d, sel);
      const boxes = keys.map((k) => boxOfKey(d, k) as Box);
      const deltas = alignDeltas(boxes, mode);
      return keys.reduce((acc, k, i) => translateKeys(acc, [k], deltas[i].x, deltas[i].y), d);
    });
  }

  function distributeSelected(axis: "x" | "y") {
    apply((d) => {
      const keys = pruneSelection(d, sel);
      const boxes = keys.map((k) => boxOfKey(d, k) as Box);
      const deltas = distributeDeltas(boxes, axis);
      return keys.reduce((acc, k, i) => translateKeys(acc, [k], deltas[i].x, deltas[i].y), d);
    });
  }

  const singleZone =
    sel.length === 1 && sel[0][0] === "z"
      ? (doc.zones.find((z) => z.id === sel[0].slice(2)) ?? null)
      : null;
  const vertexIndex =
    singleZone && activeVertex !== null && activeVertex < singleZone.points.length ? activeVertex : null;

  function addVertexToZone() {
    if (!singleZone) return;
    const edge = vertexIndex ?? longestEdge(singleZone.points);
    const res = insertVertex(singleZone.points, edge);
    if (!res) {
      setNotice(t("limitReached"));
      return;
    }
    apply((d) => withZonePoints(d, singleZone.id, res.points));
    setActiveVertex(res.index);
  }

  function removeVertexFromZone() {
    if (!singleZone || vertexIndex === null) return;
    const next = removeVertex(singleZone.points, vertexIndex);
    if (!next) return;
    apply((d) => withZonePoints(d, singleZone.id, next));
    setActiveVertex(null);
  }

  const inspectorActions: InspectorActions = {
    patchTable: (id, patch, tag) =>
      apply((d) => {
        const tb = d.tables[id];
        return tb ? { ...d, tables: { ...d.tables, [id]: { ...tb, ...patch } } } : d;
      }, tag),
    patchPlacement: (id, patch, tag) =>
      apply((d) => {
        const tb = d.tables[id];
        if (!tb?.placement) return d;
        const placement = sanitizePlacement({ ...tb.placement, ...patch });
        return placement ? { ...d, tables: { ...d.tables, [id]: { ...tb, placement } } } : d;
      }, tag),
    setTableShape: (id, shape) =>
      apply((d) => {
        const tb = d.tables[id];
        if (!tb?.placement || tb.shape === shape) return d;
        // Otra forma, otras proporciones: se parte del tamaño típico.
        const s = defaultTableSize(shape, tb.capacity);
        return {
          ...d,
          tables: { ...d.tables, [id]: { ...tb, shape, placement: { ...tb.placement, ...s } } },
        };
      }),
    patchMarker: (id, patch, tag) =>
      apply((d) => {
        const cur = d.markers.find((m) => m.id === id);
        if (!cur) return d;
        let next: Marker = { ...cur, ...patch };
        // Cambiar el tipo trae el tamaño típico del nuevo (una pared no mide como un baño).
        if (patch.kind && patch.kind !== cur.kind) {
          next = { ...next, w: MARKER_KINDS[patch.kind].w, h: MARKER_KINDS[patch.kind].h };
        }
        const clean = sanitizeScene({ zones: [], markers: [next] }).markers[0];
        return clean ? { ...d, markers: d.markers.map((m) => (m.id === id ? clean : m)) } : d;
      }, tag),
    patchZone: (id, patch, tag) =>
      apply((d) => ({ ...d, zones: d.zones.map((z) => (z.id === id ? { ...z, ...patch } : z)) }), tag),
    rotate: rotateSelected,
    duplicate: () => void duplicate(),
    remove: removeSelected,
    align: alignSelected,
    distribute: distributeSelected,
    zoneBool: (op) => {
      if (!singleZone) return;
      setTool(
        tool.type === "bool" && tool.op === op ? SELECT : { type: "bool", zoneId: singleZone.id, op },
      );
    },
    addVertex: addVertexToZone,
    removeVertex: removeVertexFromZone,
    deselect: () => setSel([]),
  };

  /* ───────────────────────── guardar ──────────────────────────── */

  const draftKey = `mesapay.floorPlanDraft.${restaurantId}`;
  const [fingerprint] = useState(() => hashString(JSON.stringify(buildDoc(initialTables, initialScene))));

  async function save() {
    if (status === "saving") return;
    const snapshot = doc;
    setStatus("saving");
    let ok = false;
    try {
      const res = await fetch("/api/operator/settings/floor-plan", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          version: 2,
          tables: metas.flatMap((m) => {
            const tb = snapshot.tables[m.id];
            return tb
              ? [{ id: m.id, shape: tb.shape, capacity: tb.capacity, label: tb.label, placement: tb.placement }]
              : [];
          }),
          scene: { zones: snapshot.zones, markers: snapshot.markers },
        }),
      });
      ok = res.ok;
    } catch {
      ok = false;
    }
    if (!ok) {
      setStatus("error");
      return;
    }
    setHist((h) => ({ ...h, saved: snapshot }));
    setStatus("saved");
    try {
      window.localStorage.removeItem(draftKey);
    } catch {
      /* almacenamiento no disponible */
    }
  }

  // Borrador local: si la pestaña se cierra, se cae o se vuelve con «Atrás»,
  // los cambios sin guardar se pueden recuperar al reabrir el editor.
  useEffect(() => {
    const id = window.setTimeout(() => {
      try {
        if (dirty) {
          window.localStorage.setItem(
            draftKey,
            JSON.stringify({ v: 1, at: Date.now(), base: fingerprint, doc }),
          );
        } else {
          const raw = window.localStorage.getItem(draftKey);
          // No borrar un borrador pendiente de respuesta (oferta visible).
          if (raw && !draftOffer) window.localStorage.removeItem(draftKey);
        }
      } catch {
        /* almacenamiento lleno o bloqueado: el aviso al salir sigue protegiendo */
      }
    }, 500);
    return () => window.clearTimeout(id);
  }, [dirty, doc, draftKey, fingerprint, draftOffer]);

  useEffect(() => {
    let raw: string | null = null;
    try {
      raw = window.localStorage.getItem(draftKey);
    } catch {
      return;
    }
    if (!raw) return;
    let parsed: { v?: number; at?: number; base?: string; doc?: unknown } | null = null;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = null;
    }
    // Solo se ofrece si el plano del servidor es el mismo sobre el que se
    // hizo el borrador; si alguien guardó otra cosa después, se descarta.
    if (!parsed || parsed.v !== 1 || parsed.base !== fingerprint || typeof parsed.at !== "number") {
      try {
        window.localStorage.removeItem(draftKey);
      } catch {
        /* nada */
      }
      return;
    }
    const base = buildDoc(initialTables, initialScene);
    const restored = restoreDraft(parsed.doc, base);
    const at = parsed.at;
    if (restored) queueMicrotask(() => setDraftOffer({ at, doc: restored }));
    // Solo al montar: el borrador se lee una vez.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ───────────────────────── teclado ──────────────────────────── */

  const onKeyRef = useRef<(e: KeyboardEvent) => void>(() => {});
  useEffect(() => {
    onKeyRef.current = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target)) return;
      const active = document.activeElement;
      const inEditor = !active || active === document.body || !!rootRef.current?.contains(active);
      if (!inEditor) return;
      const mod = e.metaKey || e.ctrlKey;
      const k = e.key.toLowerCase();
      if (mod && k === "z") {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
        return;
      }
      if (mod && k === "y") {
        e.preventDefault();
        redo();
        return;
      }
      if (mod && k === "s") {
        e.preventDefault();
        if (dirty) void save();
        return;
      }
      if (e.key === "Escape") {
        if (menu) setMenu(null);
        else if (tool.type !== "select") setTool(SELECT);
        else if (multi) setMulti(false);
        else setSel([]);
        return;
      }
      // Lo que sigue actúa sobre el plano. Los campos de texto ya se
      // descartaron arriba; un menú abierto se queda con sus teclas.
      if (menu) return;
      if (mod && k === "a") {
        e.preventDefault();
        setSel([
          ...canvasTables.map((c) => keyOf("t", c.id)),
          ...doc.markers.map((m) => keyOf("m", m.id)),
        ]);
        return;
      }
      if (sel.length === 0) return;
      if (mod && k === "d") {
        e.preventDefault();
        void duplicate();
        return;
      }
      if (mod) return;
      if (e.key.startsWith("Arrow")) {
        e.preventDefault();
        const step = e.shiftKey ? NUDGE_BIG : NUDGE;
        const dx = e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0;
        const dy = e.key === "ArrowUp" ? -step : e.key === "ArrowDown" ? step : 0;
        apply((d) => translateKeys(d, sel, dx, dy), "nudge");
        return;
      }
      if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        if (singleZone && vertexIndex !== null && singleZone.points.length > 3) removeVertexFromZone();
        else removeSelected();
        return;
      }
      if (k === "r") {
        e.preventDefault();
        rotateSelected(e.shiftKey ? 45 : 15);
      }
    };
  });
  useEffect(() => {
    const handler = (e: KeyboardEvent) => onKeyRef.current(e);
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  // Cerrar el menú de herramientas al tocar fuera.
  useEffect(() => {
    if (!menu) return;
    const close = (e: PointerEvent) => {
      const el = e.target as Element | null;
      if (!el?.closest?.("[data-fp-menu]")) setMenu(null);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [menu]);

  /* ─────────────────── bandeja de mesas sin ubicar ────────────── */

  // La ficha de la bandeja DESAPARECE apenas la mesa entra al plano (ya no
  // está «sin ubicar»), así que el arrastre no puede depender de eventos de
  // la ficha: se sigue con listeners en `window`, que llaman siempre a la
  // versión más reciente de los handlers (cámara y documento al día).
  const trayHandlers = useRef<{ move: (e: PointerEvent) => void; up: () => void }>({
    move: () => {},
    up: () => {},
  });

  function onTrayDown(e: React.PointerEvent<HTMLButtonElement>, id: string) {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    e.preventDefault();
    if (!camState) setCam(cam);
    trayDrag.current = { id, base: doc, startX: e.clientX, startY: e.clientY, moved: false, over: false };
    const pointerId = e.pointerId;
    const move = (ev: PointerEvent) => {
      if (ev.pointerId === pointerId) trayHandlers.current.move(ev);
    };
    const up = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      trayHandlers.current.up();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  }

  function onTrayMove(e: PointerEvent) {
    const d = trayDrag.current;
    if (!d) return;
    if (!d.moved) {
      if (Math.hypot(e.clientX - d.startX, e.clientY - d.startY) < 6) return;
      d.moved = true;
      setGesturing(true);
    }
    const tb = d.base.tables[d.id];
    if (!tb) return;
    const over = overCanvas(e.clientX, e.clientY);
    d.over = over;
    if (!over) {
      preview(d.base);
      setGuides([]);
      setTrayGhost({ id: d.id, x: e.clientX, y: e.clientY });
      return;
    }
    setTrayGhost(null);
    const s = defaultTableSize(tb.shape, tb.capacity);
    const world = clientToWorld(e.clientX, e.clientY);
    const box = { x: world.x - s.w / 2, y: world.y - s.h / 2, w: s.w, h: s.h };
    const opts = snapOpts(e.altKey);
    let dx = 0;
    let dy = 0;
    if (opts.threshold > 0 || opts.grid) {
      const sn = snapMove(box, othersFor(d.base, [keyOf("t", d.id)]), opts);
      dx = sn.dx;
      dy = sn.dy;
      setGuides(sn.guides);
    }
    const placement = sanitizePlacement({ x: world.x + dx, y: world.y + dy, ...s, rotation: 0 });
    if (!placement) return;
    preview({ ...d.base, tables: { ...d.base.tables, [d.id]: { ...tb, placement } } });
  }

  function onTrayUp() {
    const d = trayDrag.current;
    trayDrag.current = null;
    setTrayGhost(null);
    setGuides([]);
    setGesturing(false);
    if (!d) return;
    if (!d.moved) {
      // Toque o Enter: va al centro de lo que se está viendo.
      placeTable(d.id, viewCenter());
      return;
    }
    if (d.over) {
      commitFrom(d.base);
      setSel([keyOf("t", d.id)]);
    } else {
      preview(d.base);
    }
  }

  useEffect(() => {
    trayHandlers.current = { move: onTrayMove, up: onTrayUp };
  });

  /* ───────────────────────── dibujo ───────────────────────────── */

  const isEmpty = canvasTables.length === 0 && doc.zones.length === 0 && doc.markers.length === 0;
  const barUnits = scaleBarUnits(cam.scale);
  const toolHint =
    tool.type === "zone"
      ? t("hintZone", { kind: tf(`zoneKind.${tool.kind}`) })
      : tool.type === "marker"
        ? tool.kind === "pared"
          ? t("hintWall")
          : t("hintMarker", { kind: tf(`markerKind.${tool.kind}`) })
        : tool.type === "bool"
          ? t(tool.op === "add" ? "hintBoolAdd" : "hintBoolCut")
          : multi
            ? t("hintMulti")
            : null;
  const statusText =
    status === "saving"
      ? t("saving")
      : status === "error"
        ? t("statusError")
        : dirty
          ? t("statusDirty")
          : status === "saved"
            ? t("statusSaved")
            : t("statusClean");
  const statusTone = status === "error" ? "error" : dirty ? "dirty" : "ok";
  const cursor =
    tool.type !== "select" ? "crosshair" : gesturing ? "grabbing" : multi ? "crosshair" : "grab";

  return (
    <div ref={rootRef} className="fp-editor">
      {draftOffer && (
        <div role="status" className="fp-note fp-note--info mb-3 flex flex-wrap items-center gap-x-3 gap-y-2">
          <span className="min-w-0 flex-1">
            {t("draftFound", {
              when: formatDate(draftOffer.at, { locale, dateStyle: "short", timeStyle: "short", timeZone: undefined }),
            })}
          </span>
          <span className="flex gap-2">
            <button
              type="button"
              className="mp-btn mp-btn--primary mp-btn--sm"
              onClick={() => {
                const restored = draftOffer.doc;
                apply(() => restored);
                setDraftOffer(null);
                setCam(null);
              }}
            >
              {t("draftRestore")}
            </button>
            <button
              type="button"
              className="mp-btn mp-btn--ghost mp-btn--sm"
              onClick={() => {
                setDraftOffer(null);
                try {
                  window.localStorage.removeItem(draftKey);
                } catch {
                  /* nada */
                }
              }}
            >
              {t("draftDiscard")}
            </button>
          </span>
        </div>
      )}

      <div className="fp-layout">
        <div className="min-w-0">
          {/* Barra de herramientas + guardar */}
          <div className="fp-barwrap">
          <div className="fp-bar">
            <div className="fp-toolbar" role="toolbar" aria-label={t("toolsLabel")}>
              <ToolButton
                icon="select"
                label={t("toolSelect")}
                text={t("toolSelectShort")}
                active={tool.type === "select" && !multi}
                onClick={() => {
                  setTool(SELECT);
                  setMulti(false);
                }}
              />
              <div className="relative" data-fp-menu>
                <ToolButton
                  icon="zone"
                  label={t("zoneMenuTitle")}
                  text={t("toolZone")}
                  active={tool.type === "zone"}
                  expanded={menu === "zone"}
                  onClick={() => setMenu(menu === "zone" ? null : "zone")}
                />
                {menu === "zone" && (
                  <div role="menu" aria-label={t("zoneMenuTitle")} className="fp-menu">
                    {ZONE_KIND_LIST.map((k) => (
                      <button
                        key={k}
                        type="button"
                        role="menuitem"
                        className="fp-menu__item"
                        onClick={() => {
                          setTool({ type: "zone", kind: k });
                          setMulti(false);
                          setMenu(null);
                        }}
                      >
                        <span
                          aria-hidden
                          className="h-5 w-5 shrink-0 rounded border"
                          style={{ background: ZONE_KINDS[k].fill, borderColor: ZONE_KINDS[k].stroke }}
                        />
                        {tf(`zoneKind.${k}`)}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <div className="relative" data-fp-menu>
                <ToolButton
                  icon="element"
                  label={t("elementMenuTitle")}
                  text={t("toolElement")}
                  active={tool.type === "marker"}
                  expanded={menu === "marker"}
                  onClick={() => setMenu(menu === "marker" ? null : "marker")}
                />
                {menu === "marker" && (
                  <div role="menu" aria-label={t("elementMenuTitle")} className="fp-menu">
                    {MARKER_KIND_LIST.map((k) => (
                      <button
                        key={k}
                        type="button"
                        role="menuitem"
                        className="fp-menu__item"
                        onClick={() => {
                          setTool({ type: "marker", kind: k });
                          setMulti(false);
                          setMenu(null);
                        }}
                      >
                        <MarkerGlyph kind={k} size={20} className="shrink-0 text-op-muted" />
                        {tf(`markerKind.${k}`)}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <span className="fp-toolbar__sep" aria-hidden />
              <ToolButton
                icon="magnet"
                label={t("magnetHint")}
                text={t("magnet")}
                pressed={magnet}
                onClick={() => setMagnet((v) => !v)}
              />
              <ToolButton
                icon="grid"
                label={t("gridHint")}
                text={t("grid")}
                pressed={grid}
                onClick={() => setGrid((v) => !v)}
              />
              <ToolButton
                icon="multi"
                label={t("multiHint")}
                text={t("multi")}
                pressed={multi}
                onClick={() => {
                  setMulti((v) => !v);
                  setTool(SELECT);
                }}
              />
            </div>

            <div className="fp-savebar">
              <span role="status" aria-live="polite" className={`fp-status fp-status--${statusTone}`}>
                <span className="fp-status__dot" aria-hidden />
                {statusText}
              </span>
              <button
                type="button"
                className="fp-iconbtn"
                onClick={undo}
                disabled={hist.past.length === 0}
                aria-label={t("undo")}
                title={t("undo")}
              >
                <Glyph name="undo" size={20} />
              </button>
              <button
                type="button"
                className="fp-iconbtn"
                onClick={redo}
                disabled={hist.future.length === 0}
                aria-label={t("redo")}
                title={t("redo")}
              >
                <Glyph name="redo" size={20} />
              </button>
              <button
                type="button"
                onClick={() => void save()}
                disabled={!dirty || status === "saving"}
                className="mp-btn mp-btn--primary mp-btn--sm"
              >
                {status === "saving" ? t("saving") : t("save")}
              </button>
            </div>
          </div>
          </div>

          {notice && (
            <p role="alert" className="fp-note fp-note--warn mb-2">
              {notice}
            </p>
          )}

          {/* Lienzo */}
          <div ref={wrapRef} className="fp-stage">
            {size.w > 0 && size.h > 0 && (
              <FloorPlanCanvas
                svgRef={svgRef}
                scene={scene}
                tables={canvasTables}
                view={view}
                pxPerUnit={cam.scale}
                tableState={tableState}
                onTableKeyFocus={selectTableByKeyboard}
                editable
                selectedZoneIds={selectedZoneIds}
                grid={grid ? GRID_STEP : null}
                lattice
                role="application"
                tabIndex={0}
                aria-label={t("canvasLabel")}
                width={size.w}
                height={size.h}
                style={{ cursor, touchAction: "none" }}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onPointerCancel={onPointerCancel}
                onDoubleClick={(e) => {
                  // Doble clic en un vértice lo quita; en un lado, agrega uno.
                  const el = (e.target as Element).closest?.("[data-fp='handle']");
                  const h = el?.getAttribute("data-h") ?? "";
                  if (!singleZone) return;
                  if (h.startsWith("v:")) {
                    const next = removeVertex(singleZone.points, Number(h.slice(2)));
                    if (next) apply((d) => withZonePoints(d, singleZone.id, next));
                    setActiveVertex(null);
                  } else if (h.startsWith("e:")) {
                    const res = insertVertex(singleZone.points, Number(h.slice(2)));
                    if (res) {
                      apply((d) => withZonePoints(d, singleZone.id, res.points));
                      setActiveVertex(res.index);
                    }
                  }
                }}
              >
                <EditorOverlay
                  doc={doc}
                  sel={sel}
                  pxPerUnit={cam.scale}
                  coarse={coarse}
                  guides={guides}
                  draft={draft}
                  activeVertex={vertexIndex}
                  showHandles={tool.type === "select" && !multi}
                />
              </FloorPlanCanvas>
            )}

            {toolHint && (
              <div className="fp-hint" role="status">
                <span>{toolHint}</span>
                <button
                  type="button"
                  className="fp-hint__cancel"
                  onClick={() => {
                    setTool(SELECT);
                    setMulti(false);
                  }}
                >
                  {t("cancelTool")}
                </button>
              </div>
            )}

            {/* Acciones rápidas de la selección (pantallas angostas: el panel queda abajo). */}
            {!toolHint && sel.length > 0 && !gesturing && (
              <div className="fp-quick" role="toolbar" aria-label={t("quickLabel")}>
                {!sel.some((k) => k[0] === "z") && (
                  <>
                    <QuickButton icon="rotateCcw" label={t("rotateLeft")} onClick={() => rotateSelected(-15)} />
                    <QuickButton icon="rotateCw" label={t("rotateRight")} onClick={() => rotateSelected(15)} />
                  </>
                )}
                <QuickButton icon="duplicate" label={t("duplicate")} onClick={() => void duplicate()} />
                <QuickButton
                  icon={sel.every((k) => k[0] === "t") ? "unplace" : "trash"}
                  label={sel.every((k) => k[0] === "t") ? t("removeFromPlan") : t("delete")}
                  onClick={removeSelected}
                />
                <button
                  type="button"
                  className="fp-quick__more"
                  onClick={() => inspectorRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })}
                >
                  {t("quickMore")}
                </button>
              </div>
            )}

            {isEmpty && tool.type === "select" && (
              <div className="fp-empty">
                <div className="fp-empty__card">
                  <h2 className="font-display text-2xl leading-tight">{t("emptyTitle")}</h2>
                  <p className="mt-2 text-sm text-op-muted leading-relaxed">{t("emptyBody")}</p>
                  <div className="mt-4 flex flex-wrap justify-center gap-2">
                    <button
                      type="button"
                      className="mp-btn mp-btn--primary mp-btn--sm"
                      onClick={() => setTool({ type: "zone", kind: "interior" })}
                    >
                      <Glyph name="zone" size={16} />
                      {t("emptyDrawZone")}
                    </button>
                    {unplaced.length > 0 && (
                      <button type="button" className="mp-btn mp-btn--secondary mp-btn--sm" onClick={placeAll}>
                        <Glyph name="rows" size={16} />
                        {t("emptyPlaceTables", { count: unplaced.length })}
                      </button>
                    )}
                  </div>
                </div>
              </div>
            )}

            {readout && (
              <div className="fp-readout" style={{ left: readout.x, top: readout.y }} aria-hidden>
                {readout.text}
              </div>
            )}

            <div className="fp-scale" aria-hidden>
              <span className="fp-scale__bar" style={{ width: barUnits * cam.scale }} />
              <span>{t("scaleBar", { value: formatNumber(barUnits, { locale, maximumFractionDigits: 1 }) })}</span>
            </div>

            <div className="fp-zoom" role="group" aria-label={t("zoomLabel")}>
              <button type="button" className="fp-zoom__btn" onClick={() => zoomAt(1 / 1.25)} aria-label={t("zoomOut")} title={t("zoomOut")}>
                <Glyph name="minus" size={18} />
              </button>
              <span className="fp-zoom__level" aria-live="off">
                {t("zoomLevel", { percent: Math.round((cam.scale / 48) * 100) })}
              </span>
              <button type="button" className="fp-zoom__btn" onClick={() => zoomAt(1.25)} aria-label={t("zoomIn")} title={t("zoomIn")}>
                <Glyph name="plus" size={18} />
              </button>
              <button type="button" className="fp-zoom__btn" onClick={() => setCam(null)} aria-label={t("fit")} title={t("fit")}>
                <Glyph name="fit" size={18} />
              </button>
            </div>
          </div>
        </div>

        {/* Panel lateral: propiedades, bandeja y listas */}
        <aside className="fp-side">
          <div ref={inspectorRef} className="scroll-mt-4">
            <Inspector
              doc={doc}
              metas={metas}
              sel={sel}
              overlaps={overlaps}
              activeVertex={vertexIndex}
              boolTool={tool.type === "bool" ? tool.op : null}
              busy={busy}
              actions={inspectorActions}
            />
          </div>

          <section className="fp-panel" aria-label={t("trayHeading")}>
            <header className="flex items-baseline justify-between gap-2">
              <h2 className="text-sm font-semibold">
                {t("trayHeading")}{" "}
                <span className="font-mono text-xs font-normal text-op-muted tabular-nums">
                  {t("trayCount", { count: unplaced.length })}
                </span>
              </h2>
            </header>
            {unplaced.length > 0 ? (
              <>
                <p className="mt-1 text-xs text-op-muted">{t("trayHint")}</p>
                <div className="mt-3 flex flex-wrap gap-2">
                  {unplaced.map((m) => {
                    const tb = doc.tables[m.id];
                    return (
                      <button
                        key={m.id}
                        type="button"
                        className="fp-chip"
                        style={{ touchAction: "none" }}
                        onPointerDown={(e) => onTrayDown(e, m.id)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            placeTable(m.id, viewCenter());
                          }
                        }}
                        aria-label={t("trayPlaceOne", { number: m.number })}
                      >
                        <span className="font-display text-lg leading-none">{m.number}</span>
                        <span className="font-mono text-[11px] text-op-muted">
                          {tf("seats", { count: tb.capacity })}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </>
            ) : (
              <p className="mt-1 text-xs text-op-muted">
                {metas.length === 0 ? t("trayNoTables") : t("trayEmpty")}
              </p>
            )}
            <div className="mt-3 flex flex-wrap gap-2">
              {unplaced.length > 1 && (
                <button type="button" className="mp-btn mp-btn--secondary mp-btn--sm" onClick={placeAll}>
                  <Glyph name="rows" size={16} />
                  {t("trayPlaceAll")}
                </button>
              )}
              <button
                type="button"
                className="mp-btn mp-btn--secondary mp-btn--sm"
                aria-expanded={newOpen}
                onClick={() => setNewOpen((v) => !v)}
              >
                <Glyph name="plus" size={16} />
                {t("newTable")}
              </button>
            </div>
            {newOpen && (
              <NewTableInline
                suggested={nextTableNumber()}
                onCancel={() => setNewOpen(false)}
                onCreate={async (input) => {
                  const res = await createTable(input);
                  if ("error" in res) return res.error;
                  setNewOpen(false);
                  placeTable(res.id, viewCenter());
                  return null;
                }}
              />
            )}
          </section>

          {(doc.zones.length > 0 || doc.markers.length > 0) && (
            <section className="fp-panel" aria-label={t("listHeading")}>
              <h2 className="text-sm font-semibold">{t("listHeading")}</h2>
              <div className="mt-3 flex flex-wrap gap-2">
                {doc.zones.map((z) => {
                  const c = ZONE_KINDS[z.kind];
                  const key = keyOf("z", z.id);
                  return (
                    <button
                      key={z.id}
                      type="button"
                      className="fp-chip fp-chip--list"
                      aria-pressed={selSet.has(key)}
                      onClick={() => {
                        setSel([key]);
                        setTool(SELECT);
                      }}
                    >
                      <span aria-hidden className="h-3.5 w-3.5 rounded-sm border" style={{ background: c.fill, borderColor: c.stroke }} />
                      {z.label || tf(`zoneKind.${z.kind}`)}
                    </button>
                  );
                })}
                {doc.markers.map((m) => {
                  const key = keyOf("m", m.id);
                  return (
                    <button
                      key={m.id}
                      type="button"
                      className="fp-chip fp-chip--list"
                      aria-pressed={selSet.has(key)}
                      onClick={() => {
                        setSel([key]);
                        setTool(SELECT);
                      }}
                    >
                      <MarkerGlyph kind={m.kind} size={16} className="text-op-muted" />
                      {m.label ?? tf(`markerKind.${m.kind}`)}
                    </button>
                  );
                })}
              </div>
            </section>
          )}

          <details className="fp-panel fp-shortcuts">
            <summary className="cursor-pointer text-sm font-semibold">{t("shortcutsTitle")}</summary>
            <ul className="mt-3 space-y-1.5 text-xs text-op-muted">
              <li>{t("shortcutMove")}</li>
              <li>{t("shortcutRotate")}</li>
              <li>{t("shortcutDuplicate")}</li>
              <li>{t("shortcutRemove")}</li>
              <li>{t("shortcutUndo")}</li>
              <li>{t("shortcutZoom")}</li>
              <li>{t("shortcutAlt")}</li>
            </ul>
          </details>

          <p className="px-1 text-xs text-op-muted leading-relaxed">
            {t("tipPre")}
            <Link href="/operator/settings/mesas" className="text-terracotta underline-offset-2 hover:underline">
              {t("tipLink")}
            </Link>
            {t("tipPost")}
          </p>
        </aside>
      </div>

      {trayGhost && (
        <div className="fp-ghost" style={{ left: trayGhost.x, top: trayGhost.y }} aria-hidden>
          {metaById.get(trayGhost.id)?.number}
        </div>
      )}
    </div>
  );
}

/** Reconstruye un borrador local validando cada dato (viene de localStorage). */
function restoreDraft(raw: unknown, base: Doc): Doc | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as { tables?: unknown; zones?: unknown; markers?: unknown };
  const scene = sanitizeScene({ zones: o.zones, markers: o.markers });
  const tables: Doc["tables"] = {};
  const src = (o.tables && typeof o.tables === "object" ? o.tables : {}) as Record<string, unknown>;
  for (const [id, cur] of Object.entries(base.tables)) {
    const d = src[id] as Partial<DocTable> | undefined;
    if (!d || typeof d !== "object") {
      tables[id] = cur;
      continue;
    }
    const shape: TableShape =
      d.shape === "square" || d.shape === "round" || d.shape === "bar" ? d.shape : cur.shape;
    const capacity =
      typeof d.capacity === "number" && Number.isFinite(d.capacity)
        ? clamp(Math.round(d.capacity), 1, 40)
        : cur.capacity;
    const label = typeof d.label === "string" ? d.label.slice(0, 40) || null : null;
    tables[id] = { shape, capacity, label, placement: sanitizePlacement(d.placement) };
  }
  return { tables, zones: scene.zones, markers: scene.markers };
}

function ToolButton({
  icon,
  label,
  text,
  active,
  pressed,
  expanded,
  onClick,
}: {
  icon: UiGlyph;
  label: string;
  text: string;
  active?: boolean;
  pressed?: boolean;
  expanded?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="fp-tool"
      data-active={active || pressed || undefined}
      aria-pressed={pressed === undefined ? active : pressed}
      aria-haspopup={expanded === undefined ? undefined : "menu"}
      aria-expanded={expanded}
      aria-label={label}
      title={label}
      onClick={onClick}
    >
      <Glyph name={icon} size={20} />
      <span className="fp-tool__text">{text}</span>
    </button>
  );
}

function QuickButton({ icon, label, onClick }: { icon: UiGlyph; label: string; onClick: () => void }) {
  return (
    <button type="button" className="fp-quick__btn" onClick={onClick} aria-label={label} title={label}>
      <Glyph name={icon} size={20} />
    </button>
  );
}

function NewTableInline({
  suggested,
  onCreate,
  onCancel,
}: {
  suggested: number;
  onCreate: (input: { number: number; capacity: number; shape: TableShape }) => Promise<"taken" | "failed" | null>;
  onCancel: () => void;
}) {
  const t = useTranslations("opSalon");
  const [number, setNumber] = useState(String(suggested));
  const [capacity, setCapacity] = useState("4");
  const [shape, setShape] = useState<TableShape>("square");
  const [err, setErr] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const n = Number(number);
    const c = Number(capacity);
    if (!Number.isInteger(n) || n < 1 || n > 999) {
      setErr(t("newTableInvalid"));
      return;
    }
    if (!Number.isInteger(c) || c < 1 || c > 40) {
      setErr(t("newTableInvalidCapacity"));
      return;
    }
    setErr(null);
    setCreating(true);
    const res = await onCreate({ number: n, capacity: c, shape });
    setCreating(false);
    if (res) setErr(t(res === "taken" ? "newTableTaken" : "newTableFailed"));
  }

  return (
    <form onSubmit={submit} className="mt-3 space-y-3 rounded-xl border border-op-border bg-op-bg p-3">
      <div className="grid grid-cols-2 gap-3">
        <label className="block">
          <span className="mb-1.5 block text-xs font-medium text-op-muted">{t("newTableNumber")}</span>
          <input
            type="number"
            inputMode="numeric"
            min={1}
            max={999}
            value={number}
            onChange={(e) => setNumber(e.target.value)}
            className="fp-input w-full"
            autoFocus
          />
        </label>
        <label className="block">
          <span className="mb-1.5 block text-xs font-medium text-op-muted">{t("fieldCapacity")}</span>
          <input
            type="number"
            inputMode="numeric"
            min={1}
            max={40}
            value={capacity}
            onChange={(e) => setCapacity(e.target.value)}
            className="fp-input w-full"
          />
        </label>
      </div>
      <div className="mp-seg fp-seg w-full" role="radiogroup" aria-label={t("fieldShape")}>
        {(["square", "round", "bar"] as const).map((s) => (
          <button
            key={s}
            type="button"
            role="radio"
            aria-checked={shape === s}
            data-active={shape === s}
            onClick={() => setShape(s)}
            className="mp-seg__i flex-1 justify-center"
          >
            {t(s === "square" ? "shapeSquare" : s === "round" ? "shapeRound" : "shapeBar")}
          </button>
        ))}
      </div>
      {err && (
        <p role="alert" className="text-xs text-danger">
          {err}
        </p>
      )}
      <p className="text-xs text-op-muted">{t("newTableNote")}</p>
      <div className="flex gap-2">
        <button type="submit" disabled={creating} className="mp-btn mp-btn--primary mp-btn--sm">
          {creating ? t("newTableCreating") : t("newTableCreate")}
        </button>
        <button type="button" onClick={onCancel} className="mp-btn mp-btn--ghost mp-btn--sm">
          {t("cancelTool")}
        </button>
      </div>
    </form>
  );
}
