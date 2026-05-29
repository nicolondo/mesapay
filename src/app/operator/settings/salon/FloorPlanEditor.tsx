"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";

export type EditorTable = {
  id: string;
  number: number;
  label: string | null;
  capacity: number;
  shape: "square" | "round" | "bar";
  x: number | null;
  y: number | null;
};

// Grilla fija de 10 columnas. Las filas crecen según dónde el operador
// pone mesas (mínimo 6). Coordenadas enteras (col, row) desde 0.
const COLS = 10;
const MIN_ROWS = 6;

export function FloorPlanEditor({
  initialTables,
}: {
  initialTables: EditorTable[];
}) {
  const router = useRouter();
  const [tables, setTables] = useState<EditorTable[]>(initialTables);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const placed = tables.filter((t) => t.x != null && t.y != null);
  const unplaced = tables.filter((t) => t.x == null || t.y == null);

  // Filas necesarias: la fila más baja ocupada + 1 de buffer, mínimo MIN_ROWS.
  const rows = useMemo(() => {
    const maxY = placed.reduce((m, t) => Math.max(m, t.y ?? 0), 0);
    return Math.max(MIN_ROWS, maxY + 2);
  }, [placed]);

  const selected = tables.find((t) => t.id === selectedId) ?? null;

  function occupant(x: number, y: number): EditorTable | undefined {
    return placed.find((t) => t.x === x && t.y === y);
  }

  function placeSelectedAt(x: number, y: number) {
    if (!selected) return;
    const taken = occupant(x, y);
    setTables((ts) =>
      ts.map((t) => {
        if (t.id === selected.id) return { ...t, x, y };
        // Si la celda estaba ocupada por otra, las intercambiamos:
        // la otra va a donde estaba la seleccionada (o a la bandeja).
        if (taken && t.id === taken.id) {
          return { ...t, x: selected.x, y: selected.y };
        }
        return t;
      }),
    );
    setDirty(true);
  }

  function removeFromPlan(id: string) {
    setTables((ts) =>
      ts.map((t) => (t.id === id ? { ...t, x: null, y: null } : t)),
    );
    setDirty(true);
  }

  function cycleShape(id: string) {
    const order: EditorTable["shape"][] = ["square", "round", "bar"];
    setTables((ts) =>
      ts.map((t) =>
        t.id === id
          ? { ...t, shape: order[(order.indexOf(t.shape) + 1) % order.length] }
          : t,
      ),
    );
    setDirty(true);
  }

  function autoArrange() {
    // Acomoda TODAS las mesas en filas de COLS por orden de número.
    setTables((ts) => {
      const sorted = [...ts].sort((a, b) => a.number - b.number);
      return sorted.map((t, i) => ({
        ...t,
        x: i % COLS,
        y: Math.floor(i / COLS),
      }));
    });
    setDirty(true);
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

  return (
    <div>
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2 mb-4">
        <button
          type="button"
          onClick={autoArrange}
          className="h-9 px-3 rounded-full border border-op-border bg-op-surface text-xs font-medium text-op-muted hover:text-op-text"
        >
          Auto-acomodar
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

      {selected && (
        <div className="mb-3 rounded-xl border border-op-border bg-op-surface px-4 py-2.5 flex items-center justify-between gap-3 text-sm">
          <span>
            Seleccionada: <strong>{selected.label ?? `Mesa ${selected.number}`}</strong>
            {selected.x != null
              ? " · tocá una celda para moverla"
              : " · tocá una celda para colocarla"}
          </span>
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={() => cycleShape(selected.id)}
              className="h-8 px-3 rounded-full border border-op-border text-xs"
            >
              Forma: {shapeLabel(selected.shape)}
            </button>
            {selected.x != null && (
              <button
                type="button"
                onClick={() => removeFromPlan(selected.id)}
                className="h-8 px-3 rounded-full border border-danger/40 text-danger text-xs"
              >
                Sacar del plano
              </button>
            )}
          </div>
        </div>
      )}

      {/* Grilla */}
      <div className="rounded-2xl border border-op-border bg-op-bg p-2 overflow-x-auto">
        <div
          className="relative mx-auto"
          style={{
            width: "100%",
            maxWidth: 640,
            aspectRatio: `${COLS} / ${rows}`,
          }}
        >
          {/* Celdas */}
          <div
            className="absolute inset-0 grid"
            style={{
              gridTemplateColumns: `repeat(${COLS}, 1fr)`,
              gridTemplateRows: `repeat(${rows}, 1fr)`,
              gap: 4,
            }}
          >
            {Array.from({ length: COLS * rows }).map((_, i) => {
              const x = i % COLS;
              const y = Math.floor(i / COLS);
              const occ = occupant(x, y);
              return (
                <button
                  key={i}
                  type="button"
                  onClick={() => {
                    if (selected) {
                      placeSelectedAt(x, y);
                      return;
                    }
                    if (occ) setSelectedId(occ.id);
                  }}
                  className={
                    "rounded-md border transition-colors " +
                    (occ
                      ? "border-transparent"
                      : selected
                        ? "border-dashed border-op-border/60 hover:border-terracotta hover:bg-terracotta/5"
                        : "border-dashed border-op-border/40")
                  }
                >
                  {occ && (
                    <span
                      className={
                        "w-full h-full flex flex-col items-center justify-center text-[10px] font-medium leading-none p-0.5 " +
                        (selectedId === occ.id
                          ? "bg-ink text-bone"
                          : "bg-op-surface text-op-text border border-op-border") +
                        " " +
                        shapeClass(occ.shape)
                      }
                    >
                      <span className="font-display text-xs">
                        {occ.label && occ.label.length <= 4
                          ? occ.label
                          : `M${occ.number}`}
                      </span>
                      <span className="opacity-60 text-[9px]">
                        {occ.capacity}p
                      </span>
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {/* Bandeja de mesas sin ubicar */}
      {unplaced.length > 0 && (
        <div className="mt-4">
          <div className="font-mono text-[10px] tracking-wider uppercase text-op-muted mb-2">
            Sin ubicar — tocá una y después una celda
          </div>
          <div className="flex flex-wrap gap-2">
            {unplaced.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => setSelectedId(t.id)}
                className={
                  "h-11 px-4 rounded-xl border text-sm font-medium " +
                  (selectedId === t.id
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

      <p className="mt-4 text-[11px] text-op-muted">
        Tip: la forma (cuadrada / redonda / barra) es solo visual, para
        que el mapa se parezca a tu salón. La capacidad se edita en{" "}
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
