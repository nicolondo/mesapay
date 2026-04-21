"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { fmtCOP } from "@/lib/format";

type Plan = "trial" | "basic" | "pro";

const PLAN_OPTIONS: { value: Plan; label: string; suggestedPriceCents: number }[] = [
  { value: "trial", label: "Prueba", suggestedPriceCents: 0 },
  { value: "basic", label: "Básico", suggestedPriceCents: 20_000_000 },
  { value: "pro", label: "Pro", suggestedPriceCents: 40_000_000 },
];

export function PlanEditor({
  restaurantId,
  plan,
  monthlyPriceCents,
}: {
  restaurantId: string;
  plan: Plan;
  monthlyPriceCents: number;
}) {
  const router = useRouter();
  const [selected, setSelected] = useState<Plan>(plan);
  const [priceCop, setPriceCop] = useState(String(Math.round(monthlyPriceCents / 100)));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [, startTx] = useTransition();

  const dirty =
    selected !== plan ||
    Math.round(Number(priceCop) * 100) !== monthlyPriceCents;

  async function save() {
    const cents = Math.round(Number(priceCop) * 100);
    if (!Number.isFinite(cents) || cents < 0) {
      setErr("Precio inválido.");
      return;
    }
    setBusy(true);
    setErr(null);
    const res = await fetch(`/api/admin/membership/${restaurantId}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "set_plan",
        plan: selected,
        monthlyPriceCents: cents,
      }),
    });
    setBusy(false);
    if (!res.ok) {
      setErr("No se pudo guardar.");
      return;
    }
    startTx(() => router.refresh());
  }

  return (
    <div className="space-y-3">
      <div className="flex gap-2 flex-wrap">
        {PLAN_OPTIONS.map((p) => (
          <button
            key={p.value}
            onClick={() => {
              setSelected(p.value);
              if (p.value !== plan) {
                setPriceCop(String(Math.round(p.suggestedPriceCents / 100)));
              } else {
                setPriceCop(String(Math.round(monthlyPriceCents / 100)));
              }
            }}
            className={
              "h-8 px-3 rounded-full text-xs border " +
              (selected === p.value
                ? "bg-ink text-bone border-ink"
                : "bg-op-bg border-op-border")
            }
          >
            {p.label}
          </button>
        ))}
      </div>
      <label className="flex items-center gap-2 text-sm">
        <span className="font-mono text-[10px] tracking-wider uppercase text-op-muted">
          Mensualidad
        </span>
        <input
          type="number"
          value={priceCop}
          onChange={(e) => setPriceCop(e.target.value)}
          min={0}
          step={1000}
          className="h-9 w-36 px-2 rounded-lg border border-op-border bg-op-bg font-mono text-sm tabular"
        />
        <span className="text-op-muted text-xs">COP / mes</span>
      </label>
      {err && <div className="text-danger text-xs">{err}</div>}
      <button
        onClick={save}
        disabled={busy || !dirty}
        className="h-9 px-4 rounded-full bg-ink text-bone text-sm font-medium disabled:opacity-60"
      >
        {busy ? "Guardando…" : "Guardar plan"}
      </button>
    </div>
  );
}

export function RecordPaymentForm({
  restaurantId,
  suggestedAmountCents,
}: {
  restaurantId: string;
  suggestedAmountCents: number;
}) {
  const router = useRouter();
  const [amountCop, setAmountCop] = useState(
    String(Math.round(suggestedAmountCents / 100)),
  );
  const [method, setMethod] = useState<"manual_cash" | "manual_transfer" | "wompi">(
    "manual_transfer",
  );
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [, startTx] = useTransition();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const cents = Math.round(Number(amountCop) * 100);
    if (!Number.isFinite(cents) || cents < 0) {
      setErr("Monto inválido.");
      return;
    }
    setBusy(true);
    setErr(null);
    const res = await fetch(`/api/admin/membership/${restaurantId}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "record_payment",
        amountCents: cents,
        method,
        note: note.trim() || undefined,
      }),
    });
    setBusy(false);
    if (!res.ok) {
      setErr("No se pudo registrar.");
      return;
    }
    setNote("");
    startTx(() => router.refresh());
  }

  return (
    <form onSubmit={submit} className="space-y-2">
      <div className="flex gap-2 flex-wrap items-end">
        <label className="flex flex-col">
          <span className="font-mono text-[10px] tracking-wider uppercase text-op-muted mb-1">
            Monto (COP)
          </span>
          <input
            type="number"
            value={amountCop}
            onChange={(e) => setAmountCop(e.target.value)}
            min={0}
            step={1000}
            className="h-9 w-36 px-2 rounded-lg border border-op-border bg-op-bg font-mono text-sm tabular"
          />
        </label>
        <label className="flex flex-col">
          <span className="font-mono text-[10px] tracking-wider uppercase text-op-muted mb-1">
            Método
          </span>
          <select
            value={method}
            onChange={(e) =>
              setMethod(e.target.value as typeof method)
            }
            className="h-9 px-2 rounded-lg border border-op-border bg-op-bg text-sm"
          >
            <option value="manual_transfer">Transferencia</option>
            <option value="manual_cash">Efectivo</option>
            <option value="wompi">Wompi (futuro)</option>
          </select>
        </label>
        <label className="flex flex-col flex-1 min-w-[180px]">
          <span className="font-mono text-[10px] tracking-wider uppercase text-op-muted mb-1">
            Nota (opcional)
          </span>
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={240}
            placeholder="Factura #… / referencia"
            className="h-9 px-2 rounded-lg border border-op-border bg-op-bg text-sm"
          />
        </label>
        <button
          type="submit"
          disabled={busy}
          className="h-9 px-4 rounded-full bg-terracotta text-bone text-sm font-medium disabled:opacity-60"
        >
          {busy ? "Registrando…" : "Marcar pago"}
        </button>
      </div>
      {err && <div className="text-danger text-xs">{err}</div>}
      <div className="text-[11px] text-op-muted">
        Registra un pago manual y extiende el periodo un mes.
      </div>
    </form>
  );
}

