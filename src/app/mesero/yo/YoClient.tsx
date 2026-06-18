"use client";

import { useEffect, useState, type ReactNode } from "react";
import { fmtCOP } from "@/lib/format";
import { fmtBogotaDateTime } from "@/lib/bogota";
import type { TipPolicy, ShiftPolicy } from "@/lib/staffPolicies";

type Stats = {
  sinceIso: string;
  tipsCents: number | null;
  tipsRawCents: number;
  salesCents: number;
  paymentCount: number;
  tableCount: number;
  shift: {
    id: string;
    openedAtIso: string;
    openingCashCents: number;
    cashCollectedCents: number;
  } | null;
};

type CloseSummary = {
  shiftId: string;
  openedAtIso: string;
  closedAtIso: string;
  durationMs: number;
  tipsCents: number;
  salesCents: number;
  paymentCount: number;
  tableCount: number;
  openingCashCents: number;
  cashCollectedCents: number;
  expectedCashCents: number;
  declaredCashCents: number;
  cashDiffCents: number;
};

/**
 * Sección reactiva de /mesero/yo. Muestra stats (ventas / propinas /
 * mesas / pagos) en una card grande, y arriba el control de turno
 * cuando el restaurante usa shiftPolicy="by_waiter". Cuando es
 * "global" solo muestra las stats ("Resumen del día") desde el inicio
 * de la jornada contable y sin botones — el turno lo abre/cierra el
 * operador.
 */
export function YoClient({
  tipPolicy,
  shiftPolicy,
  initial,
}: {
  tipPolicy: TipPolicy;
  shiftPolicy: ShiftPolicy;
  initial: Stats;
}) {
  const [stats, setStats] = useState<Stats>(initial);
  const [summary, setSummary] = useState<CloseSummary | null>(null);
  // Sheet de arqueo: "open" pide la base inicial, "close" pide el
  // efectivo contado. Cada sheet maneja su propio fetch + busy + error.
  const [sheet, setSheet] = useState<"open" | "close" | null>(null);

  // Refresh moderado: cada 30s. Si está caro lo subimos a 60s.
  useEffect(() => {
    const tick = async () => {
      try {
        const r = await fetch("/api/mesero/me/today");
        if (!r.ok) return;
        const j = (await r.json()) as Stats;
        setStats(j);
      } catch {}
    };
    const h = setInterval(tick, 30_000);
    return () => clearInterval(h);
  }, []);

  async function refreshStats() {
    try {
      const r = await fetch("/api/mesero/me/today");
      if (r.ok) {
        const j = (await r.json()) as Stats;
        setStats(j);
      }
    } catch {}
  }

  const hasOpenShift = !!stats.shift;
  const sinceLabel = (() => {
    // Hora real de inicio del rango en zona Bogotá (determinística, sin
    // depender del tz del navegador). En global arranca al inicio de la
    // jornada contable (hora de corte configurable, ej. 05:00), no a las 00:00.
    const { time } = fmtBogotaDateTime(new Date(stats.sinceIso));
    return hasOpenShift ? `Desde las ${time}` : `Hoy desde ${time}`;
  })();

  return (
    <>
      {/* Card "Tu turno" / "Hoy" */}
      <section className="rounded-2xl border border-hairline bg-paper p-5 space-y-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="font-mono text-[10px] tracking-[0.15em] uppercase text-muted">
              {hasOpenShift ? "Tu turno" : "Hoy"}
            </div>
            <div className="font-display text-2xl mt-0.5">
              {shiftPolicy === "global"
                ? "Resumen del día"
                : hasOpenShift
                  ? "Abierto"
                  : "Sin turno abierto"}
            </div>
            <div className="text-xs text-muted mt-1">{sinceLabel}</div>
          </div>

          {shiftPolicy === "by_waiter" && !hasOpenShift && (
            <button
              type="button"
              onClick={() => setSheet("open")}
              className="h-10 px-4 rounded-full bg-ink text-bone text-sm font-medium shrink-0"
            >
              Abrir turno
            </button>
          )}
          {shiftPolicy === "by_waiter" && hasOpenShift && (
            <button
              type="button"
              onClick={() => setSheet("close")}
              className="h-10 px-4 rounded-full border border-hairline text-ink text-sm font-medium shrink-0"
            >
              Cerrar turno
            </button>
          )}
        </div>

        {shiftPolicy === "global" && (
          <p className="text-[11px] text-op-muted -mt-2">
            El restaurante maneja un turno único. Las cifras de abajo
            cuentan desde el inicio de la jornada del día.
          </p>
        )}

        {/* Grid de stats — 2x2 en mobile */}
        <div className="grid grid-cols-2 gap-3">
          <Stat label="Ventas" value={fmtCOP(stats.salesCents)} />
          <Stat
            label="Propinas"
            value={
              stats.tipsCents != null
                ? fmtCOP(stats.tipsCents)
                : "Compartidas"
            }
            hint={
              stats.tipsCents == null
                ? "El local reparte propinas al cierre"
                : undefined
            }
          />
          <Stat label="Mesas" value={String(stats.tableCount)} />
          <Stat label="Pagos" value={String(stats.paymentCount)} />
        </div>
      </section>

      {/* Sheet: abrir turno → pedir base inicial */}
      {sheet === "open" && (
        <OpenShiftSheet
          onClose={() => setSheet(null)}
          onDone={() => {
            setSheet(null);
            void refreshStats();
          }}
        />
      )}

      {/* Sheet: cerrar turno → arqueo (contar efectivo) */}
      {sheet === "close" && stats.shift && (
        <CloseShiftSheet
          openingCashCents={stats.shift.openingCashCents}
          cashCollectedCents={stats.shift.cashCollectedCents}
          onClose={() => setSheet(null)}
          onDone={(s) => {
            setSheet(null);
            setSummary(s);
            void refreshStats();
          }}
        />
      )}

      {/* Resumen al cerrar turno */}
      {summary && (
        <CloseSummarySheet
          summary={summary}
          tipPolicy={tipPolicy}
          onClose={() => setSummary(null)}
        />
      )}
    </>
  );
}

