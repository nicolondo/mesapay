"use client";

import { useEffect, useRef, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import type { Locale } from "@/i18n/config";
import { fmtCOP, formatDate } from "@/lib/format";
import { ApplePayButton } from "@/app/t/[slug]/pay/[orderId]/ApplePayButton";
import {
  type FloorPlan,
  DEFAULT_FLOOR_PLAN,
  ZONE_KINDS,
  MARKER_KINDS,
  markerLabel,
  cellKey,
  zoneLabelAnchor,
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
function prettyDate(dateStr: string, locale: Locale): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return formatDate(dt, {
    locale,
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
  pseBanks,
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
  pseBanks: { code: string; name: string }[];
}) {
  const tr = useTranslations("reservar");
  const locale = useLocale() as Locale;
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
    methods: string[];
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
      setErr(tr("errName"));
      return;
    }
    if (!email.trim() || !email.includes("@")) {
      setErr(tr("errEmail"));
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
        setErr(j.message ?? j.error ?? tr("errCreate"));
        return;
      }
      // Mesa con depósito → cobramos antes de confirmar. Si no, listo.
      if (j.requiresDeposit && j.depositCents > 0) {
        setDepositStep({
          code: j.confirmationCode,
          depositCents: j.depositCents,
          methods: Array.isArray(j.depositMethods) ? j.depositMethods : [],
        });
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
            {"✓"}
          </div>
          <h1 className="font-display text-3xl mb-2">{tr("confirmedTitle")}</h1>
          <p className="text-sm text-muted mb-1">
            {tr("seeYouAt", { name: tenantName })}
          </p>
          <p className="text-sm text-ink mb-6">
            {prettyDate(date, locale)} · {selectedSlot?.label} · {partySize}{" "}
            {partySize === 1 ? tr("person") : tr("people")}
          </p>
          <div className="rounded-2xl border border-hairline bg-paper p-4 mb-6">
            <div className="font-mono text-[10px] tracking-wider uppercase text-muted">
              {tr("reservationCode")}
            </div>
            <div className="font-display text-2xl tracking-wide mt-1">
              {done.code}
            </div>
            <p className="text-[11px] text-muted mt-2">
              {tr("detailsSent", { email })}
            </p>
          </div>
          <a
            href={`/r/${tenantSlug}/reserva/${done.code}`}
            className="text-sm text-terracotta hover:underline"
          >
            {tr("viewOrCancel")}
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
            <h1 className="font-display text-3xl">{tr("holdYourTable")}</h1>
            <p className="text-sm text-muted mt-2">
              {prettyDate(date, locale)} · {selectedSlot?.label} · {partySize}{" "}
              {partySize === 1 ? tr("person") : tr("people")}
            </p>
            <p className="text-sm text-ink mt-3">
              {tr.rich("depositExplain", {
                amount: fmtCOP(depositStep.depositCents),
                b: (chunks) => <strong>{chunks}</strong>,
              })}
            </p>
          </div>
          <DepositPay
            tenantSlug={tenantSlug}
            code={depositStep.code}
            depositCents={depositStep.depositCents}
            methods={depositStep.methods}
            kushkiPublicKey={kushkiPublicKey}
            kushkiMode={kushkiMode}
            pseBanks={pseBanks}
            onApproved={() => {
              const code = depositStep.code;
              setDepositStep(null);
              setDone({ code });
            }}
          />
          <p className="text-[11px] text-muted text-center mt-4">
            {tr("depositTimerNote")}
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
          {tr("title")}
        </h1>

        {/* Paso 1: fecha + grupo */}
        <div className="rounded-2xl border border-hairline bg-paper p-5 mb-4 space-y-4">
          <label className="block">
            <span className="font-mono text-[10px] tracking-[0.14em] uppercase text-muted">
              {tr("dateLabel")}
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
              {tr("howMany")}
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
            {tr("availableTimes", { date: prettyDate(date, locale) })}
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
              {tr("noSlots")}
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
                {tr("pickTableMap")}
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
                  {tr("available")}
                </span>
                <span className="inline-flex items-center gap-1">
                  <span className="w-3 h-3 rounded bg-hairline inline-block" />
                  {tr("occupied")}
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
                {tr("pickTable")}
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
                        {t.label ?? tr("tableN", { number: t.number })}
                      </div>
                      <div
                        className={
                          "text-[11px] " +
                          (selectedTableId === t.id
                            ? "opacity-70"
                            : "text-muted")
                        }
                      >
                        {tr("upToPeople", { count: t.capacity })}
                        {t.minConsumptionCents
                          ? " · " +
                            tr("minConsumptionInline", {
                              amount: fmtCOP(t.minConsumptionCents),
                            })
                          : ""}
                        {t.reservationDepositCents
                          ? " · " +
                            tr("depositInline", {
                              amount: fmtCOP(t.reservationDepositCents),
                            })
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
                    {tr.rich("minConsumptionInfo", {
                      amount: fmtCOP(t.minConsumptionCents),
                      b: (chunks) => (
                        <strong className="text-ink">{chunks}</strong>
                      ),
                    })}
                  </div>
                ) : null}
                {t.reservationDepositCents ? (
                  <div>
                    {tr.rich("depositInfo", {
                      amount: fmtCOP(t.reservationDepositCents),
                      b: (chunks) => (
                        <strong className="text-ink">{chunks}</strong>
                      ),
                    })}
                  </div>
                ) : null}
              </div>
            );
          })()}

        {/* Paso 4: datos + confirmar */}
        {selectedSlot && selectedTableId && (
          <div className="rounded-2xl border border-hairline bg-paper p-5 space-y-3">
            <div className="font-display text-lg">{tr("yourData")}</div>
            <input
              type="text"
              placeholder={tr("namePlaceholder")}
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full h-11 rounded-xl border border-hairline bg-bone px-3 text-sm focus:outline-none focus:border-ink"
            />
            <input
              type="email"
              placeholder={tr("email")}
              inputMode="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full h-11 rounded-xl border border-hairline bg-bone px-3 text-sm focus:outline-none focus:border-ink"
            />
            <input
              type="tel"
              placeholder={tr("phonePlaceholder")}
              inputMode="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              className="w-full h-11 rounded-xl border border-hairline bg-bone px-3 text-sm focus:outline-none focus:border-ink"
            />
            <textarea
              placeholder={tr("notesPlaceholder")}
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
                if (submitting) return tr("submitting");
                if (needsDeposit)
                  return tr("continueDeposit", {
                    amount: fmtCOP(t!.reservationDepositCents!),
                  });
                return tr("reserveCta", {
                  when: `${prettyDate(date, locale)} ${selectedSlot.label}`,
                });
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
  const tr = useTranslations("reservar");
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
      className="rounded-2xl border border-hairline bg-paper px-2 pb-2 pt-6 overflow-auto"
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
                  ? tr("tableTitleFree", {
                      name: t.label ?? tr("tableN", { number: t.number }),
                      capacity: t.capacity,
                    })
                  : tr("unavailable")
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
              <span className="opacity-60 text-[9px]">
                {tr("capacityShort", { count: t.capacity })}
              </span>
            </button>
          );
        })}

        {/* Nombres de zona — capa superior. Se apoyan sobre una celda
            libre del borde superior (sin mesa); si todas están ocupadas,
            arriba de la raya (en el margen reservado). */}
        {floorPlan.zones.map((z) => {
          if (!z.label.trim()) return null; // zona sin nombre → sin label
          const c = ZONE_KINDS[z.kind];
          const occupied = new Set(
            floorTables.map((t) => cellKey(t.x, t.y)),
          );
          const a = zoneLabelAnchor(z.cells, occupied);
          const transform = a.onFree
            ? "translate(2px, 2px)"
            : "translate(2px, calc(-100% - 1px))";
          return (
            <div
              key={z.id + ":label"}
              className="absolute z-30 pointer-events-none text-[9px] font-semibold leading-none px-1 py-0.5 rounded whitespace-nowrap"
              style={{
                left: a.x * cellPx,
                top: a.y * cellPx,
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
  );
}

// Valores = claves del catálogo `reservar` (resueltas con tr en render).
const DEPOSIT_METHOD_NAMES: Record<string, string> = {
  kushki_card: "methodCard",
  kushki_pse: "methodPse",
  kushki_apple_pay: "methodApplePay",
};

/**
 * Cobro del depósito de una reserva. Es un selector de medio (según los
 * que el comercio habilitó) que renderiza el sub-flujo correspondiente:
 * Tarjeta (form), PSE (banco + redirect) o Apple Pay (sheet nativo).
 */
function DepositPay({
  tenantSlug,
  code,
  depositCents,
  methods,
  kushkiPublicKey,
  kushkiMode,
  pseBanks,
  onApproved,
}: {
  tenantSlug: string;
  code: string;
  depositCents: number;
  methods: string[];
  kushkiPublicKey: string | null;
  kushkiMode: "mock" | "sandbox" | "production";
  pseBanks: { code: string; name: string }[];
  onApproved: () => void;
}) {
  // Apple Pay sólo se ofrece si el navegador realmente lo soporta
  // (Safari en iPhone/Mac). En el resto lo ocultamos del selector para
  // no mostrar una opción muerta.
  const tr = useTranslations("reservar");
  const [appleOk, setAppleOk] = useState(false);
  const [selected, setSelected] = useState("");
  useEffect(() => {
    try {
      const w = window as unknown as {
        ApplePaySession?: { canMakePayments?: () => boolean };
      };
      setAppleOk(!!w.ApplePaySession?.canMakePayments?.());
    } catch {
      /* sin soporte */
    }
  }, []);

  const known = methods.filter((m) => m in DEPOSIT_METHOD_NAMES);
  const available = known.filter(
    (m) => m !== "kushki_apple_pay" || appleOk,
  );
  // Si filtrar dejó la lista vacía (p.ej. sólo Apple Pay y no es Safari),
  // mostramos igual lo configurado para explicar por qué no se puede.
  const list = available.length > 0 ? available : known;
  const effective = selected || (list.length === 1 ? list[0] : "");

  // Selector cuando hay más de un medio.
  if (!effective) {
    return (
      <div className="rounded-2xl border border-hairline bg-paper p-5 space-y-2">
        <div className="text-sm font-medium text-ink mb-1">
          {tr("howPayDeposit")}
        </div>
        {list.map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => setSelected(m)}
            className="w-full h-12 rounded-xl border border-hairline bg-bone text-sm font-medium text-ink flex items-center justify-between px-4 hover:border-ink"
          >
            <span>{tr(DEPOSIT_METHOD_NAMES[m])}</span>
            <span className="text-muted">{"→"}</span>
          </button>
        ))}
      </div>
    );
  }

  const backBtn =
    list.length > 1 ? (
      <button
        type="button"
        onClick={() => setSelected("")}
        className="mt-2 w-full text-center text-xs text-muted hover:text-ink"
      >
        ← {tr("chooseAnother")}
      </button>
    ) : null;

  if (effective === "kushki_pse") {
    return (
      <>
        <DepositPse
          tenantSlug={tenantSlug}
          code={code}
          depositCents={depositCents}
          kushkiPublicKey={kushkiPublicKey}
          kushkiMode={kushkiMode}
          initialBanks={pseBanks}
        />
        {backBtn}
      </>
    );
  }

  if (effective === "kushki_apple_pay") {
    return (
      <>
        <DepositApplePay
          tenantSlug={tenantSlug}
          code={code}
          depositCents={depositCents}
          kushkiPublicKey={kushkiPublicKey}
          kushkiMode={kushkiMode}
          onApproved={onApproved}
        />
        {backBtn}
      </>
    );
  }

  return (
    <>
      <DepositCard
        tenantSlug={tenantSlug}
        code={code}
        depositCents={depositCents}
        kushkiPublicKey={kushkiPublicKey}
        kushkiMode={kushkiMode}
        onApproved={onApproved}
      />
      {backBtn}
    </>
  );
}

/**
 * Form de tarjeta para cobrar el depósito de la reserva. Tokeniza
 * directo contra Kushki (mismo patrón que el checkout de mesa — el PAN
 * sólo viaja a kushkipagos.com, SAQ-A) y luego pega a la ruta del
 * depósito. Sin 3DS por ahora (las tarjetas sandbox aprobadas no lo
 * requieren); si Kushki lo pidiera, declina y el diner reintenta.
 */
function DepositCard({
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
  const tr = useTranslations("reservar");
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
      setErr(tr("errCardNumber"));
      return;
    }
    if (holderName.trim().length < 3) {
      setErr(tr("errCardName"));
      return;
    }
    const m = /^(\d{2})\/(\d{2})$/.exec(expiry);
    if (!m || Number(m[1]) < 1 || Number(m[1]) > 12) {
      setErr(tr("errExpiry"));
      return;
    }
    if (!cvv.match(/^\d{3,4}$/)) {
      setErr(tr("errCvv"));
      return;
    }
    if (!email.trim() || !email.includes("@")) {
      setErr(tr("errEmail"));
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
            `${json.message ?? tr("errProcessPayment")}${json.code ? ` (${json.code})` : ""}`,
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
          body: JSON.stringify({ token, method: "kushki_card" }),
        },
      );
      const cj = await chargeRes.json().catch(() => ({}));
      if (!chargeRes.ok) {
        setErr(cj.message ?? tr("errChargeDeposit"));
        setBusy(false);
        return;
      }
      if (!cj.approved) {
        setErr(cj.message ?? tr("errDeclinedCard"));
        setBusy(false);
        return;
      }
      onApproved();
    } catch (e) {
      console.error("[deposit] error", e);
      setErr(tr("errProcessCard"));
      setBusy(false);
    }
  }

  return (
    <div className="rounded-2xl border border-hairline bg-paper p-5 space-y-3">
      <label className="block">
        <span className="font-mono text-[10px] tracking-[0.14em] uppercase text-muted">
          {tr("cardNumber")}
        </span>
        <input
          inputMode="numeric"
          autoComplete="cc-number"
          value={number}
          onChange={(e) => setNumber(formatCardNumber(e.target.value))}
          placeholder={tr("cardNumberPlaceholder")}
          className="mt-1 w-full h-11 rounded-xl border border-hairline bg-bone px-3 text-sm font-mono tabular focus:outline-none focus:border-ink"
        />
      </label>
      <label className="block">
        <span className="font-mono text-[10px] tracking-[0.14em] uppercase text-muted">
          {tr("cardName")}
        </span>
        <input
          autoComplete="cc-name"
          value={holderName}
          onChange={(e) => setHolderName(e.target.value)}
          placeholder={tr("cardNamePlaceholder")}
          className="mt-1 w-full h-11 rounded-xl border border-hairline bg-bone px-3 text-sm focus:outline-none focus:border-ink"
        />
      </label>
      <div className="grid grid-cols-2 gap-3">
        <label className="block">
          <span className="font-mono text-[10px] tracking-[0.14em] uppercase text-muted">
            {tr("expiry")}
          </span>
          <input
            inputMode="numeric"
            autoComplete="cc-exp"
            value={expiry}
            onChange={(e) => setExpiry(formatExpiry(e.target.value))}
            placeholder={tr("expiryPlaceholder")}
            className="mt-1 w-full h-11 rounded-xl border border-hairline bg-bone px-3 text-sm font-mono tabular focus:outline-none focus:border-ink"
          />
        </label>
        <label className="block">
          <span className="font-mono text-[10px] tracking-[0.14em] uppercase text-muted">
            {tr("cvv")}
          </span>
          <input
            inputMode="numeric"
            autoComplete="cc-csc"
            value={cvv}
            onChange={(e) => setCvv(e.target.value.replace(/\D/g, "").slice(0, 4))}
            placeholder={tr("cvvPlaceholder")}
            className="mt-1 w-full h-11 rounded-xl border border-hairline bg-bone px-3 text-sm font-mono tabular focus:outline-none focus:border-ink"
          />
        </label>
      </div>
      <label className="block">
        <span className="font-mono text-[10px] tracking-[0.14em] uppercase text-muted">
          {tr("email")}
        </span>
        <input
          type="email"
          inputMode="email"
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder={tr("emailPlaceholder")}
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
        {busy
          ? tr("processing")
          : tr("payDeposit", { amount: fmtCOP(depositCents) })}
      </button>
      <p className="text-[10px] text-muted text-center">{tr("cardSecureNote")}</p>
    </div>
  );
}

