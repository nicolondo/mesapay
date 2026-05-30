"use client";

import { useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  type FloorPlan,
  type Zone,
  type Marker,
  type ZoneKind,
  type MarkerKind,
  ZONE_KINDS,
  ZONE_KIND_LIST,
  MARKER_KINDS,
  MARKER_KIND_LIST,
  markerLabel,
  cellKey,
  zoneAnchorCell,
  zoneLabelAnchor,
  FLOOR_MIN_COLS,
  FLOOR_MAX_COLS,
  FLOOR_MIN_ROWS,
  FLOOR_MAX_ROWS,
} from "@/lib/floorPlan";

export type EditorTable = {
  id: string;
  number: number;
  label: string | null;
  capacity: number;
  shape: "square" | "round" | "bar";
  x: number | null;
  y: number | null;
};

const ZOOM_MIN = 26;
const ZOOM_MAX = 64;
const ZOOM_STEP = 6;
const DEFAULT_ZOOM = 42;

/** Acción que el próximo toque en una celda va a resolver. */
type Pending =
  | { kind: "placeTable"; id: string }
  | { kind: "moveZone"; id: string }
  | { kind: "moveMarker"; id: string }
  | { kind: "addZone"; zoneKind: ZoneKind }
  | { kind: "addMarker"; markerKind: MarkerKind };

type Sel =
  | { type: "table"; id: string }
  | { type: "zone"; id: string }
  | { type: "marker"; id: string }
  | null;

/** Arrastre de una mesa en curso (mouse o touch). */
type DragState = {
  tableId: string;
  /** Posición actual del puntero (viewport). */
  px: number;
  py: number;
  startX: number;
  startY: number;
  /** Pasó el umbral → es un drag real, no un tap. */
  moved: boolean;
  /** Celda sobre la que está el puntero (o null si fuera de la grilla). */
  over: { x: number; y: number } | null;
};

function newId(prefix: string): string {
  try {
    if (typeof crypto !== "undefined" && crypto.randomUUID) {
      return prefix + crypto.randomUUID().slice(0, 8);
    }
  } catch {
    /* fallthrough */
  }
  return prefix + Math.random().toString(36).slice(2, 10);
}