function Stat({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <div className="rounded-xl border border-hairline bg-ivory px-3 py-3">
      <div className="font-mono text-[10px] tracking-[0.15em] uppercase text-muted">
        {label}
      </div>
      <div className="font-display text-lg tabular mt-0.5 break-words">
        {value}
      </div>
      {hint && (
        <div className="text-[10px] text-op-muted mt-1 leading-tight">
          {hint}
        </div>
      )}
    </div>
  );
}

function CloseSummarySheet({
  summary,
  tipPolicy,
  onClose,
}: {
  summary: CloseSummary;
  tipPolicy: TipPolicy;
  onClose: () => void;
}) {
  const durationMinutes = Math.floor(summary.durationMs / 60_000);
  const hours = Math.floor(durationMinutes / 60);
  const mins = durationMinutes % 60;
  const durStr =
    hours > 0 ? `${hours}h ${mins}min` : `${mins} min`;

  return (
    <div
      className="fixed inset-0 z-50 bg-ink/40 flex items-end md:items-center justify-center p-0 md:p-6"
      onClick={onClose}
    >
      <div
        className="w-full md:max-w-md bg-paper rounded-t-3xl md:rounded-3xl border border-hairline p-5 space-y-4 max-h-[90dvh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="font-mono text-[10px] tracking-[0.15em] uppercase text-muted">
              Turno cerrado
            </div>
            <h2 className="font-display text-2xl mt-1">Resumen del turno</h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-muted text-sm shrink-0"
            aria-label="Cerrar"
          >
            ✕
          </button>
        </div>

        <div className="space-y-1.5">
          <Row label="Duración" value={durStr} />
          <Row label="Mesas atendidas" value={String(summary.tableCount)} />
          <Row label="Pagos cobrados" value={String(summary.paymentCount)} />
          <Row label="Ventas" value={fmtCOP(summary.salesCents)} />
          <Row
            label="Propinas"
            value={
              tipPolicy === "by_waiter"
                ? fmtCOP(summary.tipsCents)
                : "Compartidas con el local"
            }
            accent={tipPolicy === "by_waiter"}
          />
        </div>

        {/* Arqueo de la caja del mesero */}
        <div className="space-y-1.5 border-t border-hairline pt-3">
          <div className="font-mono text-[10px] tracking-[0.14em] uppercase text-muted">
            Arqueo de tu caja
          </div>
          <Row label="Base inicial" value={fmtCOP(summary.openingCashCents)} />
          <Row
            label="Efectivo cobrado"
            value={fmtCOP(summary.cashCollectedCents)}
          />
          <Row
            label="Esperado en caja"
            value={fmtCOP(summary.expectedCashCents)}
          />
          <Row label="Contaste" value={fmtCOP(summary.declaredCashCents)} />
          <Row
            label="Diferencia"
            value={diffLabel(summary.cashDiffCents)}
            accent
            tone={diffTone(summary.cashDiffCents)}
          />
        </div>

        <button
          type="button"
          onClick={onClose}
          className="w-full h-12 rounded-2xl bg-ink text-bone text-base font-medium"
        >
          Listo
        </button>
      </div>
    </div>
  );
}

