"use client";

import {
  memo,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type Ref,
  type SVGProps,
} from "react";
import { useTranslations } from "next-intl";
import {
  MARKER_KINDS,
  ZONE_KINDS,
  rectBounds,
  sceneBounds,
  seatLayout,
  zoneLabelAnchor,
  type Box,
  type FloorScene,
  type Marker,
  type TablePlacement,
  type TableShape,
  type Zone,
} from "@/lib/floorPlan";
import { MARKER_GLYPHS } from "./glyphs";

/**
 * EL dibujo del plano del salón. Un solo componente SVG para todas las
 * pantallas que lo muestran — el editor del operador, el selector de mesa
 * del comensal y el mapa del Salón — así se ven idénticos.
 *
 * Todo está en unidades del plano; el `viewBox` hace la escala. Lo que
 * debe medir lo mismo en pantalla sin importar el zoom (grosor de línea,
 * tamaño de letra) se calcula con `pxPerUnit`.
 *
 * Solo dibuja. Quien lo usa decide el color de cada mesa (`tableState`),
 * si se puede tocar, y qué se superpone (`children`: guías, manijas…).
 */

export type CanvasTable = {
  id: string;
  number: number;
  label: string | null;
  capacity: number;
  shape: TableShape;
  placement: TablePlacement;
};

/**
 * Colores de una mesa. Usa las mismas referencias entre renders (constantes).
 *
 * Sin color-mix(): estos valores van como atributos del SVG, donde el
 * respaldo para navegadores viejos de postcss no llega (datáfono con
 * Firefox 107, Safari iOS 15.4) y un color inválido pinta NEGRO. Un tinte se
 * escribe como color sólido + opacidad: la mesa se dibuja primero sobre su
 * superficie, así el resultado es el mismo que mezclar con la superficie.
 */
export type TableTone = {
  fill: string;
  /** < 1: tinte sobre la superficie de la mesa. */
  fillOpacity?: number;
  stroke: string;
  strokeOpacity?: number;
  /** Borde en px de pantalla (por defecto 1.5; 2.5 = estado que pide acción). */
  strokeWidth?: number;
  text: string;
  /** Segunda línea en otro color (el monto, como en las tarjetas). */
  subText?: string;
  /** Línea punteada: refuerza «no disponible» sin depender solo del color. */
  dashed?: boolean;
  /** Punto de estado (mapa del Salón). */
  dot?: string;
  pulse?: boolean;
  /** Atenuada (no entra en el filtro activo del Salón), sigue tocable. */
  dim?: boolean;
};

export const TONE_NEUTRAL: TableTone = {
  fill: "var(--fp-surface)",
  stroke: "var(--fp-ink)",
  strokeOpacity: 0.62,
  text: "var(--fp-ink)",
};

export type TableState = {
  tone?: TableTone;
  /** Si viene, la mesa es un botón accesible con este nombre. */
  ariaLabel?: string;
  disabled?: boolean;
  pressed?: boolean;
  /** Aviso de solape (editor). */
  warn?: boolean;
  /** Segunda línea; por defecto, la capacidad. `null` la oculta. */
  sub?: string | null;
  /** Tercera línea, solo si la mesa se ve grande. */
  sub2?: string | null;
};

type CanvasProps = {
  scene: FloorScene;
  tables: CanvasTable[];
  /** Región visible, en unidades del plano. */
  view: Box;
  /** Píxeles de pantalla por unidad (la escala real del SVG). */
  pxPerUnit: number;
  tableState?: (t: CanvasTable) => TableState;
  onTableActivate?: (id: string) => void;
  /** Foco por TECLADO en una mesa (el editor la selecciona). */
  onTableKeyFocus?: (id: string) => void;
  /** Zonas y elementos responden al puntero (solo el editor). */
  editable?: boolean;
  selectedZoneIds?: ReadonlySet<string>;
  /** Paso de la cuadrícula a dibujar, o null. */
  grid?: number | null;
  /** Retícula de puntos cada 1 unidad (fondo del editor). */
  lattice?: boolean;
  svgRef?: Ref<SVGSVGElement>;
  children?: ReactNode;
} & Omit<SVGProps<SVGSVGElement>, "children" | "viewBox" | "ref">;

const SEAT_W = 0.34;
const SEAT_D = 0.09;

