/**
 * Trazos de los íconos del plano. Todos en una retícula de 24×24, solo
 * líneas (sin relleno), para dibujarse igual dentro del SVG del plano y
 * en los botones del editor. Sin emojis: se ven distinto en cada sistema
 * y no heredan el color del tema.
 */
import type { MarkerKind } from "@/lib/floorPlan";

/** Íconos de los elementos del local que llevan ícono. */
export const MARKER_GLYPHS: Partial<Record<MarkerKind, string[]>> = {
  entrada: [
    "M6 21V4.5A1.5 1.5 0 0 1 7.5 3h9A1.5 1.5 0 0 1 18 4.5V21",
    "M3 21h18",
    "M14.5 12.5v.01",
  ],
  banos: [
    "M8 6.2a1.6 1.6 0 1 0 0-3.2 1.6 1.6 0 0 0 0 3.2Z",
    "M6 9h4l1.6 6.5H9.8V21H6.2v-5.5H4.4L6 9Z",
    "M16.5 6.2a1.6 1.6 0 1 0 0-3.2 1.6 1.6 0 0 0 0 3.2Z",
    "M14.2 9h4.6v6.5h-1.1V21h-2.4v-5.5h-1.1V9Z",
  ],
  barra: ["M5 4h14l-7 8.5L5 4Z", "M12 12.5V20", "M8 20h8", "M7.5 7h9"],
  escaleras: ["M3.5 20h4.2v-4.2h4.2v-4.2h4.2V7.4h4.4"],
  cocina: [
    "M5 11h14v5.5a3.5 3.5 0 0 1-3.5 3.5h-7A3.5 3.5 0 0 1 5 16.5V11Z",
    "M2.5 11h19",
    "M9.5 7.5c0-1.6 1.2-1.6 1.2-3.2",
    "M13.8 7.5c0-1.6 1.2-1.6 1.2-3.2",
  ],
  planta: [
    "M12 21v-8.5",
    "M12 12.5c0-4.2 2.8-6.5 7-6.5 0 4.2-2.8 6.5-7 6.5Z",
    "M12 15c0-3.2-2.2-5-5.8-5 0 3.2 2.2 5 5.8 5Z",
  ],
};

