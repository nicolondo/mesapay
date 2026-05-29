"use client";

import { useEffect, useRef, useState } from "react";
import {
  type FloorPlan,
  DEFAULT_FLOOR_PLAN,
  ZONE_KINDS,
  MARKER_KINDS,
  markerLabel,
} from "@/lib/floorPlan";

type AvailTable = {
  id: string;
  number: number;
  label: string | null;
  capacity: number;
  minConsumptionCents: number | null;
};
type AvailSlot = {
  label: string;
  startsAt: string; // ISO
  endsAt: string;
  tables: AvailTable[];
};
type FloorTable = {
  id: string;
  number: number;
  label: string | null;
  capacity: number;
  minConsumptionCents: number | null;
  shape: "square" | "round" | "bar";
  x: number;
  y: number;
};

const fmtCOP = (cents: number) =>
  "$" + (cents / 100).toLocaleString("es-CO");

/** YYYY-MM-DD de hoy en hora local del browser. Suficiente para el
 *  date picker — el server reinterpreta en Bogotá. */
function todayLocal(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function addDays(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(dt.getUTCDate()).padStart(2, "0")}`;
}
function prettyDate(dateStr: string): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.toLocaleDateString("es-CO", {
    weekday: "long",
    day: "numeric",
    month: "long",
    timeZone: "UTC",
  });
}

export function ReservarClient({
  tenantSlug,
  tenantName,
  logoUrl,
  city,
  slotMinutes,
  maxAdvanceDays,
  policyNote,
  source,
}: {
  tenantSlug: string;
  tenantName: string;
  logoUrl: string | null;
  city: string | null;
  slotMinutes: number;
  maxAdvanceDays: number;
  policyNote: string | null;
  source: "direct" | "google_maps";
}) {
  const [date, setDate] = useState(todayLocal());
  const [partySize, setPartySize] = useState(2);
  const [slots, setSlots] = useState<AvailSlot[]>([]);
  const [floorTables, setFloorTables] = useState<FloorTable[]>([]);
  const [floorPlan, setFloorPlan] = useState<FloorPlan>(DEFAULT_FLOOR_PLAN);
  const [loading, setLoading] = useState(false);
  const [selectedSlot, setSelectedSlot] = useState<AvailSlot | null>(null);
  const [selectedTableId, setSelectedTableId] = useState<string | null>(null);

  // Datos del diner
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [notes, setNotes] = useState("");

  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<{ code: string } | null>(null);

  const maxDate = addDays(todayLocal(), maxAdvanceDays);

  // Cargar disponibilidad cuando cambia fecha o tamaño de grupo.
  useEffect(() => {
    let alive = true;
    setLoading(true);
    setSelectedSlot(null);
    setSelectedTableId(null);
    (async () => {
      try {
        const res = await fetch(
          `/api/tenant/${tenantSlug}/reservations/availability?date=${date}&party=${partySize}`,
        );
        const j = await res.json();
        if (alive && res.ok && Array.isArray(j.slots)) {
          // Sólo slots con al menos una mesa libre.
          setSlots(j.slots.filter((s: AvailSlot) => s.tables.length > 0));
          setFloorTables(Array.isArray(j.floorTables) ? j.floorTables : []);
          if (j.floorPlan && typeof j.floorPlan === "object") {
            setFloorPlan(j.floorPlan as FloorPlan);
          }
        } else if (alive) {
          setSlots([]);
          setFloorTables([]);
        }
      } catch {
        if (alive) {
          setSlots([]);
          setFloorTables([]);
        }
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [tenantSlug, date, partySize]);

  async function submit() {
    if (!selectedSlot || !selectedTableId) return;
    if (!name.trim()) {
      setErr("Decinos tu nombre.");
      return;
    }
    if (!email.trim() || !email.includes("@")) {
      setErr("Email inválido.");
      return;
    }
    setSubmitting(true);
    setErr(null);
    try {
      const res = await fetch(`/api/tenant/${tenantSlug}/reservations`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          tableId: selectedTableId,
          startsAt: selectedSlot.startsAt,
          partySize,
          customerName: name.trim(),
          customerEmail: email.trim().toLowerCase(),
          customerPhone: phone.trim() || undefined,
          notes: notes.trim() || undefined,
          source,
        }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        setErr(j.message ?? j.error ?? "No pudimos crear la reserva.");
        return;
      }
      setDone({ code: j.confirmationCode });
    } finally {
      setSubmitting(false);
    }
  }

  // ── Confirmación ──────────────────────────────────────────────
  if (done) {
    return (
      <main className="min-h-dvh bg-bone text-ink flex flex-col items-center justify-center px-6 py-12">
        <div className="max-w-sm w-full text-center">
          <div className="mx-auto w-14 h-14 rounded-full bg-[#2E6B4C]/15 text-[#1E5339] flex items-center justify-center text-2xl mb-4">
            ✓
          </div>
          <h1 className="font-display text-3xl mb-2">¡Reserva confirmada!</h1>
          <p className="text-sm text-muted mb-1">
            Te esperamos en {tenantName}
          </p>
          <p className="text-sm text-ink mb-6">
            {prettyDate(date)} · {selectedSlot?.label} · {partySize}{" "}
            {partySize === 1 ? "persona" : "personas"}
          </p>
          <div className="rounded-2xl border border-hairline bg-paper p-4 mb-6">
            <div className="font-mono text-[10px] tracking-wider uppercase text-muted">
              Código de reserva
            </div>
            <div className="font-display text-2xl tracking-wide mt-1">
              {done.code}
            </div>
            <p className="text-[11px] text-muted mt-2">
              Te mandamos los detalles a {email}. Guardá este código por
              si necesitás cancelar.
            </p>
          </div>
          <a
            href={`/r/${tenantSlug}/reserva/${done.code}`}
            className="text-sm text-terracotta hover:underline"
          >
            Ver o cancelar mi reserva →
          </a>
        </div>
      </main>
    );
  }

  // ── Flujo de reserva ──────────────────────────────────────────
  return (
    <main className="min-h-dvh bg-bone text-ink">
      <div className="max-w-lg mx-auto px-5 py-8">
        <div className="flex items-center gap-3 mb-1">
          {logoUrl && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={logoUrl}
              alt={tenantName}
              className="w-9 h-9 rounded-full object-cover"
            />
          )}
          <div className="font-mono text-[10px] tracking-[0.18em] uppercase text-muted">
            {city ? `${tenantName} · ${city}` : tenantName}
          </div>
        </div>
        <h1 className="font-display text-4xl tracking-[-0.015em] mb-6">
          Reservá tu mesa
        </h1>

        {/* Paso 1: fecha + grupo */}
        <div className="rounded-2xl border border-hairline bg-paper p-5 mb-4 space-y-4">
          <label className="block">
            <span className="font-mono text-[10px] tracking-[0.14em] uppercase text-muted">
              Fecha
            </span>
            <input
              type="date"
              value={date}
              min={todayLocal()}
              max={maxDate}
              onChange={(e) => setDate(e.target.value)}
              className="mt-1 w-full h-11 rounded-xl border border-hairline bg-bone px-3 text-sm focus:outline-none focus:border-ink"
            />
          </label>
          <div>
            <span className="font-mono text-[10px] tracking-[0.14em] uppercase text-muted">
              ¿Cuántos son?
            </span>
            <div className="mt-1 flex flex-wrap gap-2">
              {[1, 2, 3, 4, 5, 6, 7, 8].map((n) => (
                <button
                  key={n}
                  type="button"
                  onClick={() => setPartySize(n)}
                  className={
                    "w-11 h-11 rounded-xl border text-sm font-medium " +
                    (partySize === n
                      ? "bg-ink text-bone border-ink"
                      : "bg-bone border-hairline text-ink")
                  }
                >
                  {n}
                  {n === 8 ? "+" : ""}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Paso 2: slots */}
        <div className="mb-4">
          <div className="font-mono text-[10px] tracking-[0.14em] uppercase text-muted mb-2">
            Horarios disponibles · {prettyDate(date)}
          </div>
          {loading ? (
            <div className="grid grid-cols-3 gap-2">
              {[0, 1, 2, 3, 4, 5].map((i) => (
                <div
                  key={i}
                  className="h-11 rounded-xl bg-hairline animate-pulse"
                />
              ))}
            </div>
          ) : slots.length === 0 ? (
            <div className="rounded-xl border border-hairline bg-paper px-4 py-6 text-center text-sm text-muted">
              No hay horarios disponibles para esta fecha. Probá otro día.
            </div>
          ) : (
            <div className="grid grid-cols-3 gap-2">
              {slots.map((s) => (
                <button
                  key={s.startsAt}
                  type="button"
                  onClick={() => {
                    setSelectedSlot(s);
                    setSelectedTableId(
                      s.tables.length === 1 ? s.tables[0].id : null,
                    );
                  }}
                  className={
                    "h-11 rounded-xl border text-sm font-medium " +
                    (selectedSlot?.startsAt === s.startsAt
                      ? "bg-ink text-bone border-ink"
                      : "bg-paper border-hairline text-ink hover:border-ink")
                  }
                >
                  {s.label}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Paso 3: elegir mesa. Si el operador diseñó el mapa del
            salón (floorTables con coords), mostramos el plano visual;
            si no, caemos al picker de lista. Solo cuando el slot
            ofrece más de una opción. */}
        {selectedSlot &&
          selectedSlot.tables.length > 1 &&
          floorTables.length > 0 && (
            <div className="mb-4">
              <div className="font-mono text-[10px] tracking-[0.14em] uppercase text-muted mb-2">
                Elegí tu mesa en el mapa
              </div>
              <FloorPlanPicker
                floorTables={floorTables}
                floorPlan={floorPlan}
                freeIds={new Set(selectedSlot.tables.map((t) => t.id))}
                selectedTableId={selectedTableId}
                onPick={setSelectedTableId}
              />
              <div className="flex items-center gap-4 mt-2 text-[11px] text-muted">
                <span className="inline-flex items-center gap-1">
                  <span className="w-3 h-3 rounded bg-[#2E6B4C]/20 border border-[#2E6B4C]/40 inline-block" />
                  Disponible
                </span>
                <span className="inline-flex items-center gap-1">
                  <span className="w-3 h-3 rounded bg-hairline inline-block" />
                  Ocupada / no disponible
                </span>
              </div>
            </div>
          )}

        {/* Fallback: picker de lista cuando no hay mapa diseñado. */}
        {selectedSlot &&
          selectedSlot.tables.length > 1 &&
          floorTables.length === 0 && (
            <div className="mb-4">
              <div className="font-mono text-[10px] tracking-[0.14em] uppercase text-muted mb-2">
                Elegí tu mesa
              </div>
              <div className="space-y-2">
                {selectedSlot.tables.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => setSelectedTableId(t.id)}
                    className={
                      "w-full rounded-xl border px-4 py-3 flex items-center justify-between text-left " +
                      (selectedTableId === t.id
                        ? "bg-ink text-bone border-ink"
                        : "bg-paper border-hairline text-ink hover:border-ink")
                    }
                  >
                    <div>
                      <div className="font-medium text-sm">
                        {t.label ?? `Mesa ${t.number}`}
                      </div>
                      <div
                        className={
                          "text-[11px] " +
                          (selectedTableId === t.id
                            ? "opacity-70"
                            : "text-muted")
                        }
                      >
                        Hasta {t.capacity} personas
                        {t.minConsumptionCents
                          ? ` · consumo mínimo ${fmtCOP(t.minConsumptionCents)}`
                          : ""}
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            </div>
          )}

        {/* Consumo mínimo informativo de la mesa elegida (cuando hay 1 sola) */}
        {selectedSlot &&
          selectedTableId &&
          (() => {
            const t = selectedSlot.tables.find(
              (x) => x.id === selectedTableId,
            );
            if (!t?.minConsumptionCents) return null;
            return (
              <div className="mb-4 text-xs text-muted bg-paper border border-hairline rounded-xl px-4 py-3">
                Esta mesa tiene un consumo mínimo de{" "}
                <strong className="text-ink">
                  {fmtCOP(t.minConsumptionCents)}
                </strong>
                .
              </div>
            );
          })()}

        {/* Paso 4: datos + confirmar */}
        {selectedSlot && selectedTableId && (
          <div className="rounded-2xl border border-hairline bg-paper p-5 space-y-3">
            <div className="font-display text-lg">Tus datos</div>
            <input
              type="text"
              placeholder="Nombre"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full h-11 rounded-xl border border-hairline bg-bone px-3 text-sm focus:outline-none focus:border-ink"
            />
            <input
              type="email"
              placeholder="Email"
              inputMode="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full h-11 rounded-xl border border-hairline bg-bone px-3 text-sm focus:outline-none focus:border-ink"
            />
            <input
              type="tel"
              placeholder="Teléfono (opcional)"
              inputMode="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              className="w-full h-11 rounded-xl border border-hairline bg-bone px-3 text-sm focus:outline-none focus:border-ink"
            />
            <textarea
              placeholder="Algo que debamos saber (opcional): cumpleaños, alergias, mesa cerca de ventana…"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
              maxLength={300}
              className="w-full rounded-xl border border-hairline bg-bone px-3 py-2 text-sm focus:outline-none focus:border-ink"
            />

            {policyNote && (
              <p className="text-[11px] text-muted">{policyNote}</p>
            )}
            {err && (
              <div className="text-sm text-danger bg-danger/5 border border-danger/30 rounded-lg px-3 py-2">
                {err}
              </div>
            )}

            <button
              type="button"
              disabled={submitting}
              onClick={submit}
              className="w-full h-12 rounded-full bg-ink text-bone font-medium text-sm disabled:opacity-60"
            >
              {submitting
                ? "Reservando…"
                : `Reservar · ${prettyDate(date)} ${selectedSlot.label}`}
            </button>
          </div>
        )}
      </div>
    </main>
  );
}

/**
 * Mapa del salón read-only para que el diner elija mesa visualmente y
 * se ubique en el local. Dibuja: zonas (jardín, terraza…), íconos
 * (entrada, baños…) y las mesas en sus coords. Las mesas libres que
 * entran al grupo (id en freeIds) van en verde y son tappables; el
 * resto en gris. La seleccionada se resalta en ink.
 *
 * El tamaño de celda (cellPx) se calcula del ancho real del contenedor
 * para que el plano llene la pantalla del diner sin scroll horizontal.
 */
function FloorPlanPicker({
  floorTables,
  floorPlan,
  freeIds,
  selectedTableId,
  onPick,
}: {
  floorTables: FloorTable[];
  floorPlan: FloorPlan;
  freeIds: Set<string>;
  selectedTableId: string | null;
  onPick: (id: string) => void;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [boxW, setBoxW] = useState(0);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    // clientWidth incluye el padding p-2 (≈16px) → lo descontamos.
    const update = () => setBoxW(Math.max(0, el.clientWidth - 16));
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Ampliar la grilla si hay datos viejos por fuera de cols/rows guardados.
  const cols = Math.max(
    floorPlan.cols,
    floorTables.reduce((m, t) => Math.max(m, t.x + 1), 0),
    ...floorPlan.zones.map((z) => z.x + z.w),
    ...floorPlan.markers.map((m) => m.x + 1),
  );
  const rows = Math.max(
    floorPlan.rows,
    floorTables.reduce((m, t) => Math.max(m, t.y + 1), 0),
    ...floorPlan.zones.map((z) => z.y + z.h),
    ...floorPlan.markers.map((m) => m.y + 1),
  );

  const cellPx =
    boxW > 0 ? Math.min(64, Math.max(22, Math.floor(boxW / cols))) : 40;
  const gridW = cols * cellPx;
  const gridH = rows * cellPx;

  return (
    <div
      ref={wrapRef}
      className="rounded-2xl border border-hairline bg-paper p-2 overflow-auto"
    >
      <div className="relative mx-auto" style={{ width: gridW, height: gridH }}>
        {/* Zonas (fondo) */}
        {floorPlan.zones.map((z) => {
          const c = ZONE_KINDS[z.kind];
          return (
            <div
              key={z.id}
              className="absolute rounded-lg"
              style={{
                left: z.x * cellPx + 2,
                top: z.y * cellPx + 2,
                width: z.w * cellPx - 4,
                height: z.h * cellPx - 4,
                background: c.fill,
                border: `1.5px dashed ${c.stroke}`,
              }}
            >
              <span
                className="absolute top-1 left-1.5 text-[9px] font-semibold leading-none px-1 py-0.5 rounded"
                style={{ color: c.text, background: "rgba(255,255,255,0.6)" }}
              >
                {z.label}
              </span>
            </div>
          );
        })}

        {/* Íconos (entrada, baños…) */}
        {floorPlan.markers.map((m) => {
          const k = MARKER_KINDS[m.kind];
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
                background: isEntrance
                  ? "rgba(193,73,46,0.14)"
                  : "rgba(0,0,0,0.05)",
                border: isEntrance
                  ? "1.5px solid rgba(193,73,46,0.55)"
                  : "1px solid rgba(0,0,0,0.12)",
              }}
              title={markerLabel(m)}
            >
              <span style={{ fontSize: Math.min(20, cellPx * 0.5) }}>
                {k.icon}
              </span>
              {cellPx >= 40 && (
                <span className="text-[8px] leading-none text-muted mt-0.5 truncate max-w-full px-0.5">
                  {markerLabel(m)}
                </span>
              )}
            </div>
          );
        })}

        {/* Mesas (frente) */}
        {floorTables.map((t) => {
          const free = freeIds.has(t.id);
          const selected = selectedTableId === t.id;
          const radius = t.shape === "round" ? "rounded-full" : "rounded-md";
          return (
            <button
              key={t.id}
              type="button"
              disabled={!free}
              onClick={() => free && onPick(t.id)}
              title={
                free
                  ? `${t.label ?? `Mesa ${t.number}`} · hasta ${t.capacity}`
                  : "No disponible"
              }
              className={
                "absolute flex flex-col items-center justify-center text-[10px] font-medium leading-none p-0.5 border transition-colors " +
                radius +
                " " +
                (selected
                  ? "bg-ink text-bone border-ink z-10"
                  : free
                    ? "bg-[#2E6B4C]/15 text-[#1E5339] border-[#2E6B4C]/40 hover:bg-[#2E6B4C]/25"
                    : "bg-hairline text-muted border-transparent cursor-not-allowed")
              }
              style={{
                left: t.x * cellPx + 3,
                top: t.y * cellPx + 3,
                width: cellPx - 6,
                height: cellPx - 6,
              }}
            >
              <span className="font-display text-xs">
                {t.label && t.label.length <= 4 ? t.label : `M${t.number}`}
              </span>
              <span className="opacity-60 text-[9px]">{t.capacity}p</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