function Row({
  label,
  value,
  accent,
  tone,
}: {
  label: string;
  value: string;
  accent?: boolean;
  // Color semántico del valor (para la diferencia del arqueo).
  tone?: "ok" | "bad" | "muted";
}) {
  const toneClass =
    tone === "bad"
      ? "text-red-700"
      : tone === "ok"
        ? "text-emerald-700"
        : tone === "muted"
          ? "text-op-muted"
          : "";
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-sm text-op-muted">{label}</span>
      <span
        className={
          "font-mono tabular " +
          (accent ? "font-display text-lg " : "text-sm ") +
          toneClass
        }
      >
        {value}
      </span>
    </div>
  );
}

// Diferencia de arqueo: 0 = "Sin descuadre", + sobra, − falta.
function diffLabel(cents: number): string {
  if (cents === 0) return "Sin descuadre";
  return (cents > 0 ? "+" : "−") + fmtCOP(Math.abs(cents));
}
function diffTone(cents: number): "ok" | "bad" | "muted" {
  if (cents === 0) return "muted";
  return cents > 0 ? "ok" : "bad";
}

/**
 * Campo de monto en pesos enteros (COP no usa decimales). Maneja
 * `valueCents` por fuera; el input muestra/parsea pesos.
 */
function CashInput({
  valueCents,
  onChange,
  autoFocus,
}: {
  valueCents: number;
  onChange: (cents: number) => void;
  autoFocus?: boolean;
}) {
  const pesos = Math.round(valueCents / 100);
  return (
    <div className="flex items-center gap-2 rounded-xl border border-hairline bg-ivory px-3 h-12">
      <span className="text-muted font-display text-lg">$</span>
      <input
        type="text"
        inputMode="numeric"
        autoFocus={autoFocus}
        value={pesos ? pesos.toLocaleString("es-CO") : ""}
        onChange={(e) => {
          const digits = e.target.value.replace(/\D/g, "");
          const n = digits ? parseInt(digits, 10) : 0;
          onChange(n * 100);
        }}
        placeholder="0"
        className="flex-1 bg-transparent outline-none font-display text-xl tabular min-w-0"
      />
    </div>
  );
}