/** Íconos de la interfaz del editor (barra de herramientas, panel). */
export const UI_GLYPHS = {
  select: ["M5.5 3.5l13 7.4-5.6 1.7-1.8 5.6-5.6-14.7Z"],
  zone: ["M4 5h9l7 5.5V19H4V5Z"],
  element: [
    "M12 21s6.5-5.4 6.5-10.5a6.5 6.5 0 1 0-13 0C5.5 15.6 12 21 12 21Z",
    "M12 12.8a2.3 2.3 0 1 0 0-4.6 2.3 2.3 0 0 0 0 4.6Z",
  ],
  table: ["M4 9h16", "M6 9v9", "M18 9v9", "M4 9l1.5-3h13L20 9"],
  magnet: [
    "M6 4v8a6 6 0 0 0 12 0V4h-4v8a2 2 0 0 1-4 0V4H6Z",
    "M6 8h4",
    "M14 8h4",
  ],
  grid: ["M4 4h16v16H4V4Z", "M4 9.3h16", "M4 14.7h16", "M9.3 4v16", "M14.7 4v16"],
  multi: [
    "M4 8V4h4",
    "M16 4h4v4",
    "M20 16v4h-4",
    "M8 20H4v-4",
    "M9 9h6v6H9V9Z",
  ],
  undo: ["M9 14l-5-5 5-5", "M4 9h10a6 6 0 0 1 0 12h-3"],
  redo: ["M15 14l5-5-5-5", "M20 9H10a6 6 0 0 0 0 12h3"],
  fit: ["M4 9V4h5", "M20 9V4h-5", "M4 15v5h5", "M20 15v5h-5"],
  plus: ["M12 5v14", "M5 12h14"],
  minus: ["M5 12h14"],
  duplicate: ["M9 9h11v11H9V9Z", "M5 15H4V4h11v1"],
  trash: ["M4 7h16", "M9 7V4h6v3", "M6.5 7l.9 13h9.2l.9-13", "M10 11v5.5", "M14 11v5.5"],
  unplace: ["M4 20h16", "M12 4v11", "M7.5 10.5 12 15l4.5-4.5"],
  rotateCw: ["M20 12a8 8 0 1 1-2.4-5.7", "M20 4v5h-5"],
  rotateCcw: ["M4 12a8 8 0 1 0 2.4-5.7", "M4 4v5h5"],
  alignLeft: ["M4 4v16", "M8 7h11v3.5H8V7Z", "M8 13.5h7V17H8v-3.5Z"],
  alignCenterX: ["M12 4v16", "M6 7h12v3.5H6V7Z", "M8.5 13.5h7V17h-7v-3.5Z"],
  alignRight: ["M20 4v16", "M5 7h11v3.5H5V7Z", "M9 13.5h7V17H9v-3.5Z"],
  alignTop: ["M4 4h16", "M7 8h3.5v11H7V8Z", "M13.5 8H17v7h-3.5V8Z"],
  alignCenterY: ["M4 12h16", "M7 6h3.5v12H7V6Z", "M13.5 8.5H17v7h-3.5v-7Z"],
  alignBottom: ["M4 20h16", "M7 5h3.5v11H7V5Z", "M13.5 9H17v7h-3.5V9Z"],
  distributeX: ["M4 4v16", "M20 4v16", "M10 7h4v10h-4V7Z"],
  distributeY: ["M4 4h16", "M4 20h16", "M7 10h10v4H7v-4Z"],
  vertexAdd: ["M5 19 19 5", "M12 12h.01", "M17 15v6", "M14 18h6"],
  vertexRemove: ["M5 19 19 5", "M12 12h.01", "M14 18h6"],
  extend: ["M4 10h9v10H4V10Z", "M13 4h7v7", "M16.5 4v7", "M13 7.5h7"],
  cut: ["M4 4h16v16H4V4Z", "M12 4v8h8"],
  check: ["M5 12.5l4.5 4.5L19 7.5"],
  close: ["M6 6l12 12", "M18 6 6 18"],
  hand: ["M12 4v16", "M4 12h16", "M12 4 9.5 6.5", "M12 4l2.5 2.5", "M12 20l-2.5-2.5", "M12 20l2.5-2.5", "M4 12l2.5-2.5", "M4 12l2.5 2.5", "M20 12l-2.5-2.5", "M20 12l-2.5 2.5"],
  rows: ["M4 6h4v4H4V6Z", "M10 6h4v4h-4V6Z", "M16 6h4v4h-4V6Z", "M4 14h4v4H4v-4Z", "M10 14h4v4h-4v-4Z", "M16 14h4v4h-4v-4Z"],
  wall: ["M3 10h18v4H3v-4Z"],
  column: ["M8 8h8v8H8V8Z"],
} as const;

export type UiGlyph = keyof typeof UI_GLYPHS;

/** Ícono de interfaz (24px por defecto), con el color del texto. */
export function Glyph({
  name,
  size = 20,
  className,
}: {
  name: UiGlyph;
  size?: number;
  className?: string;
}) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className={className}
    >
      {UI_GLYPHS[name].map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}

/** Ícono de un elemento del local, para listas y menús del editor. */
export function MarkerGlyph({
  kind,
  size = 20,
  className,
}: {
  kind: MarkerKind;
  size?: number;
  className?: string;
}) {
  const paths =
    MARKER_GLYPHS[kind] ??
    (kind === "pared" ? UI_GLYPHS.wall : kind === "columna" ? UI_GLYPHS.column : []);
  const solid = kind === "pared" || kind === "columna";
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill={solid ? "currentColor" : "none"}
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className={className}
    >
      {paths.map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}
