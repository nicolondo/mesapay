"use client";

import { useState } from "react";
import type { TipPolicy, ShiftPolicy } from "@/lib/staffPolicies";

export function StaffPoliciesClient({
  initialTipPolicy,
  initialShiftPolicy,
}: {
  initialTipPolicy: TipPolicy;
  initialShiftPolicy: ShiftPolicy;
}) {
  const [tipPolicy, setTipPolicy] = useState<TipPolicy>(initialTipPolicy);
  const [shiftPolicy, setShiftPolicy] = useState<ShiftPolicy>(initialShiftPolicy);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "error"; text: string } | null>(
    null,
  );

  const dirty =
    tipPolicy !== initialTipPolicy || shiftPolicy !== initialShiftPolicy;

  async function save() {
    setBusy(true);
    setMsg(null);
    const r = await fetch("/api/operator/settings/staff-policies", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tipPolicy, shiftPolicy }),
    });
    setBusy(false);
    if (!r.ok) {
      setMsg({ kind: "error", text: "No se pudo guardar." });
      return;
    }
    setMsg({ kind: "ok", text: "Guardado." });
  }

  return (
    <div className="space-y-5">
      {/* Propinas */}
      <section className="rounded-2xl border border-op-border bg-op-surface p-5">
        <div className="font-mono text-[10px] tracking-[0.15em] uppercase text-op-muted mb-1">
          Propinas
        </div>
        <h2 className="font-display text-lg mb-3">
          ¿Cómo se reparten las propinas?
        </h2>
        <RadioCard
          name="tipPolicy"
          value="shared"
          active={tipPolicy === "shared"}
          onChange={() => setTipPolicy("shared")}
          title="Compartidas"
          subtitle="Las propinas son del restaurante. El operador decide cómo distribuir al cierre. El mesero no ve propinas personales en su vista 'Yo'."
        />
        <RadioCard
          name="tipPolicy"
          value="by_waiter"
          active={tipPolicy === "by_waiter"}
          onChange={() => setTipPolicy("by_waiter")}
          title="Por mesero"
          subtitle="Cada propina queda atada al mesero que cobró la cuenta. Cada uno ve su acumulado del día en 'Yo'."
        />
      </section>

      {/* Turnos */}
      <section className="rounded-2xl border border-op-border bg-op-surface p-5">
        <div className="font-mono text-[10px] tracking-[0.15em] uppercase text-op-muted mb-1">
          Turnos
        </div>
        <h2 className="font-display text-lg mb-3">
          ¿Quién abre y cierra el turno?
        </h2>
        <RadioCard
          name="shiftPolicy"
          value="global"
          active={shiftPolicy === "global"}
          onChange={() => setShiftPolicy("global")}
          title="Turno único del local"
          subtitle="Un solo turno por restaurante, abierto y cerrado por el operador. Arqueo de caja al final del día."
        />
        <RadioCard
          name="shiftPolicy"
          value="by_waiter"
          active={shiftPolicy === "by_waiter"}
          onChange={() => setShiftPolicy("by_waiter")}
          title="Turno por mesero"
          subtitle="Cada mesero abre y cierra su propio turno desde la app. Útil cuando rotan turnos largos / cortos. Coexiste con el turno del local."
        />
      </section>

      <div className="flex items-center justify-end gap-3 pt-1">
        {msg && (
          <span
            className={
              "text-xs " + (msg.kind === "ok" ? "text-ok" : "text-danger")
            }
          >
            {msg.text}
          </span>
        )}
        <button
          type="button"
          onClick={save}
          disabled={busy || !dirty}
          className="h-10 px-5 rounded-full bg-ink text-bone text-sm font-medium disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {busy ? "Guardando…" : "Guardar"}
        </button>
      </div>
    </div>
  );
}

function RadioCard({
  name,
  value,
  active,
  onChange,
  title,
  subtitle,
}: {
  name: string;
  value: string;
  active: boolean;
  onChange: () => void;
  title: string;
  subtitle: string;
}) {
  return (
    <label
      className={
        "flex gap-3 items-start cursor-pointer rounded-xl border p-4 mt-2 transition-colors " +
        (active
          ? "border-ink bg-ink/5"
          : "border-op-border hover:border-op-text/30")
      }
    >
      <input
        type="radio"
        name={name}
        value={value}
        checked={active}
        onChange={onChange}
        className="mt-1 accent-ink shrink-0"
      />
      <div className="min-w-0">
        <div className="font-medium text-sm">{title}</div>
        <div className="text-xs text-op-muted mt-0.5">{subtitle}</div>
      </div>
    </label>
  );
}