/** Apple Pay para el depósito — reusa el botón nativo del checkout. */
function DepositApplePay({
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
  const tr = useTranslations("reservar");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function charge(token: string) {
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch(
        `/api/tenant/${tenantSlug}/reservations/${code}/deposit`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ token, method: "kushki_apple_pay" }),
        },
      );
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.approved) {
        setErr(j.message ?? tr("errDepositApple"));
        setBusy(false);
        return;
      }
      onApproved();
    } catch (e) {
      console.error("[deposit-applepay]", e);
      setErr(tr("errProcessApple"));
      setBusy(false);
    }
  }

  return (
    <div className="rounded-2xl border border-hairline bg-paper p-5">
      {kushkiPublicKey ? (
        <ApplePayButton
          publicKey={kushkiPublicKey}
          kushkiMode={kushkiMode}
          amountCents={depositCents}
          displayName={tr("depositDisplayName")}
          busy={busy}
          onTokenized={charge}
        />
      ) : (
        <p className="text-sm text-muted text-center">
          {tr("appleUnavailable")}
        </p>
      )}
      {err && (
        <div className="mt-3 text-sm text-danger bg-danger/5 border border-danger/30 rounded-lg px-3 py-2">
          {err}
        </div>
      )}
      <p className="text-[10px] text-muted text-center mt-3">
        {tr("appleSafariNote")}
      </p>
    </div>
  );
}