export function FloorPlanCanvas({
  scene,
  tables,
  view,
  pxPerUnit,
  tableState,
  onTableActivate,
  onTableKeyFocus,
  editable = false,
  selectedZoneIds,
  grid = null,
  lattice = false,
  svgRef,
  children,
  className,
  ...rest
}: CanvasProps) {
  const t = useTranslations("floorPlan");
  const uid = useId().replace(/[^a-zA-Z0-9]/g, "");
  const px = 1 / pxPerUnit;
  const showMinor = grid != null && grid * pxPerUnit >= 7;

  return (
    <svg
      ref={svgRef}
      viewBox={`${view.x} ${view.y} ${view.w} ${view.h}`}
      className={"fp-canvas" + (className ? " " + className : "")}
      {...rest}
    >
      {(lattice || grid != null) && (
        <>
          <defs>
            {lattice && (
              <pattern id={`${uid}-dots`} width={1} height={1} patternUnits="userSpaceOnUse">
                <circle cx={0} cy={0} r={px * 1.1} className="fp-lattice" />
                <circle cx={1} cy={0} r={px * 1.1} className="fp-lattice" />
                <circle cx={0} cy={1} r={px * 1.1} className="fp-lattice" />
                <circle cx={1} cy={1} r={px * 1.1} className="fp-lattice" />
              </pattern>
            )}
            {grid != null && showMinor && (
              <pattern id={`${uid}-minor`} width={grid} height={grid} patternUnits="userSpaceOnUse">
                <path d={`M ${grid} 0 L 0 0 0 ${grid}`} className="fp-grid-minor" strokeWidth={px} />
              </pattern>
            )}
            {grid != null && (
              <pattern id={`${uid}-major`} width={1} height={1} patternUnits="userSpaceOnUse">
                <path d="M 1 0 L 0 0 0 1" className="fp-grid-major" strokeWidth={px} />
              </pattern>
            )}
          </defs>
          <g pointerEvents="none">
            {grid != null && showMinor && (
              <rect x={view.x} y={view.y} width={view.w} height={view.h} fill={`url(#${uid}-minor)`} />
            )}
            {grid != null && (
              <rect x={view.x} y={view.y} width={view.w} height={view.h} fill={`url(#${uid}-major)`} />
            )}
            {lattice && grid == null && (
              <rect x={view.x} y={view.y} width={view.w} height={view.h} fill={`url(#${uid}-dots)`} />
            )}
          </g>
        </>
      )}

      <g pointerEvents={editable ? undefined : "none"}>
        {scene.zones.map((z) => (
          <ZoneShape key={z.id} zone={z} selected={!!selectedZoneIds?.has(z.id)} />
        ))}
      </g>

      <g pointerEvents={editable ? undefined : "none"}>
        {scene.markers.map((m) => (
          <MarkerShape
            key={m.id}
            marker={m}
            pxPerUnit={pxPerUnit}
            label={m.label ?? (MARKER_KINDS[m.kind].decor ? "" : t(`markerKind.${m.kind}`))}
          />
        ))}
      </g>

      <g>
        {tables.map((tb) => {
          const s = tableState?.(tb);
          return (
            <TableShapeNode
              key={tb.id}
              table={tb}
              pxPerUnit={pxPerUnit}
              tone={s?.tone ?? TONE_NEUTRAL}
              ariaLabel={s?.ariaLabel}
              disabled={!!s?.disabled}
              pressed={s?.pressed}
              warn={!!s?.warn}
              sub={s?.sub === undefined ? t("seats", { count: tb.capacity }) : s.sub}
              sub2={s?.sub2 ?? null}
              onActivate={onTableActivate}
              onKeyFocus={onTableKeyFocus}
            />
          );
        })}
      </g>

      <g pointerEvents="none">
        {scene.zones.map((z) => {
          const text = z.label || (z.kind === "custom" ? "" : t(`zoneKind.${z.kind}`));
          if (!text) return null;
          const a = zoneLabelAnchor(z.points);
          return (
            <text
              key={z.id}
              x={a.x + px * 8}
              y={a.y}
              fontSize={px * 10.5}
              strokeWidth={px * 4}
              dominantBaseline="central"
              className="fp-halo fp-zone-label"
              fill={ZONE_KINDS[z.kind].text}
            >
              {text}
            </text>
          );
        })}
      </g>

      {children}
    </svg>
  );
}