/** Cáscara común de los sheets de arqueo (mismo estilo que el resumen). */
function SheetShell({
  eyebrow,
  title,
  onClose,
  children,
}: {
  eyebrow: string;
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <div
      className="fixed inset-0 z-50 bg-ink/40 flex items-end md:items-center justify-center p-0 md:p-6"
      onClick={onClose}
    >
      <div
        className="w-full md:max-w-md bg-paper rounded-t-3xl md:rounded-3xl border border-hairline p-5 space-y-4 max-h-[90dvh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="font-mono text-[10px] tracking-[0.15em] uppercase text-muted">
              {eyebrow}
            </div>
            <h2 className="font-display text-2xl mt-1">{title}</h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-muted text-sm shrink-0"
            aria-label="Cerrar"
          >
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

function OpenShiftSheet({
  onClose,
  onDone,
}: {
  onClose: () => void;
  onDone: () => void;
}) {
  const [cents, setCents] = useState(0);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // El local no abrió su turno → no podemos abrir el del mesero.
  const [localClosed, setLocalClosed] = useState(false);

  async function submit() {
    setBusy(true);
    setErr(null);
    const r = await fetch("/api/mesero/shift/open", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ openingCashCents: cents }),
    });
    setBusy(false);
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      if (j.error === "local_shift_closed") {
        setLocalClosed(true);
        setErr(null);
        return;
      }
      setErr(j.message ?? j.error ?? "No pudimos abrir el turno");
      return;
    }
    onDone();
  }

  return (
    <SheetShell
      eyebrow="Abrir turno"
      title="¿Con cuánta base inicias?"
      onClose={onClose}
    >
      <p className="text-xs text-muted">
        Cuenta el efectivo con el que arrancas tu caja para dar vueltos. Si no
        manejas base, déjalo en $0.
      </p>
      <CashInput valueCents={cents} onChange={setCents} autoFocus />
      {localClosed && (
        <div className="rounded-xl border border-[#C98A2E]/40 bg-[#C98A2E]/10 p-3 text-[13px] text-[#7F5A1F] leading-snug">
          El local todavía no abrió su turno, así que no podés abrir el tuyo.
          Pedile al encargado que abra el turno general del local; en cuanto lo
          haga, tocá “Reintentar”.
        </div>
      )}
      {err && <div className="text-xs text-danger">{err}</div>}
      <button
        type="button"
        onClick={submit}
        disabled={busy}
        className="w-full h-12 rounded-2xl bg-ink text-bone text-base font-medium disabled:opacity-50"
      >
        {busy ? "Abriendo…" : localClosed ? "Reintentar" : "Abrir turno"}
      </button>
    </SheetShell>
  );
}

function CloseShiftSheet({
  openingCashCents,
  cashCollectedCents,
  onClose,
  onDone,
}: {
  openingCashCents: number;
  cashCollectedCents: number;
  onClose: () => void;
  onDone: (summary: CloseSummary) => void;
}) {
  const expected = openingCashCents + cashCollectedCents;
  const [declared, setDeclared] = useState(expected);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const diff = declared - expected;

  async function submit() {
    setBusy(true);
    setErr(null);
    const r = await fetch("/api/mesero/shift/close", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ declaredCashCents: declared }),
    });
    setBusy(false);
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      setErr(j.message ?? j.error ?? "No pudimos cerrar el turno");
      return;
    }
    const j = (await r.json()) as { summary: CloseSummary };
    onDone(j.summary);
  }

  return (
    <SheetShell eyebrow="Cerrar turno" title="Arqueo de tu caja" onClose={onClose}>
      <div className="space-y-1.5">
        <Row label="Base inicial" value={fmtCOP(openingCashCents)} />
        <Row label="Efectivo cobrado" value={fmtCOP(cashCollectedCents)} />
        <Row label="Esperado en caja" value={fmtCOP(expected)} accent />
      </div>
      <div>
        <div className="font-mono text-[10px] tracking-[0.14em] uppercase text-muted mb-2">
          ¿Cuánto contaste?
        </div>
        <CashInput valueCents={declared} onChange={setDeclared} autoFocus />
      </div>
      <Row label="Diferencia" value={diffLabel(diff)} accent tone={diffTone(diff)} />
      {err && <div className="text-xs text-danger">{err}</div>}
      <button
        type="button"
        onClick={submit}
        disabled={busy}
        className="w-full h-12 rounded-2xl bg-ink text-bone text-base font-medium disabled:opacity-50"
      >
        {busy ? "Cerrando…" : "Cerrar turno"}
      </button>
    </SheetShell>
  );
}