export function FloorPlanEditor({
  initialTables,
  initialFloorPlan,
}: {
  initialTables: EditorTable[];
  initialFloorPlan: FloorPlan;
}) {
  const router = useRouter();
  const [tables, setTables] = useState<EditorTable[]>(initialTables);
  const [cols, setCols] = useState(initialFloorPlan.cols);
  const [rows, setRows] = useState(initialFloorPlan.rows);
  const [zones, setZones] = useState<Zone[]>(initialFloorPlan.zones);
  const [markers, setMarkers] = useState<Marker[]>(initialFloorPlan.markers);
  const [cellPx, setCellPx] = useState(DEFAULT_ZOOM);
  const [sel, setSel] = useState<Sel>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  // Qué kind usa el botón "+ Zona" / "+ Ícono".
  const [zoneKind, setZoneKind] = useState<ZoneKind>("interior");
  const [markerKind, setMarkerKind] = useState<MarkerKind>("entrada");

  // Drag & drop de mesas.
  const gridRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  // Dibujo de una zona arrastrando sobre varias celdas (modo "+ Zona").
  // sx/sy = celda donde empezó; cx/cy = celda actual del puntero.
  const [zoneDraw, setZoneDraw] = useState<{
    sx: number;
    sy: number;
    cx: number;
    cy: number;
  } | null>(null);
  // Suprime el click sintético que sigue a un pointerup de drag para que
  // no deseleccione/dispare onCellTap por accidente.
  const dragEndedRef = useRef(false);

  const placed = tables.filter((t) => t.x != null && t.y != null);
  const unplaced = tables.filter((t) => t.x == null || t.y == null);
  // Celdas tapadas por una mesa — para ubicar el label de zona donde no
  // haya mesa encima.
  const occupiedCellKeys = new Set(
    placed.map((t) => cellKey(t.x as number, t.y as number)),
  );

  // Mínimos de la grilla: no podés encogerla por debajo de lo que ya
  // está ocupado (mesas, zonas que terminan en x+w, markers).
  const { minCols, minRows } = useMemo(() => {
    let maxX = -1;
    let maxY = -1;
    for (const t of placed) {
      maxX = Math.max(maxX, t.x as number);
      maxY = Math.max(maxY, t.y as number);
    }
    for (const z of zones) {
      for (const c of z.cells) {
        maxX = Math.max(maxX, c.x);
        maxY = Math.max(maxY, c.y);
      }
    }
    for (const m of markers) {
      maxX = Math.max(maxX, m.x);
      maxY = Math.max(maxY, m.y);
    }
    return {
      minCols: Math.max(FLOOR_MIN_COLS, maxX + 1),
      minRows: Math.max(FLOOR_MIN_ROWS, maxY + 1),
    };
  }, [placed, zones, markers]);

  function markDirty() {
    setDirty(true);
    setMsg(null);
  }

  function occupant(x: number, y: number): EditorTable | undefined {
    return placed.find((t) => t.x === x && t.y === y);
  }

  /**
   * Mueve una mesa a la celda (x,y). Si ya hay otra ahí, hacen swap (la
   * que estaba va a la posición anterior de la que se mueve — o a la
   * bandeja si venía sin ubicar). Calcula todo desde el estado actual
   * dentro del updater para no leer `placed` stale durante un drag.
   */
  function moveTableTo(id: string, x: number, y: number) {
    setTables((ts) => {
      const moving = ts.find((t) => t.id === id);
      const taken = ts.find((t) => t.id !== id && t.x === x && t.y === y);
      return ts.map((t) => {
        if (t.id === id) return { ...t, x, y };
        if (taken && t.id === taken.id)
          return { ...t, x: moving?.x ?? null, y: moving?.y ?? null };
        return t;
      });
    });
    markDirty();
  }

  /** Mapea un punto del puntero (viewport) a una celda de la grilla. */
  function cellFromPoint(
    clientX: number,
    clientY: number,
  ): { x: number; y: number } | null {
    const r = gridRef.current?.getBoundingClientRect();
    if (!r) return null;
    const lx = clientX - r.left;
    const ly = clientY - r.top;
    if (lx < 0 || ly < 0 || lx >= r.width || ly >= r.height) return null;
    const x = Math.floor(lx / cellPx);
    const y = Math.floor(ly / cellPx);
    if (x < 0 || y < 0 || x >= cols || y >= rows) return null;
    return { x, y };
  }

  // ── Drag & drop de mesas ──────────────────────────────────────────
  function startTableDrag(e: React.PointerEvent, id: string) {
    // Si estamos en modo "tocá una celda" (pending) dejamos ese flujo.
    if (pending) return;
    try {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    } catch {
      /* no soportado — el drag igual funciona con listeners del elemento */
    }
    setDrag({
      tableId: id,
      px: e.clientX,
      py: e.clientY,
      startX: e.clientX,
      startY: e.clientY,
      moved: false,
      over: null,
    });
  }
  function onTableDragMove(e: React.PointerEvent) {
    if (!drag) return;
    const moved =
      drag.moved || Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) > 6;
    setDrag({
      ...drag,
      px: e.clientX,
      py: e.clientY,
      moved,
      over: moved ? cellFromPoint(e.clientX, e.clientY) : drag.over,
    });
  }
  function endTableDrag(e: React.PointerEvent) {
    if (!drag) return;
    const d = drag;
    setDrag(null);
    if (d.moved) {
      const cell = cellFromPoint(e.clientX, e.clientY);
      if (cell) {
        moveTableTo(d.tableId, cell.x, cell.y);
        setSel({ type: "table", id: d.tableId });
      }
      // Si soltó fuera de la grilla, la mesa queda donde estaba.
    } else {
      // Fue un tap, no un arrastre.
      const t = tables.find((tt) => tt.id === d.tableId);
      setSel({ type: "table", id: d.tableId });
      // Una mesa de la bandeja (sin ubicar) arma el modo "tocá una celda".
      if (t && t.x == null) setPending({ kind: "placeTable", id: d.tableId });
    }
    // Suprimir el click sintético que sigue.
    dragEndedRef.current = true;
    setTimeout(() => {
      dragEndedRef.current = false;
    }, 0);
  }

  // ── Pintar/editar celdas de zona ──────────────────────────────────
  // Arrastrar = agrega un bloque (rectángulo) de celdas; tocar una celda
  // suelta = la agrega o la quita (para formas irregulares).
  function startZoneDraw(e: React.PointerEvent, x: number, y: number) {
    try {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    } catch {
      /* sin captura — igual funciona con los listeners del elemento */
    }
    setZoneDraw({ sx: x, sy: y, cx: x, cy: y });
  }
  function moveZoneDraw(e: React.PointerEvent) {
    setZoneDraw((zd) => {
      if (!zd) return zd;
      const c = cellFromPoint(e.clientX, e.clientY);
      if (!c) return zd;
      return { ...zd, cx: c.x, cy: c.y };
    });
  }
  function endZoneDraw() {
    const zd = zoneDraw;
    setZoneDraw(null);
    if (!zd) return;
    const x0 = Math.min(zd.sx, zd.cx);
    const y0 = Math.min(zd.sy, zd.cy);
    const x1 = Math.max(zd.sx, zd.cx);
    const y1 = Math.max(zd.sy, zd.cy);
    const isTap = x0 === x1 && y0 === y1;
    const rect: { x: number; y: number }[] = [];
    for (let yy = y0; yy <= y1; yy++) {
      for (let xx = x0; xx <= x1; xx++) rect.push({ x: xx, y: yy });
    }

    if (pending?.kind === "addZone") {
      // Crear zona nueva con el bloque (o 1 celda si fue un toque).
      const id = newId("z");
      const zk = pending.zoneKind;
      setZones((zs) => [
        ...zs,
        {
          id,
          kind: zk,
          label: zk === "custom" ? "" : ZONE_KINDS[zk].label,
          cells: rect,
        },
      ]);
      setSel({ type: "zone", id });
      setPending(null);
      markDirty();
    } else if (sel?.type === "zone") {
      // Editar la zona seleccionada: tap = toggle una celda, arrastre =
      // agregar el bloque.
      if (isTap) toggleZoneCell(sel.id, x0, y0);
      else addCellsToZone(sel.id, rect);
    }
    dragEndedRef.current = true;
    setTimeout(() => {
      dragEndedRef.current = false;
    }, 0);
  }

  function toggleZoneCell(zoneId: string, x: number, y: number) {
    setZones((zs) =>
      zs.map((z) => {
        if (z.id !== zoneId) return z;
        const k = cellKey(x, y);
        const has = z.cells.some((c) => cellKey(c.x, c.y) === k);
        if (has) {
          if (z.cells.length <= 1) return z; // no dejar la zona vacía
          return {
            ...z,
            cells: z.cells.filter((c) => cellKey(c.x, c.y) !== k),
          };
        }
        return { ...z, cells: [...z.cells, { x, y }] };
      }),
    );
    markDirty();
  }
  function addCellsToZone(zoneId: string, cells: { x: number; y: number }[]) {
    setZones((zs) =>
      zs.map((z) => {
        if (z.id !== zoneId) return z;
        const have = new Set(z.cells.map((c) => cellKey(c.x, c.y)));
        const merged = [...z.cells];
        for (const c of cells) {
          const k = cellKey(c.x, c.y);
          if (!have.has(k)) {
            have.add(k);
            merged.push(c);
          }
        }
        return { ...z, cells: merged };
      }),
    );
    markDirty();
  }
  function moveZoneTo(zoneId: string, x: number, y: number) {
    // Traslada toda la zona para que su celda ancla quede en (x,y),
    // clampeando para no salir de la grilla.
    setZones((zs) =>
      zs.map((z) => {
        if (z.id !== zoneId) return z;
        const anchor = zoneAnchorCell(z.cells);
        if (!anchor) return z;
        let dx = x - anchor.x;
        let dy = y - anchor.y;
        const minX = Math.min(...z.cells.map((c) => c.x));
        const minY = Math.min(...z.cells.map((c) => c.y));
        const maxX = Math.max(...z.cells.map((c) => c.x));
        const maxY = Math.max(...z.cells.map((c) => c.y));
        if (minX + dx < 0) dx = -minX;
        if (minY + dy < 0) dy = -minY;
        if (maxX + dx > cols - 1) dx = cols - 1 - maxX;
        if (maxY + dy > rows - 1) dy = rows - 1 - maxY;
        return {
          ...z,
          cells: z.cells.map((c) => ({ x: c.x + dx, y: c.y + dy })),
        };
      }),
    );
    markDirty();
  }

  // ── Resolución de un toque en celda (x,y) ──────────────────────────
  function onCellTap(x: number, y: number) {
    if (pending) {
      switch (pending.kind) {
        case "placeTable": {
          moveTableTo(pending.id, x, y);
          setSel({ type: "table", id: pending.id });
          break;
        }
        case "moveZone": {
          moveZoneTo(pending.id, x, y);
          break;
        }
        case "moveMarker": {
          setMarkers((ms) =>
            ms.map((m) => (m.id === pending.id ? { ...m, x, y } : m)),
          );
          break;
        }
        case "addZone": {
          const id = newId("z");
          const zk = pending.zoneKind;
          setZones((zs) => [
            ...zs,
            {
              id,
              kind: zk,
              label: zk === "custom" ? "" : ZONE_KINDS[zk].label,
              cells: [{ x, y }],
            },
          ]);
          setSel({ type: "zone", id });
          break;
        }
        case "addMarker": {
          const id = newId("m");
          setMarkers((ms) => [
            ...ms,
            { id, kind: pending.markerKind, label: null, x, y },
          ]);
          setSel({ type: "marker", id });
          break;
        }
      }
      setPending(null);
      markDirty();
      return;
    }

    // Sin pending: si hay una zona seleccionada, tocar una celda la
    // edita (agrega/quita). Si no, seleccionar la mesa o limpiar.
    if (sel?.type === "zone") {
      toggleZoneCell(sel.id, x, y);
      return;
    }
    const occ = occupant(x, y);
    if (occ) setSel({ type: "table", id: occ.id });
    else setSel(null);
  }

  function handleTableClick(t: EditorTable) {
    if (pending) {
      onCellTap(t.x as number, t.y as number);
      return;
    }
    setSel({ type: "table", id: t.id });
  }

  // ── Acciones de elementos ──────────────────────────────────────────
  function cycleShape(id: string) {
    const order: EditorTable["shape"][] = ["square", "round", "bar"];
    setTables((ts) =>
      ts.map((t) =>
        t.id === id
          ? { ...t, shape: order[(order.indexOf(t.shape) + 1) % order.length] }
          : t,
      ),
    );
    markDirty();
  }
  function removeTableFromPlan(id: string) {
    setTables((ts) =>
      ts.map((t) => (t.id === id ? { ...t, x: null, y: null } : t)),
    );
    setSel(null);
    markDirty();
  }
  function setZoneKindOf(id: string, kind: ZoneKind) {
    setZones((zs) =>
      zs.map((z) => {
        if (z.id !== id) return z;
        // Si el label era el default del tipo anterior (o vacío), lo
        // actualizamos al del nuevo tipo. Para "Personalizada" dejamos el
        // label vacío (el operador escribe el nombre, no ponemos texto).
        const wasDefault =
          z.label === ZONE_KINDS[z.kind].label || z.label.trim() === "";
        const nextLabel = wasDefault
          ? kind === "custom"
            ? ""
            : ZONE_KINDS[kind].label
          : z.label;
        return { ...z, kind, label: nextLabel };
      }),
    );
    markDirty();
  }
  function setZoneLabelOf(id: string, label: string) {
    setZones((zs) => zs.map((z) => (z.id === id ? { ...z, label } : z)));
    markDirty();
  }
  function deleteZone(id: string) {
    setZones((zs) => zs.filter((z) => z.id !== id));
    setSel(null);
    markDirty();
  }
  function setMarkerKindOf(id: string, kind: MarkerKind) {
    setMarkers((ms) => ms.map((m) => (m.id === id ? { ...m, kind } : m)));
    markDirty();
  }
  function setMarkerLabelOf(id: string, label: string) {
    setMarkers((ms) =>
      ms.map((m) =>
        m.id === id ? { ...m, label: label.trim() ? label : null } : m,
      ),
    );
    markDirty();
  }
  function deleteMarker(id: string) {
    setMarkers((ms) => ms.filter((m) => m.id !== id));
    setSel(null);
    markDirty();
  }

  function autoArrange() {
    setTables((ts) => {
      const sorted = [...ts].sort((a, b) => a.number - b.number);
      return sorted.map((t, i) => ({
        ...t,
        x: i % cols,
        y: Math.floor(i / cols),
      }));
    });
    // Asegurar filas suficientes.
    setRows((r) => Math.max(r, Math.ceil(tables.length / cols) + 1));
    setSel(null);
    markDirty();
  }

  async function save() {
    setSaving(true);
    setMsg(null);
    const res = await fetch("/api/operator/settings/floor-plan", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        positions: tables.map((t) => ({
          id: t.id,
          x: t.x,
          y: t.y,
          shape: t.shape,
        })),
        floorPlan: { cols, rows, zones, markers },
      }),
    });
    setSaving(false);
    if (!res.ok) {
      setMsg("No pudimos guardar. Intentá de nuevo.");
      return;
    }
    setDirty(false);
    setMsg("Mapa guardado.");
    router.refresh();
  }

  const selZone =
    sel?.type === "zone" ? zones.find((z) => z.id === sel.id) ?? null : null;
  const selMarker =
    sel?.type === "marker"
      ? markers.find((m) => m.id === sel.id) ?? null
      : null;
  const selTable =
    sel?.type === "table" ? tables.find((t) => t.id === sel.id) ?? null : null;

  const gridW = cols * cellPx;
  const gridH = rows * cellPx;

  const pendingHint = pending
    ? pending.kind === "placeTable"
      ? "Tocá una celda para ubicar la mesa"
      : pending.kind === "moveZone"
        ? "Tocá la celda donde va la esquina superior izquierda de la zona"
        : pending.kind === "moveMarker"
          ? "Tocá la celda donde va el ícono"
          : pending.kind === "addZone"
            ? `Arrastrá sobre las celdas para cubrir la zona "${ZONE_KINDS[pending.zoneKind].label}" (o tocá una)`
            : `Tocá una celda para poner "${MARKER_KINDS[pending.markerKind].label}"`
    : null;

  return (
    <div>
      {/* Toolbar superior */}
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <button
          type="button"
          onClick={autoArrange}
          className="h-9 px-3 rounded-full border border-op-border bg-op-surface text-xs font-medium text-op-muted hover:text-op-text"
        >
          Auto-acomodar mesas
        </button>
        <div className="flex-1" />
        {msg && <span className="text-xs text-ok">{msg}</span>}
        <button
          type="button"
          onClick={save}
          disabled={saving || !dirty}
          className="h-9 px-5 rounded-full bg-ink text-bone text-sm font-medium disabled:opacity-40"
        >
          {saving ? "Guardando…" : dirty ? "Guardar mapa" : "Guardado"}
        </button>
      </div>

      {/* Controles de grilla: tamaño + zoom */}
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 mb-3 text-sm">
        <Stepper
          label="Columnas"
          value={cols}
          onDec={() => {
            setCols((c) => Math.max(minCols, c - 1));
            markDirty();
          }}
          onInc={() => {
            setCols((c) => Math.min(FLOOR_MAX_COLS, c + 1));
            markDirty();
          }}
          canDec={cols > minCols}
          canInc={cols < FLOOR_MAX_COLS}
        />
        <Stepper
          label="Filas"
          value={rows}
          onDec={() => {
            setRows((r) => Math.max(minRows, r - 1));
            markDirty();
          }}
          onInc={() => {
            setRows((r) => Math.min(FLOOR_MAX_ROWS, r + 1));
            markDirty();
          }}
          canDec={rows > minRows}
          canInc={rows < FLOOR_MAX_ROWS}
        />
        <label className="flex items-center gap-2 text-op-muted">
          <span className="text-xs">Zoom</span>
          <input
            type="range"
            min={ZOOM_MIN}
            max={ZOOM_MAX}
            step={ZOOM_STEP}
            value={cellPx}
            onChange={(e) => setCellPx(Number(e.target.value))}
            className="w-28 accent-terracotta"
          />
        </label>
      </div>

      {/* Paleta: agregar al plano */}
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <button
          type="button"
          onClick={() => {
            setSel(null);
            setPending({ kind: "addMarker", markerKind: "entrada" });
          }}
          className={
            "h-9 px-3 rounded-full border text-xs font-medium " +
            (pending?.kind === "addMarker" && pending.markerKind === "entrada"
              ? "border-terracotta bg-terracotta/10 text-terracotta"
              : "border-op-border bg-op-surface text-op-text")
          }
        >
          🚪 + Entrada
        </button>

        <div className="inline-flex items-center rounded-full border border-op-border bg-op-surface overflow-hidden">
          <select
            value={zoneKind}
            onChange={(e) => setZoneKind(e.target.value as ZoneKind)}
            className="h-9 pl-3 pr-1 bg-transparent text-xs outline-none"
          >
            {ZONE_KIND_LIST.map((k) => (
              <option key={k} value={k}>
                {ZONE_KINDS[k].label}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => {
              setSel(null);
              setPending({ kind: "addZone", zoneKind });
            }}
            className={
              "h-9 px-3 text-xs font-medium border-l border-op-border " +
              (pending?.kind === "addZone"
                ? "bg-terracotta/10 text-terracotta"
                : "text-op-text")
            }
          >
            + Zona
          </button>
        </div>

        <div className="inline-flex items-center rounded-full border border-op-border bg-op-surface overflow-hidden">
          <select
            value={markerKind}
            onChange={(e) => setMarkerKind(e.target.value as MarkerKind)}
            className="h-9 pl-3 pr-1 bg-transparent text-xs outline-none"
          >
            {MARKER_KIND_LIST.map((k) => (
              <option key={k} value={k}>
                {MARKER_KINDS[k].icon} {MARKER_KINDS[k].label}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => {
              setSel(null);
              setPending({ kind: "addMarker", markerKind });
            }}
            className={
              "h-9 px-3 text-xs font-medium border-l border-op-border " +
              (pending?.kind === "addMarker" && pending.markerKind !== "entrada"
                ? "bg-terracotta/10 text-terracotta"
                : "text-op-text")
            }
          >
            + Ícono
          </button>
        </div>

        {pending && (
          <button
            type="button"
            onClick={() => setPending(null)}
            className="h-9 px-3 rounded-full border border-op-border text-xs text-op-muted"
          >
            Cancelar
          </button>
        )}
      </div>

      {pendingHint && (
        <div className="mb-3 rounded-xl border border-terracotta/40 bg-terracotta/10 px-4 py-2 text-sm text-terracotta">
          {pendingHint}
        </div>
      )}

      {/* Panel del elemento seleccionado */}
      {selTable && (
        <SelPanel title={selTable.label ?? `Mesa ${selTable.number}`}>
          <button
            type="button"
            onClick={() => cycleShape(selTable.id)}
            className="h-8 px-3 rounded-full border border-op-border text-xs"
          >
            Forma: {shapeLabel(selTable.shape)}
          </button>
          {selTable.x != null && (
            <>
              <button
                type="button"
                onClick={() => setPending({ kind: "placeTable", id: selTable.id })}
                className="h-8 px-3 rounded-full border border-op-border text-xs"
              >
                Mover
              </button>
              <button
                type="button"
                onClick={() => removeTableFromPlan(selTable.id)}
                className="h-8 px-3 rounded-full border border-danger/40 text-danger text-xs"
              >
                Sacar del plano
              </button>
            </>
          )}
        </SelPanel>
      )}

      {selZone && (
        <SelPanel title={`Zona: ${selZone.label || "(sin nombre)"}`}>
          <select
            value={selZone.kind}
            onChange={(e) => setZoneKindOf(selZone.id, e.target.value as ZoneKind)}
            className="h-8 rounded-full border border-op-border bg-op-surface text-xs px-2"
          >
            {ZONE_KIND_LIST.map((k) => (
              <option key={k} value={k}>
                {ZONE_KINDS[k].label}
              </option>
            ))}
          </select>
          <input
            type="text"
            value={selZone.label}
            maxLength={40}
            onChange={(e) => setZoneLabelOf(selZone.id, e.target.value)}
            className="h-8 w-40 rounded-full border border-op-border bg-op-surface text-xs px-3"
            placeholder={
              selZone.kind === "custom"
                ? "Escribí el nombre de la zona"
                : "Nombre"
            }
          />
          <button
            type="button"
            onClick={() => setPending({ kind: "moveZone", id: selZone.id })}
            className="h-8 px-3 rounded-full border border-op-border text-xs"
          >
            Mover
          </button>
          <button
            type="button"
            onClick={() => deleteZone(selZone.id)}
            className="h-8 px-3 rounded-full border border-danger/40 text-danger text-xs"
          >
            Borrar
          </button>
          <button
            type="button"
            onClick={() => setSel(null)}
            className="h-8 px-3 rounded-full bg-ink text-bone text-xs font-medium"
          >
            Listo
          </button>
          <span className="w-full text-[11px] text-op-muted mt-1">
            Tocá celdas para agregar o quitar; arrastrá para pintar un bloque.
            La zona puede tener forma irregular.
          </span>
        </SelPanel>
      )}

      {selMarker && (
        <SelPanel title={`Ícono: ${markerLabel(selMarker)}`}>
          <select
            value={selMarker.kind}
            onChange={(e) =>
              setMarkerKindOf(selMarker.id, e.target.value as MarkerKind)
            }
            className="h-8 rounded-full border border-op-border bg-op-surface text-xs px-2"
          >
            {MARKER_KIND_LIST.map((k) => (
              <option key={k} value={k}>
                {MARKER_KINDS[k].icon} {MARKER_KINDS[k].label}
              </option>
            ))}
          </select>
          <input
            type="text"
            value={selMarker.label ?? ""}
            maxLength={40}
            onChange={(e) => setMarkerLabelOf(selMarker.id, e.target.value)}
            className="h-8 w-32 rounded-full border border-op-border bg-op-surface text-xs px-3"
            placeholder={MARKER_KINDS[selMarker.kind].label}
          />
          <button
            type="button"
            onClick={() => setPending({ kind: "moveMarker", id: selMarker.id })}
            className="h-8 px-3 rounded-full border border-op-border text-xs"
          >
            Mover
          </button>
          <button
            type="button"
            onClick={() => deleteMarker(selMarker.id)}
            className="h-8 px-3 rounded-full border border-danger/40 text-danger text-xs"
          >
            Borrar
          </button>
        </SelPanel>
      )}

      {/* Lienzo — pt-6 reserva espacio arriba para los labels de zona que
          se apoyan sobre la raya superior cuando no hay celda libre. */}
      <div className="rounded-2xl border border-op-border bg-op-bg px-2 pb-2 pt-6 overflow-auto max-h-[68vh]">
        <div
          ref={gridRef}
          className="relative mx-auto"
          style={{ width: gridW, height: gridH }}
          onClick={() => {
            // El click sintético tras soltar un drag no debe deseleccionar.
            if (dragEndedRef.current) return;
            // Click en el contenedor (fuera de celdas/elementos) deselecciona.
            if (!pending) setSel(null);
          }}
        >
          {/* Capa 1: zonas (celdas, forma posiblemente irregular; visual).
              Cada celda dibuja borde sólo en los lados que dan al exterior
              de la zona → contorno limpio sin líneas internas. */}
          {zones.map((z) => {
            const c = ZONE_KINDS[z.kind];
            const isSel = sel?.type === "zone" && sel.id === z.id;
            const cellSet = new Set(z.cells.map((cc) => cellKey(cc.x, cc.y)));
            const has = (x: number, y: number) => cellSet.has(cellKey(x, y));
            const bw = isSel ? 2 : 1.5;
            const style = isSel ? "solid" : "dashed";
            return (
              <div key={z.id} className="absolute inset-0 pointer-events-none">
                {z.cells.map((cell) => (
                  <div
                    key={cellKey(cell.x, cell.y)}
                    className="absolute"
                    style={{
                      left: cell.x * cellPx,
                      top: cell.y * cellPx,
                      width: cellPx,
                      height: cellPx,
                      background: c.fill,
                      borderTop: !has(cell.x, cell.y - 1)
                        ? `${bw}px ${style} ${c.stroke}`
                        : undefined,
                      borderBottom: !has(cell.x, cell.y + 1)
                        ? `${bw}px ${style} ${c.stroke}`
                        : undefined,
                      borderLeft: !has(cell.x - 1, cell.y)
                        ? `${bw}px ${style} ${c.stroke}`
                        : undefined,
                      borderRight: !has(cell.x + 1, cell.y)
                        ? `${bw}px ${style} ${c.stroke}`
                        : undefined,
                    }}
                  />
                ))}
              </div>
            );
          })}

          {/* Capa 2: grilla de toque (captura clicks de celdas vacías) */}
          <div
            className="absolute inset-0 grid"
            style={{
              gridTemplateColumns: `repeat(${cols}, ${cellPx}px)`,
              gridTemplateRows: `repeat(${rows}, ${cellPx}px)`,
            }}
          >
            {Array.from({ length: cols * rows }).map((_, i) => {
              const x = i % cols;
              const y = Math.floor(i / cols);
              const isOver = drag?.over?.x === x && drag?.over?.y === y;
              // Modo edición de zona: creando una nueva (addZone) o con una
              // zona seleccionada (toca para agregar/quitar, arrastra para
              // pintar un bloque).
              const zoneEditActive =
                pending?.kind === "addZone" || sel?.type === "zone";
              return (
                <button
                  key={i}
                  type="button"
                  onPointerDown={(e) => {
                    if (zoneEditActive) {
                      e.stopPropagation();
                      startZoneDraw(e, x, y);
                    }
                  }}
                  onPointerMove={(e) => {
                    if (zoneDraw) moveZoneDraw(e);
                  }}
                  onPointerUp={() => {
                    if (zoneDraw) endZoneDraw();
                  }}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (dragEndedRef.current) return;
                    onCellTap(x, y);
                  }}
                  // Evitar scroll de la página mientras se pinta una zona.
                  style={zoneEditActive ? { touchAction: "none" } : undefined}
                  className={
                    "border border-dashed " +
                    (isOver
                      ? "border-terracotta bg-terracotta/20"
                      : pending || zoneEditActive
                        ? "border-op-border/50 hover:border-terracotta hover:bg-terracotta/10"
                        : "border-op-border/25")
                  }
                />
              );
            })}
          </div>

          {/* Vista previa del bloque que se está arrastrando (crear o
              agregar a la zona seleccionada). */}
          {zoneDraw &&
            (() => {
              const zx = Math.min(zoneDraw.sx, zoneDraw.cx);
              const zy = Math.min(zoneDraw.sy, zoneDraw.cy);
              const zw = Math.abs(zoneDraw.cx - zoneDraw.sx) + 1;
              const zh = Math.abs(zoneDraw.cy - zoneDraw.sy) + 1;
              const kind =
                pending?.kind === "addZone"
                  ? pending.zoneKind
                  : (selZone?.kind ?? "custom");
              const c = ZONE_KINDS[kind];
              return (
                <div
                  className="absolute rounded-lg pointer-events-none z-20"
                  style={{
                    left: zx * cellPx + 2,
                    top: zy * cellPx + 2,
                    width: zw * cellPx - 4,
                    height: zh * cellPx - 4,
                    background: c.fill,
                    border: `2px solid ${c.stroke}`,
                  }}
                />
              );
            })()}

          {/* Capa 3: markers (visual) */}
          {markers.map((m) => {
            const k = MARKER_KINDS[m.kind];
            const isSel = sel?.type === "marker" && sel.id === m.id;
            const isEntrance = m.kind === "entrada";
            return (
              <div
                key={m.id}
                className="absolute flex flex-col items-center justify-center rounded-lg"
                style={{
                  left: m.x * cellPx + 2,
                  top: m.y * cellPx + 2,
                  width: cellPx - 4,
                  height: cellPx - 4,
                  pointerEvents: "none",
                  background: isEntrance
                    ? "rgba(193,73,46,0.14)"
                    : "rgba(0,0,0,0.05)",
                  border: isSel
                    ? "2px solid var(--terracotta, #c1492e)"
                    : isEntrance
                      ? "1.5px solid rgba(193,73,46,0.55)"
                      : "1px solid rgba(0,0,0,0.15)",
                }}
                title={markerLabel(m)}
              >
                <span style={{ fontSize: Math.min(20, cellPx * 0.5) }}>
                  {k.icon}
                </span>
                {/* Etiqueta siempre visible (texto), justo debajo del ícono.
                    Se desborda horizontal para leerse aunque la celda sea
                    chica — clave para que la gente entienda "Entrada". */}
                <span
                  className="absolute left-1/2 -translate-x-1/2 text-[9px] font-semibold leading-none px-1 py-0.5 rounded whitespace-nowrap z-10"
                  style={{
                    top: "100%",
                    marginTop: 1,
                    color: isEntrance ? "#8f3420" : "#5b5b5b",
                    background: isEntrance
                      ? "rgba(193,73,46,0.16)"
                      : "rgba(255,255,255,0.92)",
                  }}
                >
                  {markerLabel(m)}
                </span>
              </div>
            );
          })}

          {/* Capa 4: mesas (clickeables + arrastrables) */}
          {placed.map((t) => {
            const isSel = sel?.type === "table" && sel.id === t.id;
            const isDragging = drag?.tableId === t.id && drag.moved;
            return (
              <button
                key={t.id}
                type="button"
                onPointerDown={(e) => startTableDrag(e, t.id)}
                onPointerMove={onTableDragMove}
                onPointerUp={endTableDrag}
                onClick={(e) => {
                  // El drag/tap se maneja por punteros. El click sólo sirve
                  // para resolver una acción pendiente (modo "tocá una celda").
                  e.stopPropagation();
                  if (pending) handleTableClick(t);
                }}
                className={
                  "absolute flex flex-col items-center justify-center text-[10px] font-medium leading-none p-0.5 border transition-colors touch-none select-none " +
                  shapeClass(t.shape) +
                  " " +
                  (isSel
                    ? "bg-ink text-bone border-ink z-10"
                    : "bg-op-surface text-op-text border-op-border") +
                  (pending ? " cursor-pointer" : " cursor-grab active:cursor-grabbing")
                }
                style={{
                  left: (t.x as number) * cellPx + 3,
                  top: (t.y as number) * cellPx + 3,
                  width: cellPx - 6,
                  height: cellPx - 6,
                  opacity: isDragging ? 0.3 : 1,
                  // Editando una zona (creando o con una seleccionada), las
                  // mesas no bloquean: el puntero pasa a las celdas de abajo
                  // para poder pintar/togglear celdas bajo una mesa.
                  pointerEvents:
                    pending?.kind === "addZone" || sel?.type === "zone"
                      ? "none"
                      : undefined,
                }}
              >
                <span className="font-display text-xs">
                  {t.label && t.label.length <= 4 ? t.label : `M${t.number}`}
                </span>
                <span className="opacity-60 text-[9px]">{t.capacity}p</span>
              </button>
            );
          })}

          {/* Capa 5: etiquetas de zona — encima de todo. Se anclan sobre
              una celda LIBRE del borde superior (sin mesa encima) para no
              tapar mesas; si todas están ocupadas, se ponen arriba de la
              raya (en el margen superior reservado). */}
          {zones.map((z) => {
            if (!z.label.trim()) return null; // zona sin nombre → sin label
            const c = ZONE_KINDS[z.kind];
            const a = zoneLabelAnchor(z.cells, occupiedCellKeys);
            const left = a.x * cellPx;
            const top = a.y * cellPx;
            // Esquina libre → label ADENTRO (arriba-izquierda de la zona).
            // Esquina con mesa → label AFUERA, por encima de la raya.
            const transform = a.onFree
              ? "translate(2px, 2px)"
              : "translate(2px, calc(-100% - 1px))";
            return (
              <div
                key={z.id + ":label"}
                className="absolute z-30 pointer-events-none text-[10px] font-semibold leading-none px-1 py-0.5 rounded whitespace-nowrap"
                style={{
                  left,
                  top,
                  transform,
                  color: c.text,
                  background: "rgba(255,255,255,0.92)",
                  border: `1px solid ${c.stroke}`,
                }}
              >
                {z.label}
              </div>
            );
          })}
        </div>
      </div>

      {/* Fantasma que sigue al dedo/cursor mientras se arrastra una mesa */}
      {drag?.moved &&
        (() => {
          const t = tables.find((x) => x.id === drag.tableId);
          if (!t) return null;
          return (
            <div
              className={
                "fixed z-50 pointer-events-none flex flex-col items-center justify-center text-[10px] font-medium leading-none border bg-ink text-bone shadow-lg " +
                shapeClass(t.shape)
              }
              style={{
                left: drag.px,
                top: drag.py,
                width: cellPx - 6,
                height: cellPx - 6,
                transform: "translate(-50%, -50%)",
              }}
            >
              <span className="font-display text-xs">
                {t.label && t.label.length <= 4 ? t.label : `M${t.number}`}
              </span>
            </div>
          );
        })()}

      {/* Bandeja de mesas sin ubicar */}
      {unplaced.length > 0 && (
        <div className="mt-4">
          <div className="font-mono text-[10px] tracking-wider uppercase text-op-muted mb-2">
            Sin ubicar — arrastrá al mapa, o tocá una y después una celda
          </div>
          <div className="flex flex-wrap gap-2">
            {unplaced.map((t) => (
              <button
                key={t.id}
                type="button"
                onPointerDown={(e) => startTableDrag(e, t.id)}
                onPointerMove={onTableDragMove}
                onPointerUp={endTableDrag}
                className={
                  "h-11 px-4 rounded-xl border text-sm font-medium touch-none select-none cursor-grab active:cursor-grabbing " +
                  (pending?.kind === "placeTable" && pending.id === t.id
                    ? "bg-ink text-bone border-ink"
                    : "bg-op-surface border-op-border text-op-text")
                }
              >
                {t.label ?? `Mesa ${t.number}`}{" "}
                <span className="opacity-60 text-xs">{t.capacity}p</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Lista de zonas/íconos para seleccionar y editar */}
      {(zones.length > 0 || markers.length > 0) && (
        <div className="mt-4">
          <div className="font-mono text-[10px] tracking-wider uppercase text-op-muted mb-2">
            Zonas e íconos — tocá para editar
          </div>
          <div className="flex flex-wrap gap-2">
            {zones.map((z) => {
              const c = ZONE_KINDS[z.kind];
              const isSel = sel?.type === "zone" && sel.id === z.id;
              return (
                <button
                  key={z.id}
                  type="button"
                  onClick={() => {
                    setPending(null);
                    setSel({ type: "zone", id: z.id });
                  }}
                  className={
                    "h-8 px-3 rounded-full border text-xs font-medium inline-flex items-center gap-1.5 " +
                    (isSel ? "ring-2 ring-offset-1" : "")
                  }
                  style={{
                    background: c.fill,
                    borderColor: c.stroke,
                    color: c.text,
                  }}
                >
                  <span
                    className="w-2.5 h-2.5 rounded-sm"
                    style={{ background: c.stroke }}
                  />
                  {z.label || "Sin nombre"}
                </button>
              );
            })}
            {markers.map((m) => {
              const isSel = sel?.type === "marker" && sel.id === m.id;
              return (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => {
                    setPending(null);
                    setSel({ type: "marker", id: m.id });
                  }}
                  className={
                    "h-8 px-3 rounded-full border text-xs font-medium inline-flex items-center gap-1.5 " +
                    (isSel
                      ? "border-terracotta bg-terracotta/10 text-terracotta"
                      : "border-op-border bg-op-surface text-op-text")
                  }
                >
                  <span>{MARKER_KINDS[m.kind].icon}</span>
                  {markerLabel(m)}
                </button>
              );
            })}
          </div>
        </div>
      )}

      <p className="mt-4 text-[11px] text-op-muted">
        Tip: arrastrá las mesas para acomodarlas (o tocá y luego una celda).
        La forma de la mesa (cuadrada / redonda / barra) es solo visual.
        La capacidad y el consumo mínimo se editan en{" "}
        <a
          href="/operator/settings/mesas"
          className="text-terracotta hover:underline"
        >
          Mesas
        </a>
        .
      </p>
    </div>
  );
}

function SelPanel({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mb-3 rounded-xl border border-op-border bg-op-surface px-4 py-2.5 flex items-center justify-between gap-3 text-sm flex-wrap">
      <span className="shrink-0">
        Seleccionado: <strong>{title}</strong>
      </span>
      <div className="flex items-center gap-2 flex-wrap">{children}</div>
    </div>
  );
}

function Stepper({
  label,
  value,
  onDec,
  onInc,
  canDec,
  canInc,
}: {
  label: string;
  value: number;
  onDec: () => void;
  onInc: () => void;
  canDec: boolean;
  canInc: boolean;
}) {
  return (
    <span className="inline-flex items-center gap-1.5 text-op-muted">
      <span className="text-xs">{label}</span>
      <button
        type="button"
        onClick={onDec}
        disabled={!canDec}
        className="w-7 h-7 rounded-full border border-op-border disabled:opacity-30"
      >
        −
      </button>
      <span className="tabular w-5 text-center text-op-text font-medium">
        {value}
      </span>
      <button
        type="button"
        onClick={onInc}
        disabled={!canInc}
        className="w-7 h-7 rounded-full border border-op-border disabled:opacity-30"
      >
        +
      </button>
    </span>
  );
}

function shapeLabel(s: EditorTable["shape"]): string {
  return s === "round" ? "Redonda" : s === "bar" ? "Barra" : "Cuadrada";
}
function shapeClass(s: EditorTable["shape"]): string {
  return s === "round"
    ? "rounded-full"
    : s === "bar"
      ? "rounded-sm"
      : "rounded-md";
}