/**
 * PSE para el depósito. Elegís banco + datos, tokenizamos con Kushki.js
 * (igual que el checkout de mesa), y el backend hace /transfer/v1/init
 * para llevarte al banco. Al volver, la página de retorno confirma.
 */
function DepositPse({
  tenantSlug,
  code,
  depositCents,
  kushkiPublicKey,
  kushkiMode,
  initialBanks,
}: {
  tenantSlug: string;
  code: string;
  depositCents: number;
  kushkiPublicKey: string | null;
  kushkiMode: "mock" | "sandbox" | "production";
  initialBanks: { code: string; name: string }[];
}) {
  const tr = useTranslations("reservar");
  // Bancos pre-cargados desde el server (SSR) → dropdown instantáneo.
  // Si vinieron vacíos, caemos al fetch del browser (cache 1h).
  const [banks, setBanks] = useState<{ code: string; name: string }[]>(
    initialBanks ?? [],
  );
  const [banksLoading, setBanksLoading] = useState(
    (initialBanks ?? []).length === 0,
  );
  const [bankCode, setBankCode] = useState("");
  const [email, setEmail] = useState("");
  const [docType, setDocType] = useState<"CC" | "CE" | "NIT" | "PA" | "TI">(
    "CC",
  );
  const [docNumber, setDocNumber] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const kushkiRef = useRef<unknown>(null);
  const isMock = kushkiMode === "mock";

  useEffect(() => {
    if (banks.length > 0) return; // ya vinieron del SSR
    let alive = true;
    (async () => {
      setBanksLoading(true);
      try {
        const res = await fetch(`/api/tenant/${tenantSlug}/pay/pse-banks`);
        const j = await res.json();
        if (alive && res.ok && Array.isArray(j.banks)) setBanks(j.banks);
        else if (alive) setErr(j.message ?? tr("errBanks"));
      } catch {
        if (alive) setErr(tr("errBanks"));
      } finally {
        if (alive) setBanksLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantSlug]);

  async function pay() {
    if (!isMock && !bankCode) {
      setErr(tr("errChooseBank"));
      return;
    }
    if (!email.trim() || !email.includes("@")) {
      setErr(tr("errEmail"));
      return;
    }
    if (!docNumber.trim()) {
      setErr(tr("errDocRequired"));
      return;
    }
    setErr(null);
    setBusy(true);
    const buyer = {
      email: email.trim().toLowerCase(),
      docType,
      docNumber: docNumber.trim(),
      personType: "natural" as const,
    };

    try {
      // Mock / sin SDK: el backend confirma directo y devuelve la URL de
      // retorno.
      if (isMock || !kushkiPublicKey) {
        const res = await fetch(
          `/api/tenant/${tenantSlug}/reservations/${code}/deposit/pse`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ buyer, bankCode }),
          },
        );
        const j = await res.json().catch(() => ({}));
        if (!res.ok || !j.redirectUrl) {
          setErr(j.message ?? tr("errPseInit"));
          setBusy(false);
          return;
        }
        window.location.href = j.redirectUrl;
        return;
      }

      // Live: tokenizamos en el browser con Kushki.js.
      if (!kushkiRef.current) {
        const mod = await import("@kushki/js");
        const Ctor = mod.Kushki ?? (mod as { default?: unknown }).default;
        if (typeof Ctor !== "function") {
          throw new Error("@kushki/js no expone Kushki");
        }
        const K = Ctor as new (o: {
          merchantId: string;
          inTestEnvironment: boolean;
        }) => unknown;
        kushkiRef.current = new K({
          merchantId: kushkiPublicKey,
          inTestEnvironment: kushkiMode !== "production",
        });
      }
      const callbackUrl = `${window.location.origin}/r/${tenantSlug}/reserva/${code}/deposit-return`;
      const docTypeForKushki = docType === "PA" ? "PP" : docType;
      const body = {
        amount: { subtotalIva: 0, subtotalIva0: depositCents / 100, iva: 0 },
        callbackUrl,
        userType: "0",
        documentNumber: docNumber.trim(),
        documentType: docTypeForKushki,
        email: buyer.email,
        currency: "COP",
        bankId: bankCode,
      };
      const response = await new Promise<{
        token?: string;
        code?: string;
        message?: string;
        error?: string;
      }>((resolve) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (kushkiRef.current as any).requestTransferToken(
          body,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (resp: any) => resolve(resp),
        );
      });
      if (response.code || !response.token) {
        setErr(
          `${response.message ?? response.error ?? tr("errProcessPayment")}${response.code ? ` (${response.code})` : ""}`,
        );
        setBusy(false);
        return;
      }
      const res = await fetch(
        `/api/tenant/${tenantSlug}/reservations/${code}/deposit/pse`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ token: response.token, buyer, bankCode }),
        },
      );
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.redirectUrl) {
        setErr(j.message ?? tr("errTransferInit"));
        setBusy(false);
        return;
      }
      window.location.href = j.redirectUrl;
    } catch (e) {
      console.error("[deposit-pse]", e);
      setErr(tr("errPseRetry"));
      setBusy(false);
    }
  }

  return (
    <div className="rounded-2xl border border-hairline bg-paper p-5 space-y-3">
      {!isMock && (
        <label className="block">
          <span className="font-mono text-[10px] tracking-[0.14em] uppercase text-muted">
            {tr("bank")}
          </span>
          <select
            value={bankCode}
            onChange={(e) => setBankCode(e.target.value)}
            disabled={banksLoading}
            className="mt-1 w-full h-11 rounded-xl border border-hairline bg-bone px-3 text-sm focus:outline-none focus:border-ink"
          >
            <option value="">
              {banksLoading ? tr("loadingBanks") : tr("chooseBank")}
            </option>
            {banks.map((b) => (
              <option key={b.code} value={b.code}>
                {b.name}
              </option>
            ))}
          </select>
        </label>
      )}
      <div className="grid grid-cols-[90px_1fr] gap-2">
        <label className="block">
          <span className="font-mono text-[10px] tracking-[0.14em] uppercase text-muted">
            {tr("docType")}
          </span>
          <select
            value={docType}
            onChange={(e) =>
              setDocType(e.target.value as "CC" | "CE" | "NIT" | "PA" | "TI")
            }
            className="mt-1 w-full h-11 rounded-xl border border-hairline bg-bone px-2 text-sm focus:outline-none focus:border-ink"
          >
            <option value="CC">CC</option>
            <option value="CE">CE</option>
            <option value="NIT">NIT</option>
            <option value="PA">PA</option>
            <option value="TI">TI</option>
          </select>
        </label>
        <label className="block">
          <span className="font-mono text-[10px] tracking-[0.14em] uppercase text-muted">
            {tr("document")}
          </span>
          <input
            inputMode="numeric"
            value={docNumber}
            onChange={(e) => setDocNumber(e.target.value)}
            placeholder={tr("docNumberPlaceholder")}
            className="mt-1 w-full h-11 rounded-xl border border-hairline bg-bone px-3 text-sm focus:outline-none focus:border-ink"
          />
        </label>
      </div>
      <label className="block">
        <span className="font-mono text-[10px] tracking-[0.14em] uppercase text-muted">
          {tr("email")}
        </span>
        <input
          type="email"
          inputMode="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder={tr("emailPlaceholder")}
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
        disabled={busy || banksLoading}
        onClick={pay}
        className="w-full h-12 rounded-full bg-ink text-bone font-medium text-sm disabled:opacity-60"
      >
        {busy
          ? tr("connectingBank")
          : tr("payPse", { amount: fmtCOP(depositCents) })}
      </button>
      <p className="text-[10px] text-muted text-center">
        {tr("pseSecureNote")}
      </p>
    </div>
  );
}
