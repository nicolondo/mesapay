"use client";

import {
  ZONE_KINDS,
  polygonBounds,
  rectCorners,
  rotatePoint,
  type Box,
  type Point,
  type ZoneKind,
} from "@/lib/floorPlan";
import type { SnapGuide } from "@/lib/floorPlanSnap";
import { boxOfKeys, splitKey, type Doc } from "./editorModel";

/** Lo que se está dibujando con el puntero y todavía no existe. */
export type Draft =
  | { type: "zone"; box: Box; kind: ZoneKind }
  | { type: "bool"; box: Box; op: "add" | "cut" }
  | { type: "marquee"; box: Box }
  | { type: "wall"; x: number; y: number; w: number; h: number; rotation: number };

type Rectish = { x: number; y: number; w: number; h: number; rotation: number };

/** Manijas de un rectángulo según cuánto mide en pantalla. */
function rectHandles(r: Rectish, pxPerUnit: number): { sx: -1 | 0 | 1; sy: -1 | 0 | 1 }[] {
  const wPx = r.w * pxPerUnit;
  const hPx = r.h * pxPerUnit;
  // Muy angosto (una pared, una barra fina): solo los dos extremos.
  if (hPx < 26 && wPx >= hPx) return [{ sx: -1, sy: 0 }, { sx: 1, sy: 0 }];
  if (wPx < 26 && hPx > wPx) return [{ sx: 0, sy: -1 }, { sx: 0, sy: 1 }];
  const out: { sx: -1 | 0 | 1; sy: -1 | 0 | 1 }[] = [
    { sx: -1, sy: -1 },
    { sx: 1, sy: -1 },
    { sx: 1, sy: 1 },
    { sx: -1, sy: 1 },
  ];
  if (wPx >= 76) out.push({ sx: 0, sy: -1 }, { sx: 0, sy: 1 });
  if (hPx >= 76) out.push({ sx: -1, sy: 0 }, { sx: 1, sy: 0 });
  return out;
}

const CURSORS = ["ns-resize", "nesw-resize", "ew-resize", "nwse-resize"];
/** Cursor de redimensionar según hacia dónde apunta la manija en pantalla. */
function resizeCursor(sx: number, sy: number, rotation: number): string {
  const angle = (Math.atan2(sy, sx) * 180) / Math.PI + 90 + rotation;
  const idx = Math.round((((angle % 180) + 180) % 180) / 45) % 4;
  return CURSORS[idx];
}