const ZoneShape = memo(function ZoneShape({ zone, selected }: { zone: Zone; selected: boolean }) {
  const c = ZONE_KINDS[zone.kind];
  const d = "M " + zone.points.map((p) => `${p.x} ${p.y}`).join(" L ") + " Z";
  return (
    <path
      d={d}
      data-fp="zone"
      data-id={zone.id}
      fill={c.fill}
      stroke={c.stroke}
      strokeWidth={selected ? 2 : 1.25}
      strokeDasharray={selected ? undefined : "5 4"}
      strokeLinejoin="round"
      vectorEffect="non-scaling-stroke"
    />
  );
});

const MarkerShape = memo(function MarkerShape({
  marker: m,
  pxPerUnit,
  label,
}: {
  marker: Marker;
  pxPerUnit: number;
  label: string;
}) {
  const px = 1 / pxPerUnit;
  const glyph = MARKER_GLYPHS[m.kind];
  const box = rectBounds(m);
  const iconSize = Math.min(m.w, m.h) * 0.58;
  let body: ReactNode;
  if (m.kind === "pared") {
    body = <rect x={-m.w / 2} y={-m.h / 2} width={m.w} height={m.h} rx={Math.min(m.w, m.h) * 0.2} className="fp-wall" />;
  } else if (m.kind === "columna") {
    body = <rect x={-m.w / 2} y={-m.h / 2} width={m.w} height={m.h} rx={Math.min(m.w, m.h) * 0.12} className="fp-wall" />;
  } else if (m.kind === "planta") {
    body = (
      <ellipse rx={m.w / 2} ry={m.h / 2} className="fp-plant" strokeWidth={1.25} vectorEffect="non-scaling-stroke" />
    );
  } else {
    body = (
      <rect
        x={-m.w / 2}
        y={-m.h / 2}
        width={m.w}
        height={m.h}
        rx={Math.min(0.14, Math.min(m.w, m.h) * 0.2)}
        className={m.kind === "entrada" ? "fp-marker fp-marker--entrance" : "fp-marker"}
        strokeWidth={1.25}
        vectorEffect="non-scaling-stroke"
      />
    );
  }
  return (
    <g data-fp="marker" data-id={m.id} transform={`translate(${m.x} ${m.y})`}>
      <g transform={m.rotation ? `rotate(${m.rotation})` : undefined}>{body}</g>
      {glyph && iconSize * pxPerUnit >= 9 && (
        <g
          transform={`translate(${-iconSize / 2} ${-iconSize / 2}) scale(${iconSize / 24})`}
          className={
            m.kind === "entrada"
              ? "fp-glyph fp-glyph--entrance"
              : m.kind === "planta"
                ? "fp-glyph fp-glyph--plant"
                : "fp-glyph"
          }
          pointerEvents="none"
        >
          {glyph.map((d) => (
            <path key={d} d={d} strokeWidth={1.6} vectorEffect="non-scaling-stroke" />
          ))}
        </g>
      )}
      {label && (
        <text
          x={0}
          y={box.h / 2 + px * 9}
          fontSize={px * 9.5}
          strokeWidth={px * 3.5}
          textAnchor="middle"
          dominantBaseline="central"
          className={"fp-halo fp-marker-label" + (m.kind === "entrada" ? " fp-marker-label--entrance" : "")}
          pointerEvents="none"
        >
          {label}
        </text>
      )}
    </g>
  );
});

