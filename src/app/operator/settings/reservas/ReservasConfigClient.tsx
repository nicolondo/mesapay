"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type {
  ReservationConfig,
  Shift,
  Weekday,
} from "@/lib/reservations";
import type { PaymentMethodSlug } from "@/lib/paymentMethods";

const DEPOSIT_METHOD_LABELS: Record<string, string> = {
  kushki_card: "Tarjeta",
  kushki_pse: "PSE",
  kushki_apple_pay: "Apple Pay",
};

const DAY_LABELS: Record<Weekday, string> = {
  0: "Domingo",
  1: "Lunes",
  2: "Martes",
  3: "Miércoles",
  4: "Jueves",
  5: "Viernes",
  6: "Sábado",
};

const WEEKDAYS: Weekday[] = [1, 2, 3, 4, 5, 6, 0]; // lun→dom para mostrar

const SLOT_OPTIONS = [60, 90, 120, 150, 180];

export function ReservasConfigClient({
  tenantSlug,
  initialEnabled,
  initialConfig,
  depositCapable,
  initialDepositMethods,
}: {
  tenantSlug: string;
  initialEnabled: boolean;
  initialConfig: ReservationConfig;
  /** Métodos online del comercio que pueden cobrar un depósito. */
  depositCapable: PaymentMethodSlug[];
  /** Selección actual (subconjunto de depositCapable). */
  initialDepositMethods: PaymentMethodSlug[];
}) {
  const router = useRouter();
  const [enabled, setEnabled] = useState(initialEnabled);
  const [config, setConfig] = useState<ReservationConfig>(initialConfig);
  const [depositMethods, setDepositMethods] = useState<PaymentMethodSlug[]>(
    initialDepositMethods,
  );
  const [busy, setBusy] = useState(false);

  function toggleDepositMethod(slug: PaymentMethodSlug) {
    setDepositMethods((ms) =>
      ms.includes(slug) ? ms.filter((m) => m !== slug) : [...ms, slug],
    );
  }
  const [msg, setMsg] = useState<{ kind: "ok" | "error"; text: string } | null>(
    null,
  );

  const reserveUrl =
    typeof window !== "undefined"
      ? `${window.location.origin}/r/${tenantSlug}`
      : `/r/${tenantSlug}`;

  function updateShift(
    day: Weekday,
    idx: number,
    field: keyof Shift,
    value: string,
  ) {
    setConfig((c) => {
      const next = { ...c, shiftsByDay: { ...c.shiftsByDay } };
      const arr = [...(next.shiftsByDay[day] ?? [])];
      arr[idx] = { ...arr[idx], [field]: value };
      next.shiftsByDay[day] = arr;
      return next;
    });
  }

  function addShift(day: Weekday) {
    setConfig((c) => {
      const next = { ...c, shiftsByDay: { ...c.shiftsByDay } };
      const arr = [...(next.shiftsByDay[day] ?? [])];
      arr.push({ start: "12:00", end: "15:00" });
      next.shiftsByDay[day] = arr;
      return next;
    });
  }

  function removeShift(day: Weekday, idx: number) {
    setConfig((c) => {
      const next = { ...c, shiftsByDay: { ...c.shiftsByDay } };
      next.shiftsByDay[day] = (next.shiftsByDay[day] ?? []).filter(
        (_, i) => i !== idx,
      );
      return next;
    });
  }

  async function save() {
    setBusy(true);
    setMsg(null);
    const res = await fetch("/api/operator/settings/reservations", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled, config, depositMethods }),
    });
    setBusy(false);
    if (!res.ok) {
      setMsg({ kind: "error", text: "No pudimos guardar. Intentá de nuevo." });
      return;
    }
    setMsg({ kind: "ok", text: "Guardado." });
    router.refresh();
  }

  return (
    <div className="space-y-6">
      {/* Toggle maestro */}
      <div className="rounded-2xl border border-op-border bg-op-surface p-5">
        <label className="flex items-center justify-between gap-4 cursor-pointer">
          <div>
            <div className="font-medium">Recibir reservas</div>
            <p className="text-xs text-op-muted mt-0.5">
              Activá para que tus clientes puedan apartar mesa desde un
              link público.
            </p>
          </div>
          <Toggle on={enabled} onChange={setEnabled} />
        </label>

        {enabled && (
          <div className="mt-4 pt-4 border-t border-op-border">
            <div className="font-mono text-[10px] tracking-wider uppercase text-op-muted mb-1">
              Link de reservas
            </div>
            <div className="flex items-center gap-2">
              <code className="flex-1 min-w-0 truncate text-xs bg-op-bg rounded-lg px-3 py-2 border border-op-border">
                {reserveUrl}
              </code>
              <button
                type="button"
                onClick={() => {
                  navigator.clipboard?.writeText(reserveUrl).catch(() => {});
                  setMsg({ kind: "ok", text: "Link copiado." });
                }}
                className="shrink-0 h-9 px-3 rounded-full bg-ink text-bone text-xs font-medium"
              >
                Copiar
              </button>
            </div>
            <p className="text-[11px] text-op-muted mt-1.5">
              Compartilo por WhatsApp, redes o en tu sitio web.
            </p>
          </div>
        )}
      </div>

      {/* Conectar con Google Maps */}
      {enabled && (
        <div className="rounded-2xl border border-op-border bg-op-surface p-5">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-lg" aria-hidden>
              📍
            </span>
            <div className="font-display text-lg">Recibir reservas desde Google Maps</div>
          </div>
          <p className="text-xs text-op-muted mb-4">
            Poné tu link de reservas en tu perfil de Google para que la
            gente que te busca en Maps pueda reservar directo. Usá este
            link especial — las reservas que lleguen por ahí quedan
            marcadas como “Google Maps” para que midas cuántas trae.
          </p>

          <div className="font-mono text-[10px] tracking-wider uppercase text-op-muted mb-1">
            Link para Google
          </div>
          <div className="flex items-center gap-2 mb-4">
            <code className="flex-1 min-w-0 truncate text-xs bg-op-bg rounded-lg px-3 py-2 border border-op-border">
              {reserveUrl}?source=google
            </code>
            <button
              type="button"
              onClick={() => {
                navigator.clipboard
                  ?.writeText(`${reserveUrl}?source=google`)
                  .catch(() => {});
                setMsg({ kind: "ok", text: "Link de Google copiado." });
              }}
              className="shrink-0 h-9 px-3 rounded-full bg-ink text-bone text-xs font-medium"
            >
              Copiar
            </button>
          </div>

          <div className="rounded-xl bg-op-bg border border-op-border p-4">
            <div className="text-xs font-medium mb-2">
              Cómo agregarlo (5 minutos):
            </div>
            <ol className="text-xs text-op-muted space-y-1.5 list-decimal pl-4">
              <li>
                Entrá a tu{" "}
                <a
                  href="https://business.google.com/"
                  target="_blank"
                  rel="noreferrer"
                  className="text-terracotta hover:underline"
                >
                  Perfil de Empresa de Google
                </a>{" "}
                (el que controla tu ficha en Maps).
              </li>
              <li>Abrí tu negocio → <strong>Editar perfil</strong>.</li>
              <li>
                En <strong>Reservas</strong> (o “Enlaces”), pegá el link
                de arriba como tu sistema de reservas.
              </li>
              <li>
                Si no ves la opción de Reservas, pegalo en el campo de{" "}
                <strong>Sitio web</strong> o como un enlace destacado.
              </li>
              <li>Guardá. Listo — el botón “Reservar” en Maps lleva acá.</li>
            </ol>
            <p className="text-[11px] text-op-muted mt-3">
              Nota: la reserva nativa dentro de Google (sin salir de Maps)
              requiere ser partner aprobado de “Reserve with Google” — un
              trámite aparte. Este link cubre el 90% del valor desde ya.
            </p>
          </div>
        </div>
      )}

      {enabled && (
        <>
          {/* Parámetros generales */}
          <div className="rounded-2xl border border-op-border bg-op-surface p-5 space-y-4">
            <div className="font-display text-lg">Cómo funcionan</div>

            <label className="flex items-center justify-between gap-4">
              <div>
                <div className="text-sm font-medium">Confirmar solas</div>
                <p className="text-xs text-op-muted mt-0.5">
                  Si lo apagás, cada reserva te llega como “pendiente” y
                  vos la confirmás a mano.
                </p>
              </div>
              <Toggle
                on={config.autoConfirm}
                onChange={(v) => setConfig((c) => ({ ...c, autoConfirm: v }))}
              />
            </label>

            <label className="block">
              <span className="text-sm font-medium">Duración de cada reserva</span>
              <select
                value={config.slotMinutes}
                onChange={(e) =>
                  setConfig((c) => ({
                    ...c,
                    slotMinutes: Number(e.target.value),
                  }))
                }
                className="mt-1 w-full h-11 px-3 rounded-lg border border-op-border bg-op-bg text-sm"
              >
                {SLOT_OPTIONS.map((m) => (
                  <option key={m} value={m}>
                    {m >= 60
                      ? `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}min` : ""}`
                      : `${m} min`}
                  </option>
                ))}
              </select>
            </label>

            <div className="grid grid-cols-2 gap-3">
              <label className="block">
                <span className="text-sm font-medium">Anticipación mínima</span>
                <div className="mt-1 flex items-center gap-2">
                  <input
                    type="number"
                    min={0}
                    max={168}
                    value={config.minNoticeHours}
                    onChange={(e) =>
                      setConfig((c) => ({
                        ...c,
                        minNoticeHours: Math.max(0, Number(e.target.value)),
                      }))
                    }
                    className="w-20 h-11 px-3 rounded-lg border border-op-border bg-op-bg text-sm"
                  />
                  <span className="text-sm text-op-muted">horas</span>
                </div>
              </label>
              <label className="block">
                <span className="text-sm font-medium">Hasta cuántos días</span>
                <div className="mt-1 flex items-center gap-2">
                  <input
                    type="number"
                    min={1}
                    max={365}
                    value={config.maxAdvanceDays}
                    onChange={(e) =>
                      setConfig((c) => ({
                        ...c,
                        maxAdvanceDays: Math.max(1, Number(e.target.value)),
                      }))
                    }
                    className="w-20 h-11 px-3 rounded-lg border border-op-border bg-op-bg text-sm"
                  />
                  <span className="text-sm text-op-muted">días</span>
                </div>
              </label>
            </div>

            <label className="block">
              <span className="text-sm font-medium">
                Nota / política (opcional)
              </span>
              <textarea
                value={config.policyNote ?? ""}
                onChange={(e) =>
                  setConfig((c) => ({
                    ...c,
                    policyNote: e.target.value,
                  }))
                }
                rows={2}
                maxLength={500}
                placeholder="Ej: Tolerancia de 15 minutos. Reservas para grupos de +8 por teléfono."
                className="mt-1 w-full px-3 py-2 rounded-lg border border-op-border bg-op-bg text-sm"
              />
            </label>
          </div>

          {/* Depósito para reservar */}
          <div className="rounded-2xl border border-op-border bg-op-surface p-5">
            <div className="font-display text-lg mb-1">Depósito para reservar</div>
            <p className="text-xs text-op-muted mb-4">
              El monto del depósito se define <strong>por mesa</strong> en{" "}
              <Link
                href="/operator/settings/mesas"
                className="text-terracotta hover:underline"
              >
                Mesas
              </Link>
              . Acá elegís con qué medios online se cobra al reservar. Se
              abona a la cuenta cuando llegan; si no se presentan, no se
              devuelve. Efectivo y datáfono no aplican (el cliente no está
              en el local al reservar).
            </p>

            {depositCapable.length === 0 ? (
              <div className="rounded-xl border border-op-border bg-op-bg p-4 text-xs text-op-muted">
                Para cobrar depósitos necesitás un medio de pago online
                activo (Tarjeta, PSE o Apple Pay). Activalos en{" "}
                <Link
                  href="/operator/settings/pagos"
                  className="text-terracotta hover:underline"
                >
                  Pagos
                </Link>
                .
              </div>
            ) : (
              <div className="space-y-2">
                {depositCapable.map((slug) => {
                  // Hoy sólo el cobro con Tarjeta está implementado para
                  // depósitos; PSE/Apple Pay quedan "próximamente".
                  const ready = slug === "kushki_card";
                  return (
                    <label
                      key={slug}
                      className="flex items-center justify-between gap-4 rounded-xl border border-op-border bg-op-bg px-4 py-3 cursor-pointer"
                    >
                      <span className="text-sm font-medium flex items-center gap-2">
                        {DEPOSIT_METHOD_LABELS[slug] ?? slug}
                        {!ready && (
                          <span className="text-[10px] font-normal px-2 h-5 inline-flex items-center rounded-full bg-[#C98A2E]/15 text-[#8F6828]">
                            Próximamente
                          </span>
                        )}
                      </span>
                      <Toggle
                        on={depositMethods.includes(slug)}
                        onChange={() => toggleDepositMethod(slug)}
                      />
                    </label>
                  );
                })}
                {depositMethods.length === 0 && (
                  <p className="text-[11px] text-[#8F6828]">
                    Sin ningún método marcado no se podrán cobrar depósitos:
                    las mesas con depósito se reservarán sin cobrarlo.
                  </p>
                )}
              </div>
            )}
          </div>

          {/* Turnos por día */}
          <div className="rounded-2xl border border-op-border bg-op-surface p-5">
            <div className="font-display text-lg mb-1">Turnos por día</div>
            <p className="text-xs text-op-muted mb-4">
              Definí en qué franjas recibís reservas. Cada turno se divide
              automáticamente en reservas de{" "}
              {config.slotMinutes >= 60
                ? `${Math.floor(config.slotMinutes / 60)}h${config.slotMinutes % 60 ? ` ${config.slotMinutes % 60}min` : ""}`
                : `${config.slotMinutes}min`}
              . Días sin turnos = cerrado.
            </p>
            <div className="space-y-3">
              {WEEKDAYS.map((day) => {
                const shifts = config.shiftsByDay[day] ?? [];
                return (
                  <div
                    key={day}
                    className="flex items-start gap-3 py-2 border-b border-op-border last:border-0"
                  >
                    <div className="w-24 shrink-0 text-sm font-medium pt-2">
                      {DAY_LABELS[day]}
                    </div>
                    <div className="flex-1 space-y-2">
                      {shifts.length === 0 && (
                        <div className="text-xs text-op-muted pt-2">
                          Cerrado
                        </div>
                      )}
                      {shifts.map((s, idx) => (
                        <div key={idx} className="flex items-center gap-2">
                          <input
                            type="time"
                            value={s.start}
                            onChange={(e) =>
                              updateShift(day, idx, "start", e.target.value)
                            }
                            className="h-9 px-2 rounded-lg border border-op-border bg-op-bg text-sm"
                          />
                          <span className="text-op-muted text-sm">a</span>
                          <input
                            type="time"
                            value={s.end}
                            onChange={(e) =>
                              updateShift(day, idx, "end", e.target.value)
                            }
                            className="h-9 px-2 rounded-lg border border-op-border bg-op-bg text-sm"
                          />
                          <button
                            type="button"
                            onClick={() => removeShift(day, idx)}
                            className="text-danger text-xs hover:underline ml-1"
                          >
                            Quitar
                          </button>
                        </div>
                      ))}
                      <button
                        type="button"
                        onClick={() => addShift(day)}
                        className="text-xs text-terracotta hover:underline"
                      >
                        + Agregar turno
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </>
      )}

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={save}
          disabled={busy}
          className="h-11 px-6 rounded-full bg-ink text-bone text-sm font-medium disabled:opacity-50"
        >
          {busy ? "Guardando…" : "Guardar cambios"}
        </button>
        {msg && (
          <span
            className={
              "text-sm " + (msg.kind === "ok" ? "text-ok" : "text-danger")
            }
          >
            {msg.text}
          </span>
        )}
      </div>
    </div>
  );
}

function Toggle({
  on,
  onChange,
}: {
  on: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      onClick={() => onChange(!on)}
      className={
        "shrink-0 w-12 h-7 rounded-full transition-colors relative " +
        (on ? "bg-ok" : "bg-op-border")
      }
    >
      <span
        className={
          "absolute top-0.5 w-6 h-6 rounded-full bg-white shadow transition-all " +
          (on ? "left-[1.375rem]" : "left-0.5")
        }
      />
    </button>
  );
}