export function EditorOverlay({
  doc,
  sel,
  pxPerUnit,
  coarse,
  guides,
  draft,
  activeVertex,
  showHandles,
}: {
  doc: Doc;
  sel: string[];
  pxPerUnit: number;
  /** Puntero grueso (dedo): zonas de toque de 44 px. */
  coarse: boolean;
  guides: SnapGuide[];
  draft: Draft | null;
  activeVertex: number | null;
  showHandles: boolean;
}) {
  const px = 1 / pxPerUnit;
  const hitR = (coarse ? 22 : 10) * px;
  const knob = 5 * px;

  const single = sel.length === 1 ? splitKey(sel[0]) : null;
  const rectOf = (key: string): Rectish | null => {
    const { type, id } = splitKey(key);
    if (type === "t") return doc.tables[id]?.placement ?? null;
    if (type === "m") return doc.markers.find((m) => m.id === id) ?? null;
    return null;
  };
  const singleRect = single && single.type !== "z" ? rectOf(sel[0]) : null;
  const singleZone =
    single && single.type === "z" ? (doc.zones.find((z) => z.id === single.id) ?? null) : null;
  const group = sel.length > 1 ? boxOfKeys(doc, sel) : null;

  return (
    <g className="fp-overlay">
      {/* Contorno de cada seleccionado */}
      {sel.map((key) => {
        const r = rectOf(key);
        if (r) {
          return (
            <polygon
              key={key}
              points={rectCorners(r)
                .map((p) => `${p.x},${p.y}`)
                .join(" ")}
              className="fp-sel"
              vectorEffect="non-scaling-stroke"
              pointerEvents="none"
            />
          );
        }
        const { type, id } = splitKey(key);
        if (type !== "z" || sel.length === 1) return null;
        const z = doc.zones.find((x) => x.id === id);
        if (!z) return null;
        return (
          <polygon
            key={key}
            points={z.points.map((p) => `${p.x},${p.y}`).join(" ")}
            className="fp-sel"
            vectorEffect="non-scaling-stroke"
            pointerEvents="none"
          />
        );
      })}
      {group && (
        <rect
          x={group.x - px * 6}
          y={group.y - px * 6}
          width={group.w + px * 12}
          height={group.h + px * 12}
          className="fp-sel fp-sel--group"
          vectorEffect="non-scaling-stroke"
          pointerEvents="none"
        />
      )}

      {/* Manijas de una mesa o un elemento */}
      {showHandles && singleRect && (
        <RectHandles rect={singleRect} pxPerUnit={pxPerUnit} hitR={hitR} knob={knob} />
      )}

      {/* Manijas de una zona: vértices y lados */}
      {showHandles && singleZone && (
        <g>
          {singleZone.points.map((p, i) => {
            const q = singleZone.points[(i + 1) % singleZone.points.length];
            const len = Math.hypot(q.x - p.x, q.y - p.y);
            if (len * pxPerUnit < 44) return null;
            const mid = { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 };
            const angle = (Math.atan2(q.y - p.y, q.x - p.x) * 180) / Math.PI;
            const horizontalish = Math.abs(Math.cos((angle * Math.PI) / 180)) > 0.7;
            return (
              <g
                key={`e${i}`}
                data-fp="handle"
                data-h={`e:${i}`}
                style={{ cursor: horizontalish ? "ns-resize" : "ew-resize" }}
              >
                <circle cx={mid.x} cy={mid.y} r={hitR * 0.85} fill="transparent" />
                <rect
                  x={mid.x - px * 8}
                  y={mid.y - px * 3}
                  width={px * 16}
                  height={px * 6}
                  rx={px * 3}
                  transform={`rotate(${angle} ${mid.x} ${mid.y})`}
                  className="fp-knob fp-knob--edge"
                  vectorEffect="non-scaling-stroke"
                />
              </g>
            );
          })}
          {singleZone.points.map((p, i) => (
            <g key={`v${i}`} data-fp="handle" data-h={`v:${i}`} style={{ cursor: "move" }}>
              <circle cx={p.x} cy={p.y} r={hitR} fill="transparent" />
              <rect
                x={p.x - knob}
                y={p.y - knob}
                width={knob * 2}
                height={knob * 2}
                rx={px * 1.5}
                className={"fp-knob" + (activeVertex === i ? " fp-knob--active" : "")}
                vectorEffect="non-scaling-stroke"
              />
            </g>
          ))}
        </g>
      )}

      {/* Guías inteligentes */}
      {guides.map((g, i) => {
        if (g.kind === "v") {
          return (
            <line
              key={i}
              x1={g.x}
              x2={g.x}
              y1={g.y1 - px * 10}
              y2={g.y2 + px * 10}
              className="fp-guide"
              vectorEffect="non-scaling-stroke"
            />
          );
        }
        if (g.kind === "h") {
          return (
            <line
              key={i}
              y1={g.y}
              y2={g.y}
              x1={g.x1 - px * 10}
              x2={g.x2 + px * 10}
              className="fp-guide"
              vectorEffect="non-scaling-stroke"
            />
          );
        }
        const tick = px * 4;
        return g.axis === "x" ? (
          <path
            key={i}
            d={`M ${g.from} ${g.at} L ${g.to} ${g.at} M ${g.from} ${g.at - tick} L ${g.from} ${g.at + tick} M ${g.to} ${g.at - tick} L ${g.to} ${g.at + tick}`}
            className="fp-guide fp-guide--gap"
            vectorEffect="non-scaling-stroke"
          />
        ) : (
          <path
            key={i}
            d={`M ${g.at} ${g.from} L ${g.at} ${g.to} M ${g.at - tick} ${g.from} L ${g.at + tick} ${g.from} M ${g.at - tick} ${g.to} L ${g.at + tick} ${g.to}`}
            className="fp-guide fp-guide--gap"
            vectorEffect="non-scaling-stroke"
          />
        );
      })}

      {/* Lo que se está dibujando */}
      {draft && draft.type === "wall" && (
        <rect
          x={-draft.w / 2}
          y={-draft.h / 2}
          width={draft.w}
          height={draft.h}
          transform={`translate(${draft.x} ${draft.y}) rotate(${draft.rotation})`}
          className="fp-wall"
          opacity={0.7}
          pointerEvents="none"
        />
      )}
      {draft && draft.type !== "wall" && (
        <rect
          x={draft.box.x}
          y={draft.box.y}
          width={draft.box.w}
          height={draft.box.h}
          className={
            "fp-draft" +
            (draft.type === "bool" && draft.op === "cut" ? " fp-draft--cut" : "") +
            (draft.type === "marquee" ? " fp-draft--marquee" : "")
          }
          style={
            draft.type === "zone"
              ? { fill: ZONE_KINDS[draft.kind].fill, stroke: ZONE_KINDS[draft.kind].stroke }
              : undefined
          }
          vectorEffect="non-scaling-stroke"
          pointerEvents="none"
        />
      )}
    </g>
  );
}