const TableShapeNode = memo(function TableShapeNode({
  table: tb,
  pxPerUnit,
  tone,
  ariaLabel,
  disabled,
  pressed,
  warn,
  sub,
  sub2,
  onActivate,
  onKeyFocus,
}: {
  table: CanvasTable;
  pxPerUnit: number;
  tone: TableTone;
  ariaLabel?: string;
  disabled: boolean;
  pressed?: boolean;
  warn: boolean;
  sub: string | null;
  sub2: string | null;
  onActivate?: (id: string) => void;
  onKeyFocus?: (id: string) => void;
}) {
  const { x, y, w, h, rotation } = tb.placement;
  const px = 1 / pxPerUnit;
  const seats = useMemo(
    () => seatLayout(tb.shape, w, h, tb.capacity),
    [tb.shape, w, h, tb.capacity],
  );
  const minPx = Math.min(w, h) * pxPerUnit;
  const numPx = Math.max(9, Math.min(15, minPx * 0.42));
  const showNum = minPx >= 13;
  // Las líneas de abajo solo se muestran si CABEN en el ancho de la mesa
  // (si no, achican la letra hasta 7,5 px o se omiten): un «Listo para
  // servir» desbordando sobre las sillas no se lee. Si el estado no cabe
  // pero el monto sí, va el monto.
  const availW = Math.max(0, w * pxPerUnit * (tb.shape === "round" ? 0.8 : 1) - 8);
  const fit = (text: string | null, base: number): number | null => {
    if (!text) return null;
    const need = text.length * base * 0.6;
    if (need <= availW) return base;
    const size = availW / (text.length * 0.6);
    return size >= 7.5 ? size : null;
  };
  const fitSub = minPx >= 34 ? fit(sub, 9) : null;
  const fitSub2 = minPx >= 34 ? fit(sub2, 9.5) : null;
  const line1 =
    fitSub !== null
      ? { text: sub, size: fitSub, strong: false }
      : fitSub2 !== null
        ? { text: sub2, size: fitSub2, strong: true }
        : null;
  const line2 =
    line1 && !line1.strong && fitSub2 !== null && minPx >= 58
      ? { text: sub2, size: fitSub2, strong: true }
      : null;
  const showSub = !!line1;
  const showSub2 = !!line2;
  const tinted = tone.fillOpacity !== undefined && tone.fillOpacity < 1;
  // Siempre el NÚMERO: es lo que el equipo y el comensal reconocen (el
  // nombre opcional va en la etiqueta accesible y en el panel).
  const title = String(tb.number);
  const button = ariaLabel !== undefined;
  // Zona de toque: al menos 44 px, sin crecer tanto que tape a la vecina.
  const hitW = Math.max(w, Math.min(44 * px, w + 0.3));
  const hitH = Math.max(h, Math.min(44 * px, h + 0.3));
  const ring = px * 3.5;

  const shape = (extra: number, props: SVGProps<SVGRectElement> & SVGProps<SVGEllipseElement>) =>
    tb.shape === "round" ? (
      <ellipse rx={w / 2 + extra} ry={h / 2 + extra} {...(props as SVGProps<SVGEllipseElement>)} />
    ) : (
      <rect
        x={-w / 2 - extra}
        y={-h / 2 - extra}
        width={w + extra * 2}
        height={h + extra * 2}
        rx={(tb.shape === "bar" ? 0.05 : Math.min(0.1, Math.min(w, h) * 0.16)) + extra}
        {...(props as SVGProps<SVGRectElement>)}
      />
    );

  return (
    <g
      data-fp="table"
      data-id={tb.id}
      transform={`translate(${x} ${y})`}
      className={
        "fp-table" +
        (button ? " fp-table--button" : "") +
        (disabled ? " fp-table--disabled" : "") +
        (tone.dim ? " fp-table--dim" : "")
      }
      role={button ? "button" : undefined}
      tabIndex={button ? (disabled ? -1 : 0) : undefined}
      aria-label={ariaLabel}
      aria-pressed={button ? pressed : undefined}
      aria-disabled={button && disabled ? true : undefined}
      onClick={
        button && onActivate
          ? () => {
              if (!disabled) onActivate(tb.id);
            }
          : undefined
      }
      onKeyDown={
        button && onActivate
          ? (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                if (!disabled) onActivate(tb.id);
              }
            }
          : undefined
      }
      onFocus={
        onKeyFocus
          ? (e) => {
              if (e.currentTarget.matches(":focus-visible")) onKeyFocus(tb.id);
            }
          : undefined
      }
    >
      <rect x={-hitW / 2} y={-hitH / 2} width={hitW} height={hitH} fill="transparent" />
      <g transform={rotation ? `rotate(${rotation})` : undefined}>
        {warn && shape(ring, { className: "fp-warn", strokeWidth: 1.5, vectorEffect: "non-scaling-stroke" })}
        {seats.map((s, i) => (
          <rect
            key={i}
            x={s.x - SEAT_W / 2}
            y={s.y - SEAT_D / 2}
            width={SEAT_W}
            height={SEAT_D}
            rx={SEAT_D / 2}
            transform={s.angle ? `rotate(${s.angle} ${s.x} ${s.y})` : undefined}
            fill={tone.stroke}
            opacity={0.75 * (tone.strokeOpacity ?? 1)}
          />
        ))}
        {tinted && shape(0, { fill: "var(--fp-surface)", stroke: "none" })}
        {shape(0, {
          fill: tone.fill,
          fillOpacity: tone.fillOpacity,
          stroke: tone.stroke,
          strokeOpacity: tone.strokeOpacity,
          strokeWidth: tone.strokeWidth ?? 1.5,
          strokeDasharray: tone.dashed ? "3 3" : undefined,
          vectorEffect: "non-scaling-stroke",
        })}
        {shape(ring, { className: "fp-focus", strokeWidth: 2.5, vectorEffect: "non-scaling-stroke" })}
      </g>
      {showNum && (
        <text
          x={0}
          y={showSub2 ? -px * (numPx * 0.5 + 4) : showSub ? -px * 5 : 0}
          fontSize={px * numPx}
          textAnchor="middle"
          dominantBaseline="central"
          className="fp-num"
          fill={tone.text}
        >
          {title}
        </text>
      )}
      {line1 && (
        <text
          x={0}
          y={line2 ? px * 4 : px * (numPx * 0.5 + 3)}
          fontSize={px * line1.size}
          textAnchor="middle"
          dominantBaseline="central"
          className={line1.strong ? "fp-sub fp-sub--strong" : "fp-sub"}
          fill={line1.strong ? (tone.subText ?? tone.text) : tone.text}
        >
          {line1.text}
        </text>
      )}
      {line2 && (
        <text
          x={0}
          y={px * 15}
          fontSize={px * line2.size}
          textAnchor="middle"
          dominantBaseline="central"
          className="fp-sub fp-sub--strong"
          fill={tone.subText ?? tone.text}
        >
          {line2.text}
        </text>
      )}
      {tone.dot && (
        <circle
          cx={w / 2 - px * 2}
          cy={-h / 2 + px * 2}
          r={px * 4.5}
          fill={tone.dot}
          className={"fp-dot" + (tone.pulse ? " fp-pulse" : "")}
          strokeWidth={px * 1.5}
        />
      )}
    </g>
  );
});

