/**
 * Plano del salón: grilla + zonas + íconos (entrada, baños, barra…).
 *
 * Mismo patrón que reservations.ts / paymentMethods.ts: el restaurante
 * guarda un blob JSON (Restaurant.floorPlan) y este helper lo parsea
 * con defaults sensatos y clamping a los límites de la grilla.
 *
 * IMPORTANTE: este módulo es PURO (no importa db ni nada de server) para
 * que lo puedan usar tanto los Server Components / rutas API como los
 * Client Components (editor del operador y picker del diner). Así el
 * render del plano y los colores/labels de las zonas son idénticos en
 * ambos lados.
 *
 * Sistema de coordenadas: celdas enteras (col x, row y) desde 0. Las
 * zonas son rectángulos {x,y,w,h} en celdas; los markers ocupan 1 celda.
 */

export const FLOOR_MIN_COLS = 4;
export const FLOOR_MAX_COLS = 24;
export const FLOOR_MIN_ROWS = 4;
export const FLOOR_MAX_ROWS = 40;
export const FLOOR_DEFAULT_COLS = 10;
export const FLOOR_DEFAULT_ROWS = 6;

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
  | "cocina";

/** Rectángulo etiquetado dibujado DETRÁS de las mesas. */
export type Zone = {
  id: string;
  kind: ZoneKind;
  label: string;
  x: number;
  y: number;
  w: number;
  h: number;
};

/** Punto de interés de 1 celda (entrada, baños, etc.). */
export type Marker = {
  id: string;
  kind: MarkerKind;
  /** Etiqueta opcional; si null se usa el label por defecto del kind. */
  label: string | null;
  x: number;
  y: number;
};

export type FloorPlan = {
  cols: number;
  rows: number;
  zones: Zone[];
  markers: Marker[];
};

/**
 * Paleta de zonas. Colores en rgba/hex que se ven bien tanto sobre el
 * fondo claro del diner (bone) como sobre el fondo del operador (op-bg).
 * fill = relleno suave, stroke = borde, text = color de la etiqueta.
 */
export const ZONE_KINDS: Record<
  ZoneKind,
  { label: string; fill: string; stroke: string; text: string }
> = {
  interior: {
    label: "Interior",
    fill: "rgba(138,127,114,0.13)",
    stroke: "rgba(138,127,114,0.45)",
    text: "#6b5e52",
  },
  exterior: {
    label: "Exterior",
    fill: "rgba(74,144,184,0.13)",
    stroke: "rgba(74,144,184,0.45)",
    text: "#33688a",
  },
  terraza: {
    label: "Terraza",
    fill: "rgba(201,138,46,0.15)",
    stroke: "rgba(201,138,46,0.45)",
    text: "#8f6828",
  },
  jardin: {
    label: "Jardín",
    fill: "rgba(46,107,76,0.15)",
    stroke: "rgba(46,107,76,0.45)",
    text: "#1e5339",
  },
  barra: {
    label: "Barra",
    fill: "rgba(125,79,156,0.15)",
    stroke: "rgba(125,79,156,0.45)",
    text: "#5d3a78",
  },
  cocina: {
    label: "Cocina",
    fill: "rgba(192,73,46,0.13)",
    stroke: "rgba(192,73,46,0.45)",
    text: "#8f3420",
  },
  banos: {
    label: "Baños",
    fill: "rgba(47,156,147,0.13)",
    stroke: "rgba(47,156,147,0.45)",
    text: "#246b65",
  },
  custom: {
    label: "Zona",
    fill: "rgba(107,114,128,0.13)",
    stroke: "rgba(107,114,128,0.45)",
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

export const MARKER_KINDS: Record<MarkerKind, { label: string; icon: string }> =
  {
    entrada: { label: "Entrada", icon: "🚪" },
    banos: { label: "Baños", icon: "🚻" },
    barra: { label: "Barra", icon: "🍸" },
    escaleras: { label: "Escaleras", icon: "🪜" },
    cocina: { label: "Cocina", icon: "🍳" },
  };

export const MARKER_KIND_LIST: MarkerKind[] = [
  "entrada",
  "banos",
  "barra",
  "escaleras",
  "cocina",
];

export const DEFAULT_FLOOR_PLAN: FloorPlan = {
  cols: FLOOR_DEFAULT_COLS,
  rows: FLOOR_DEFAULT_ROWS,
  zones: [],
  markers: [],
};

function clampInt(n: unknown, min: number, max: number, fallback: number): number {
  if (typeof n !== "number" || !Number.isFinite(n)) return fallback;
  const r = Math.round(n);
  if (r < min) return min;
  if (r > max) return max;
  return r;
}

function isZoneKind(s: unknown): s is ZoneKind {
  return typeof s === "string" && s in ZONE_KINDS;
}
function isMarkerKind(s: unknown): s is MarkerKind {
  return typeof s === "string" && s in MARKER_KINDS;
}

/**
 * Parsea el blob de la DB a un FloorPlan tipado. Clampa todo a la
 * grilla y descarta elementos imposibles. Nunca tira: si algo está
 * corrupto cae al default (grilla vacía) para no romper el editor ni
 * el picker del diner.
 */
export function resolveFloorPlan(stored: unknown): FloorPlan {
  if (!stored || typeof stored !== "object") {
    return { ...DEFAULT_FLOOR_PLAN };
  }
  const o = stored as Record<string, unknown>;

  const cols = clampInt(o.cols, FLOOR_MIN_COLS, FLOOR_MAX_COLS, FLOOR_DEFAULT_COLS);
  const rows = clampInt(o.rows, FLOOR_MIN_ROWS, FLOOR_MAX_ROWS, FLOOR_DEFAULT_ROWS);

  const zones: Zone[] = [];
  if (Array.isArray(o.zones)) {
    o.zones.forEach((raw, i) => {
      if (!raw || typeof raw !== "object") return;
      const z = raw as Record<string, unknown>;
      if (!isZoneKind(z.kind)) return;
      const x = clampInt(z.x, 0, cols - 1, 0);
      const y = clampInt(z.y, 0, rows - 1, 0);
      // Ancho/alto mínimo 1, y que no se salgan de la grilla.
      const w = clampInt(z.w, 1, cols - x, 1);
      const h = clampInt(z.h, 1, rows - y, 1);
      const label =
        typeof z.label === "string" && z.label.trim()
          ? z.label.trim().slice(0, 40)
          : ZONE_KINDS[z.kind].label;
      const id = typeof z.id === "string" && z.id ? z.id : `z${i}`;
      zones.push({ id, kind: z.kind, label, x, y, w, h });
    });
  }

  const markers: Marker[] = [];
  if (Array.isArray(o.markers)) {
    o.markers.forEach((raw, i) => {
      if (!raw || typeof raw !== "object") return;
      const m = raw as Record<string, unknown>;
      if (!isMarkerKind(m.kind)) return;
      const x = clampInt(m.x, 0, cols - 1, 0);
      const y = clampInt(m.y, 0, rows - 1, 0);
      const label =
        typeof m.label === "string" && m.label.trim()
          ? m.label.trim().slice(0, 40)
          : null;
      const id = typeof m.id === "string" && m.id ? m.id : `m${i}`;
      markers.push({ id, kind: m.kind, label, x, y });
    });
  }

  return { cols, rows, zones, markers };
}

/** Label visible de un marker (custom o el del kind). */
export function markerLabel(m: Marker): string {
  return m.label ?? MARKER_KINDS[m.kind].label;
}
