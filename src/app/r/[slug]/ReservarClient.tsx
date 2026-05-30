"use client";

import { useEffect, useRef, useState } from "react";
import {
  type FloorPlan,
  DEFAULT_FLOOR_PLAN,
  ZONE_KINDS,
  MARKER_KINDS,
  markerLabel,
  cellKey,
} from "@/lib/floorPlan";

type AvailTable = {
  id: string;
  number: number;
  label: string | null;
  capacity: number;
  minConsumptionCents: number | null;
  reservationDepositCents: number | null;
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
  kushkiPublicKey,
  kushkiMode,
}: {
  tenantSlug: string;
  tenantName: string;
  logoUrl: string | null;
  city: string | null;
  slotMinutes: number;
  maxAdvanceDays: number;
  policyNote: string | null;
  source: "direct" | "google_maps";
  kushkiPublicKey: string | null;
  kushkiMode: "mock" | "sandbox" | "production";
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
  // Cuando la mesa exige depósito, la reserva queda apartada y pasamos
  // a cobrar el depósito antes de confirmar.
  const [depositStep, setDepositStep] = useState<{
    code: string;
    depositCents: number;
  } | null>(null);

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
      // Mesa con depósito → cobramos antes de confirmar. Si no, listo.
      if (j.requiresDeposit && j.depositCents > 0) {
        setDepositStep({ code: j.confirmationCode, depositCents: j.depositCents });
      } else {
        setDone({ code: j.confirmationCode });
      }
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

  // ── Cobro del depósito ────────────────────────────────────────
  if (depositStep) {
    return (
      <main className="min-h-dvh bg-bone text-ink flex flex-col items-center justify-center px-6 py-12">
        <div className="max-w-sm w-full">
          <div className="text-center mb-5">
            <div className="font-mono text-[10px] tracking-[0.18em] uppercase text-muted mb-1">
              {tenantName}
            </div>
            <h1 className="font-display text-3xl">Apartá tu mesa</h1>
            <p className="text-sm text-muted mt-2">
              {prettyDate(date)} · {selectedSlot?.label} · {partySize}{" "}
              {partySize === 1 ? "persona" : "personas"}
            </p>
            <p className="text-sm text-ink mt-3">
              Esta mesa pide un depósito de{" "}
              <strong>{fmtCOP(depositStep.depositCents)}</strong> para
              confirmar. Se descuenta de tu cuenta cuando llegues.
            </p>
          </div>
          <DepositPay
            tenantSlug={tenantSlug}
            code={depositStep.code}
            depositCents={depositStep.depositCents}
            kushkiPublicKey={kushkiPublicKey}
            kushkiMode={kushkiMode}
            onApproved={() => {
              const code = depositStep.code;
              setDepositStep(null);
              setDone({ code });
            }}
          />
          <p className="text-[11px] text-muted text-center mt-4">
            Tenés unos minutos para completar el pago antes de que la mesa se
            libere. Si no se presentan, el depósito no se devuelve.
          </p>
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
                        {t.reservationDepositCents
                          ? ` · depósito ${fmtCOP(t.reservationDepositCents)}`
                          : ""}
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            </div>
          )}

        {/* Consumo mínimo / depósito informativo de la mesa elegida */}
        {selectedSlot &&
          selectedTableId &&
          (() => {
            const t = selectedSlot.tables.find(
              (x) => x.id === selectedTableId,
            );
            if (!t) return null;
            if (!t.minConsumptionCents && !t.reservationDepositCents)
              return null;
            return (
              <div className="mb-4 text-xs text-muted bg-paper border border-hairline rounded-xl px-4 py-3 space-y-1">
                {t.minConsumptionCents ? (
                  <div>
                    Consumo mínimo:{" "}
                    <strong className="text-ink">
                      {fmtCOP(t.minConsumptionCents)}
                    </strong>
                    .
                  </div>
                ) : null}
                {t.reservationDepositCents ? (
                  <div>
                    Pide un depósito de{" "}
                    <strong className="text-ink">
                      {fmtCOP(t.reservationDepositCents)}
                    </strong>{" "}
                    para apartar — se descuenta de tu cuenta al llegar (no se
                    devuelve si no se presentan).
                  </div>
                ) : null}
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
              {(() => {
                const t = selectedSlot.tables.find(
                  (x) => x.id === selectedTableId,
                );
                const needsDeposit = !!t?.reservationDepositCents;
                if (submitting) return "Reservando…";
                if (needsDeposit)
                  return `Continuar · depósito ${fmtCOP(t!.reservationDepositCents!)}`;
                return `Reservar · ${prettyDate(date)} ${selectedSlot.label}`;
              })()}
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
  const zoneMaxX = Math.max(
    -1,
    ...floorPlan.zones.flatMap((z) => z.cells.map((c) => c.x)),
  );
  const zoneMaxY = Math.max(
    -1,
    ...floorPlan.zones.flatMap((z) => z.cells.map((c) => c.y)),
  );
  const cols = Math.max(
    floorPlan.cols,
    floorTables.reduce((m, t) => Math.max(m, t.x + 1), 0),
    zoneMaxX + 1,
    ...floorPlan.markers.map((m) => m.x + 1),
  );
  const rows = Math.max(
    floorPlan.rows,
    floorTables.reduce((m, t) => Math.max(m, t.y + 1), 0),
    zoneMaxY + 1,
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
        {/* Zonas (fondo) — celdas con borde sólo en los bordes externos.
            El nombre va en una capa aparte (arriba de todo). */}
        {floorPlan.zones.map((z) => {
          const c = ZONE_KINDS[z.kind];
          const cellSet = new Set(z.cells.map((cc) => cellKey(cc.x, cc.y)));
          const has = (x: number, y: number) => cellSet.has(cellKey(x, y));
          return (
            <div key={z.id} className="absolute inset-0 pointer-events-none">
              {z.cells.map((cell) => {
                return (
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
                        ? `1.5px dashed ${c.stroke}`
                        : undefined,
                      borderBottom: !has(cell.x, cell.y + 1)
                        ? `1.5px dashed ${c.stroke}`
                        : undefined,
                      borderLeft: !has(cell.x - 1, cell.y)
                        ? `1.5px dashed ${c.stroke}`
                        : undefined,
                      borderRight: !has(cell.x + 1, cell.y)
                        ? `1.5px dashed ${c.stroke}`
                        : undefined,
                    }}
                  />
                );
              })}
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
              {/* Nombre siempre visible debajo del ícono (la entrada, sobre
                  todo, para que el cliente se ubique). */}
              <span
                className="absolute left-1/2 -translate-x-1/2 text-[9px] font-semibold leading-none px-1 py-0.5 rounded whitespace-nowrap z-10"
                style={{
                  top: "100%",
                  marginTop: 1,
                  color: isEntrance ? "#8f3420" : "#5b5446",
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

        {/* Nombres de zona — capa superior, apoyados sobre la línea de
            arriba de cada zona para que se lean siempre. */}
        {floorPlan.zones.map((z) => {
          const c = ZONE_KINDS[z.kind];
          const xs = z.cells.map((cc) => cc.x);
          const minY = Math.min(...z.cells.map((cc) => cc.y));
          const centerX =
            ((Math.min(...xs) + Math.max(...xs) + 1) / 2) * cellPx;
          const atTop = minY === 0;
          return (
            <div
              key={z.id + ":label"}
              className="absolute z-30 pointer-events-none text-[9px] font-semibold leading-none px-1 py-0.5 rounded whitespace-nowrap"
              style={{
                left: centerX,
                top: minY * cellPx,
                transform: atTop
                  ? "translate(-50%, 2px)"
                  : "translate(-50%, calc(-100% - 1px))",
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
  );
}

/**
 * Form de tarjeta para cobrar el depósito de la reserva. Tokeniza
 * directo contra Kushki (mismo patrón que el checkout de mesa — el PAN
 * sólo viaja a kushkipagos.com, SAQ-A) y luego pega a la ruta del
 * depósito. Sin 3DS por ahora (las tarjetas sandbox aprobadas no lo
 * requieren); si Kushki lo pidiera, declina y el diner reintenta.
 */
function DepositPay({
  tenantSlug,
  code,
  depositCents,
  kushkiPublicKey,
  kushkiMode,
  onApproved,
}: {
  tenantSlug: string;
  code: string;
  depositCents: number;
  kushkiPublicKey: string | null;
  kushkiMode: "mock" | "sandbox" | "production";
  onApproved: () => void;
}) {
  const [number, setNumber] = useState("");
  const [holderName, setHolderName] = useState("");
  const [expiry, setExpiry] = useState("");
  const [cvv, setCvv] = useState("");
  const [email, setEmail] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const isMock = kushkiMode === "mock";

  function formatCardNumber(raw: string) {
    return raw
      .replace(/\D/g, "")
      .slice(0, 19)
      .replace(/(.{4})/g, "$1 ")
      .trim();
  }
  function formatExpiry(raw: string) {
    const digits = raw.replace(/\D/g, "").slice(0, 4);
    if (digits.length < 3) return digits;
    return digits.slice(0, 2) + "/" + digits.slice(2);
  }

  async function pay() {
    setErr(null);
    const digits = number.replace(/\s/g, "");
    if (digits.length < 13 || digits.length > 19) {
      setErr("Número de tarjeta inválido.");
      return;
    }
    if (holderName.trim().length < 3) {
      setErr("Ingresá el nombre como aparece en la tarjeta.");
      return;
    }
    const m = /^(\d{2})\/(\d{2})$/.exec(expiry);
    if (!m || Number(m[1]) < 1 || Number(m[1]) > 12) {
      setErr("Vencimiento en formato MM/YY.");
      return;
    }
    if (!cvv.match(/^\d{3,4}$/)) {
      setErr("CVV inválido.");
      return;
    }
    if (!email.trim() || !email.includes("@")) {
      setErr("Email inválido — Kushki lo requiere.");
      return;
    }

    setBusy(true);
    try {
      let token: string;
      if (isMock || !kushkiPublicKey) {
        token = `mock-card-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      } else {
        const baseUrl =
          kushkiMode === "production"
            ? "https://api.kushkipagos.com"
            : "https://api-uat.kushkipagos.com";
        const res = await fetch(`${baseUrl}/card/v1/tokens`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Public-Merchant-Id": kushkiPublicKey,
          },
          body: JSON.stringify({
            card: {
              number: digits,
              name: holderName.trim(),
              expiryMonth: m[1],
              expiryYear: m[2],
              cvv,
            },
            totalAmount: depositCents / 100,
            currency: "COP",
            isDeferred: false,
            email: email.trim().toLowerCase(),
          }),
        });
        const json: { token?: string; code?: string; message?: string } =
          await res.json().catch(() => ({}));
        if (!res.ok || json.code || !json.token) {
          setErr(
            `${json.message ?? "Error de Kushki"}${json.code ? ` (${json.code})` : ""}`,
          );
          setBusy(false);
          return;
        }
        token = json.token;
      }

      const chargeRes = await fetch(
        `/api/tenant/${tenantSlug}/reservations/${code}/deposit`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ token }),
        },
      );
      const cj = await chargeRes.json().catch(() => ({}));
      if (!chargeRes.ok) {
        setErr(cj.message ?? "No pudimos cobrar el depósito.");
        setBusy(false);
        return;
      }
      if (!cj.approved) {
        setErr(cj.message ?? "Pago rechazado. Probá con otra tarjeta.");
        setBusy(false);
        return;
      }
      onApproved();
    } catch (e) {
      console.error("[deposit] error", e);
      setErr("No pudimos procesar el pago. Intentá de nuevo.");
      setBusy(false);
    }
  }

  return (
    <div className="rounded-2xl border border-hairline bg-paper p-5 space-y-3">
      <label className="block">
        <span className="font-mono text-[10px] tracking-[0.14em] uppercase text-muted">
          Número de tarjeta
        </span>
        <input
          inputMode="numeric"
          autoComplete="cc-number"
          value={number}
          onChange={(e) => setNumber(formatCardNumber(e.target.value))}
          placeholder="1234 5678 9012 3456"
          className="mt-1 w-full h-11 rounded-xl border border-hairline bg-bone px-3 text-sm font-mono tabular focus:outline-none focus:border-ink"
        />
      </label>
      <label className="block">
        <span className="font-mono text-[10px] tracking-[0.14em] uppercase text-muted">
          Nombre en la tarjeta
        </span>
        <input
          autoComplete="cc-name"
          value={holderName}
          onChange={(e) => setHolderName(e.target.value)}
          placeholder="Como aparece en la tarjeta"
          className="mt-1 w-full h-11 rounded-xl border border-hairline bg-bone px-3 text-sm focus:outline-none focus:border-ink"
        />
      </label>
      <div className="grid grid-cols-2 gap-3">
        <label className="block">
          <span className="font-mono text-[10px] tracking-[0.14em] uppercase text-muted">
            Vencimiento
          </span>
          <input
            inputMode="numeric"
            autoComplete="cc-exp"
            value={expiry}
            onChange={(e) => setExpiry(formatExpiry(e.target.value))}
            placeholder="MM/YY"
            className="mt-1 w-full h-11 rounded-xl border border-hairline bg-bone px-3 text-sm font-mono tabular focus:outline-none focus:border-ink"
          />
        </label>
        <label className="block">
          <span className="font-mono text-[10px] tracking-[0.14em] uppercase text-muted">
            CVV
          </span>
          <input
            inputMode="numeric"
            autoComplete="cc-csc"
            value={cvv}
            onChange={(e) => setCvv(e.target.value.replace(/\D/g, "").slice(0, 4))}
            placeholder="123"
            className="mt-1 w-full h-11 rounded-xl border border-hairline bg-bone px-3 text-sm font-mono tabular focus:outline-none focus:border-ink"
          />
        </label>
      </div>
      <label className="block">
        <span className="font-mono text-[10px] tracking-[0.14em] uppercase text-muted">
          Email
        </span>
        <input
          type="email"
          inputMode="email"
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="tu@email.com"
          className="mt-1 w-full h-11 rounded-xl border border-hairline bg-bone px-3 text-sm focus:outline-none focus:border-ink"
        />
      </label>

      {err && (
        <div className="text-sm text-danger bg-danger/5 border border-danger/30 rounded-lg px-3 py-2">
          {err}
        </div>
      )}

      <button
        type="button"
        disabled={busy}
        onClick={pay}
        className="w-full h-12 rounded-full bg-ink text-bone font-medium text-sm disabled:opacity-60"
      >
        {busy ? "Procesando…" : `Pagar depósito · ${fmtCOP(depositCents)}`}
      </button>
      <p className="text-[10px] text-muted text-center">
        Pago seguro procesado por Kushki. Tus datos no se guardan en MESAPAY.
      </p>
    </div>
  );
}