function RectHandles({
  rect: r,
  pxPerUnit,
  hitR,
  knob,
}: {
  rect: Rectish;
  pxPerUnit: number;
  hitR: number;
  knob: number;
}) {
  const px = 1 / pxPerUnit;
  const c = { x: r.x, y: r.y };
  const toWorld = (lx: number, ly: number): Point =>
    rotatePoint({ x: c.x + lx, y: c.y + ly }, c, r.rotation);
  const handles = rectHandles(r, pxPerUnit);
  const rotStem = px * 30;
  const rotAt = toWorld(0, -r.h / 2 - rotStem);
  const rotFrom = toWorld(0, -r.h / 2);
  const corners = rectCorners(r)
    .map((p) => `${p.x},${p.y}`)
    .join(" ");
  return (
    <g>
      {/* 1) Zonas de toque amplias, por FUERA del cuerpo. */}
      {handles.map((h) => {
        const len = Math.hypot(h.sx, h.sy) || 1;
        const out = px * 9;
        const p = toWorld(
          (h.sx * r.w) / 2 + (h.sx / len) * out,
          (h.sy * r.h) / 2 + (h.sy / len) * out,
        );
        return (
          <circle
            key={`hit${h.sx}${h.sy}`}
            data-fp="handle"
            data-h={`r:${h.sx}:${h.sy}`}
            cx={p.x}
            cy={p.y}
            r={hitR}
            fill="transparent"
            style={{ cursor: resizeCursor(h.sx, h.sy, r.rotation) }}
          />
        );
      })}
      {/* 2) El cuerpo sigue siendo «agarrar para mover», encima de esas zonas. */}
      <polygon points={corners} data-fp="grab" fill="transparent" style={{ cursor: "move" }} />
      {/* 3) Girar */}
      <line
        x1={rotFrom.x}
        y1={rotFrom.y}
        x2={rotAt.x}
        y2={rotAt.y}
        className="fp-sel"
        vectorEffect="non-scaling-stroke"
        pointerEvents="none"
      />
      <g data-fp="handle" data-h="rot" style={{ cursor: "grab" }}>
        <circle cx={rotAt.x} cy={rotAt.y} r={hitR} fill="transparent" />
        <circle
          cx={rotAt.x}
          cy={rotAt.y}
          r={px * 6}
          className="fp-knob fp-knob--rot"
          vectorEffect="non-scaling-stroke"
        />
      </g>
      {/* 4) Los tiradores visibles, con su propia zona de toque chica. */}
      {handles.map((h) => {
        const p = toWorld((h.sx * r.w) / 2, (h.sy * r.h) / 2);
        return (
          <g
            key={`k${h.sx}${h.sy}`}
            data-fp="handle"
            data-h={`r:${h.sx}:${h.sy}`}
            style={{ cursor: resizeCursor(h.sx, h.sy, r.rotation) }}
          >
            <circle cx={p.x} cy={p.y} r={px * 8} fill="transparent" />
            <rect
              x={p.x - knob}
              y={p.y - knob}
              width={knob * 2}
              height={knob * 2}
              rx={px * 1.5}
              transform={r.rotation ? `rotate(${r.rotation} ${p.x} ${p.y})` : undefined}
              className="fp-knob"
              vectorEffect="non-scaling-stroke"
            />
          </g>
        );
      })}
    </g>
  );
}

/** Caja de una zona, para el rótulo de medidas mientras se edita. */
export function zoneBox(points: Point[]): Box {
  return polygonBounds(points);
}