/* ───────────── vista de solo lectura, encuadrada sola ──────────── */

/** Caja del contenido con un margen alrededor (unidades). */
export function paddedBounds(
  scene: FloorScene,
  placements: TablePlacement[],
  padding: number,
): Box | null {
  const b = sceneBounds(scene, placements);
  if (!b) return null;
  return {
    x: b.x - padding,
    y: b.y - padding,
    w: Math.max(b.w + padding * 2, 2),
    h: Math.max(b.h + padding * 2, 2),
  };
}

/**
 * Plano de solo lectura que se encuadra solo al ancho disponible. Si a la
 * escala mínima legible no entra, el contenedor se desliza (como un mapa)
 * en vez de encoger las mesas hasta que no se puedan tocar.
 */
export function FloorPlanView({
  scene,
  tables,
  tableState,
  onTableActivate,
  ariaLabel,
  minPxPerUnit = 30,
  maxPxPerUnit = 64,
  maxHeight,
  padding = 0.7,
  className,
  children,
}: {
  scene: FloorScene;
  tables: CanvasTable[];
  tableState?: (t: CanvasTable) => TableState;
  onTableActivate?: (id: string) => void;
  ariaLabel: string;
  minPxPerUnit?: number;
  maxPxPerUnit?: number;
  /** Alto máximo en px: si se pasa, la escala también se ajusta al alto. */
  maxHeight?: number;
  padding?: number;
  className?: string;
  children?: ReactNode;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [boxW, setBoxW] = useState(0);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const update = () => setBoxW(el.clientWidth);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const view = useMemo(
    () =>
      paddedBounds(
        scene,
        tables.map((tb) => tb.placement),
        padding,
      ),
    [scene, tables, padding],
  );

  let scale = 40;
  if (view && boxW > 0) {
    scale = boxW / view.w;
    if (maxHeight) scale = Math.min(scale, maxHeight / view.h);
    scale = Math.min(maxPxPerUnit, Math.max(minPxPerUnit, scale));
  }

  return (
    <div ref={wrapRef} className={"fp-view" + (className ? " " + className : "")}>
      {view && boxW > 0 && (
        <FloorPlanCanvas
          scene={scene}
          tables={tables}
          view={view}
          pxPerUnit={scale}
          tableState={tableState}
          onTableActivate={onTableActivate}
          role="group"
          aria-label={ariaLabel}
          width={view.w * scale}
          height={view.h * scale}
          style={{ width: view.w * scale, height: view.h * scale }}
        >
          {children}
        </FloorPlanCanvas>
      )}
    </div>
  );
}