export function SuspendButton({
  restaurantId,
  suspended,
}: {
  restaurantId: string;
  suspended: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [, startTx] = useTransition();

  async function toggle() {
    const next = !suspended;
    const label = next
      ? "¿Suspender acceso del restaurante?"
      : "¿Reactivar acceso del restaurante?";
    if (!window.confirm(label)) return;
    setBusy(true);
    const res = await fetch(`/api/admin/membership/${restaurantId}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "set_suspended", suspended: next }),
    });
    setBusy(false);
    if (!res.ok) {
      alert("No se pudo cambiar.");
      return;
    }
    startTx(() => router.refresh());
  }

  return (
    <button
      onClick={toggle}
      disabled={busy}
      className={
        "h-8 px-3 rounded-full text-xs font-medium border " +
        (suspended
          ? "bg-ok/10 text-[#1E5339] border-ok/30"
          : "bg-danger/10 text-danger border-danger/30")
      }
    >
      {suspended ? "Reactivar" : "Suspender"}
    </button>
  );
}

export function ServiceModePicker({
  restaurantId,
  serviceMode,
}: {
  restaurantId: string;
  serviceMode: "table" | "counter";
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [, startTx] = useTransition();

  async function set(next: "table" | "counter") {
    if (next === serviceMode || busy) return;
    const confirmMsg =
      next === "counter"
        ? "Al pasar a modo mostrador los clientes dejarán de escanear por mesa. ¿Continuar?"
        : "Al volver a modo con mesas necesitas tener al menos una mesa creada. ¿Continuar?";
    if (!window.confirm(confirmMsg)) return;
    setBusy(true);
    const res = await fetch(`/api/admin/membership/${restaurantId}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "set_service_mode", serviceMode: next }),
    });
    setBusy(false);
    if (!res.ok) {
      alert("No se pudo cambiar el modo.");
      return;
    }
    startTx(() => router.refresh());
  }

  return (
    <div className="flex gap-2 flex-wrap">
      {(
        [
          { value: "table", label: "Con mesas" },
          { value: "counter", label: "Mostrador" },
        ] as const
      ).map((o) => (
        <button
          key={o.value}
          onClick={() => set(o.value)}
          disabled={busy}
          className={
            "h-8 px-3 rounded-full text-xs border disabled:opacity-60 " +
            (serviceMode === o.value
              ? "bg-ink text-bone border-ink"
              : "bg-op-bg border-op-border")
          }
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function PickupToggle({
  restaurantId,
  pickupEnabled,
}: {
  restaurantId: string;
  pickupEnabled: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [, startTx] = useTransition();

  async function toggle() {
    const next = !pickupEnabled;
    if (
      next &&
      !window.confirm(
        "Activar pedido anticipado mostrará un QR de recogida y los clientes podrán prepagar para recoger en el mostrador. ¿Continuar?",
      )
    )
      return;
    setBusy(true);
    const res = await fetch(`/api/admin/membership/${restaurantId}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "set_pickup_enabled",
        pickupEnabled: next,
      }),
    });
    setBusy(false);
    if (!res.ok) {
      alert("No se pudo cambiar.");
      return;
    }
    startTx(() => router.refresh());
  }

  return (
    <button
      onClick={toggle}
      disabled={busy}
      className={
        "h-8 px-3 rounded-full text-xs border disabled:opacity-60 " +
        (pickupEnabled
          ? "bg-ink text-bone border-ink"
          : "bg-op-bg border-op-border")
      }
    >
      {pickupEnabled ? "Activado" : "Desactivado"}
    </button>
  );
}

export { fmtCOP };
