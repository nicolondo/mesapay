"use client";

import { useState } from "react";
import type { TipPolicy, ShiftPolicy } from "@/lib/staffPolicies";

export function StaffPoliciesClient({
  initialTipPolicy,
  initialShiftPolicy,
  initialWalkoutDangerMinutes,
}: {
  initialTipPolicy: TipPolicy;
  initialShiftPolicy: ShiftPolicy;
  initialWalkoutDangerMinutes: number;
}) {
  const [tipPolicy, setTipPolicy] = useState<TipPolicy>(initialTipPolicy);
  const [shiftPolicy, setShiftPolicy] = useState<ShiftPolicy>(initialShiftPolicy);
  const [walkoutDanger, setWalkoutDanger] = useState<number>(
    initialWalkoutDangerMinutes,
  );
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "error"; text: string } | null>(
    null,
  );

  const dirty =
    tipPolicy !== initialTipPolicy ||
    shiftPolicy !== initialShiftPolicy ||
    walkoutDanger !== initialWalkoutDangerMinutes;

  async function save() {
    if (
      !Number.isFinite(walkoutDanger) ||
      walkoutDanger < 1 ||
      walkoutDanger > 180
    ) {
      setMsg({
        kind: "error",
        text: "Umbral de walkout debe estar entre 1 y 180 minutos.",
      });
      return;
    }
    setBusy(true);
    setMsg(null);
    const r = await fetch("/api/operator/settings/staff-policies", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        tipPolicy,
        shiftPolicy,
        walkoutDangerMinutes: walkoutDanger,
      }),
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

      {/* Walkout-risk */}
      <section className="rounded-2xl border border-op-border bg-op-surface p-5">
        <div className="font-mono text-[10px] tracking-[0.15em] uppercase text-op-muted mb-1">
          Walkout-risk
        </div>
        <h2 className="font-display text-lg mb-1">
          ¿Cuándo una mesa está en riesgo de irse sin pagar?
        </h2>
        <p className="text-xs text-op-muted mb-3">
          La vista Mesas colorea cada mesa según el tiempo sin pagar
          desde que entregaste todos los platos (o desde que
          pidieron cobro y nadie atendió). Subí el número en
          restaurantes de sobremesa larga; bajalo en rotación rápida.
        </p>
        <div className="flex items-center gap-3 flex-wrap">
          <label className="flex items-center gap-2">
            <span className="font-mono text-[10px] tracking-wider uppercase text-op-muted">
              Riesgo alto (rojo) después de
            </span>
            <input
              type="number"
              min={1}
              max={180}
              step={1}
              value={walkoutDanger}
              onChange={(e) => {
                const v = Number(e.target.value);
                setWalkoutDanger(Number.isFinite(v) ? v : 20);
              }}
              className="h-9 w-20 px-2 rounded-lg border border-op-border bg-op-bg font-mono text-sm tabular text-center focus:outline-none focus:border-terracotta"
            />
            <span className="text-sm text-op-muted">min</span>
          </label>
        </div>
        <div className="mt-4 grid grid-cols-3 gap-2 text-[11px]">
          <RiskPreview
            label="Atento"
            mins={Math.round(walkoutDanger * 0.25)}
            dotClass="bg-[#C98A2E]/70"
            text="text-op-text"
          />
          <RiskPreview
            label="Atención"
            mins={Math.round(walkoutDanger * 0.5)}
            dotClass="bg-[#C98A2E]"
            text="text-[#7F5A1F]"
          />
          <RiskPreview
            label="Riesgo alto"
            mins={walkoutDanger}
            dotClass="bg-[#C9302C] animate-pulse"
            text="text-[#C9302C]"
            extraBold
          />
        </div>
        <p className="text-[10px] text-op-muted mt-3">
          Para pedidos de cobro o llamadas a mesero sin atender, los
          umbrales son la mitad (más urgente). Una mesa cocinando
          todavía nunca está en riesgo.
        </p>
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

function RiskPreview({
  label,
  mins,
  dotClass,
  text,
  extraBold,
}: {
  label: string;
  mins: number;
  dotClass: string;
  text: string;
  extraBold?: boolean;
}) {
  return (
    <div className="rounded-xl border border-op-border bg-op-bg px-2 py-2 text-center">
      <div className="flex items-center justify-center gap-1.5 mb-0.5">
        <span className={"inline-block w-2 h-2 rounded-full " + dotClass} />
        <span className="font-mono text-[9px] tracking-wider uppercase text-op-muted">
          {label}
        </span>
      </div>
      <div
        className={
          "font-mono tabular " + text + " " + (extraBold ? "font-bold" : "")
        }
      >
        {mins}m
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
