"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { fmtCOP } from "@/lib/format";

type Movement = {
  id: string;
  kind: string;
  amountCents: number;
  balanceAfterCents: number;
  description: string;
  occurredAt: string;
};

type AutoPolicy =
  | { enabled: false }
  | {
      enabled: true;
      mode: "daily" | "weekly" | "threshold";
      thresholdCents?: number;
      weekdays?: number[];
      time?: string;
    };

export function WalletClient({
  tenantName,
  onboarded,
  bankLabel,
  initialMovements,
  initialPolicy,
}: {
  tenantName: string;
  onboarded: boolean;
  bankLabel: string | null;
  initialMovements: Movement[];
  initialPolicy: AutoPolicy;
}) {
  const router = useRouter();
  const [, startTx] = useTransition();
  const [balance, setBalance] = useState<{
    availableCents: number;
    pendingCents: number;
  } | null>(null);
  const [balanceErr, setBalanceErr] = useState<string | null>(null);
  const [disperseOpen, setDisperseOpen] = useState(false);
  const [policy, setPolicy] = useState<AutoPolicy>(initialPolicy);
  const [savingPolicy, setSavingPolicy] = useState(false);

  useEffect(() => {
    if (!onboarded) return;
    let alive = true;
    fetch("/api/operator/wallet/balance")
      .then((r) => r.json())
      .then((j) => {
        if (!alive) return;
        if (j.error) {
          setBalanceErr(j.error);
        } else {
          setBalance({
            availableCents: j.availableCents,
            pendingCents: j.pendingCents,
          });
        }
      })
      .catch(() => alive && setBalanceErr("balance_failed"));
    return () => {
      alive = false;
    };
  }, [onboarded]);

  async function savePolicy(next: AutoPolicy) {
    setSavingPolicy(true);
    const res = await fetch("/api/operator/wallet/auto-config", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(next),
    });
    setSavingPolicy(false);
    if (res.ok) {
      setPolicy(next);
      startTx(() => router.refresh());
    }
  }

  if (!onboarded) {
    return (
      <div className="p-6 max-w-3xl mx-auto w-full">
        <div className="font-display text-3xl mb-1">Wallet</div>
        <p className="text-sm text-op-muted mb-6">
          Para empezar a recibir dinero necesitas activar pagos en MESAPAY.
        </p>
        <div className="rounded-2xl border border-op-border bg-op-surface p-6 text-center">
          <div className="font-display text-xl">Aún no estás activo</div>
          <p className="text-sm text-op-muted mt-1 mb-4">
            Completa la solicitud para que tu wallet quede habilitada.
          </p>
          <Link
            href="/operator/settings/pagos"
            className="inline-flex h-10 px-5 rounded-full bg-terracotta text-bone font-medium items-center"
          >
            Ir al onboarding
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 max-w-3xl mx-auto w-full">
      <div className="font-mono text-[10px] tracking-[0.18em] uppercase text-op-muted mb-1">
        {tenantName}
      </div>
      <div className="font-display text-3xl mb-1">Wallet</div>
      <p className="text-sm text-op-muted mb-6">
        Saldo disponible y movimientos de tu wallet.
      </p>

      <div className="rounded-2xl bg-ink text-bone p-6 mb-6">
        <div className="font-mono text-[10px] tracking-[0.18em] uppercase opacity-70 mb-1">
          Saldo disponible
        </div>
        <div className="font-display text-4xl tabular">
          {balance ? fmtCOP(balance.availableCents) : "…"}
        </div>
        {balance && balance.pendingCents > 0 && (
          <div className="text-xs opacity-70 mt-1">
            Pendiente: {fmtCOP(balance.pendingCents)}
          </div>
        )}
        {balanceErr && (
          <div className="text-xs text-danger mt-2">
            No pudimos cargar el saldo ({balanceErr}).
          </div>
        )}
        <div className="mt-5 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => setDisperseOpen(true)}
            disabled={!balance || balance.availableCents <= 0 || !bankLabel}
            className="h-10 px-5 rounded-full bg-bone text-ink text-sm font-medium disabled:opacity-50"
          >
            Pasar al banco
          </button>
          {bankLabel && (
            <span className="font-mono text-[10px] tracking-wider uppercase opacity-70 self-center">
              → {bankLabel}
            </span>
          )}
        </div>
      </div>

      <section className="mb-8">
        <div className="font-display text-xl mb-3">Movimientos</div>
        {initialMovements.length === 0 ? (
          <div className="text-sm text-op-muted">
            Aún no hay movimientos. Aparecerán aquí cuando recibas tu primer cobro.
          </div>
        ) : (
          <ul className="divide-y divide-op-border border-y border-op-border">
            {initialMovements.map((m) => (
              <li
                key={m.id}
                className="py-3 flex items-center justify-between gap-4"
              >
                <div className="min-w-0">
                  <div className="text-sm truncate">{m.description}</div>
                  <div className="text-[11px] text-op-muted mt-0.5">
                    {humanKind(m.kind)} ·{" "}
                    {new Date(m.occurredAt).toLocaleString("es-CO")}
                  </div>
                </div>
                <div className="text-right">
                  <div
                    className={
                      "font-mono tabular text-sm " +
                      (m.kind === "credit" ? "text-ok" : "text-op-text")
                    }
                  >
                    {m.kind === "credit" ? "+" : "−"}
                    {fmtCOP(m.amountCents)}
                  </div>
                  <div className="text-[10px] text-op-muted font-mono tabular">
                    Saldo {fmtCOP(m.balanceAfterCents)}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="mb-12">
        <div className="font-display text-xl mb-3">Dispersión automática</div>
        <div className="rounded-2xl border border-op-border bg-op-surface p-5 space-y-3">
          <label className="flex items-center gap-3 text-sm">
            <input
              type="checkbox"
              checked={policy.enabled}
              onChange={(e) => {
                if (!e.target.checked) {
                  savePolicy({ enabled: false });
                } else {
                  savePolicy({
                    enabled: true,
                    mode: "daily",
                    time: "22:00",
                  });
                }
              }}
              disabled={savingPolicy}
            />
            Pasar saldo al banco automáticamente
          </label>
          {policy.enabled && (
            <div className="grid grid-cols-2 gap-3">
              <Select
                label="Frecuencia"
                value={policy.mode}
                options={[
                  ["daily", "Diaria"],
                  ["weekly", "Semanal"],
                  ["threshold", "Cuando pase un umbral"],
                ]}
                onChange={(v) =>
                  savePolicy({
                    ...policy,
                    mode: v as "daily" | "weekly" | "threshold",
                  })
                }
              />
              {policy.mode === "threshold" ? (
                <NumberField
                  label="Umbral en pesos"
                  value={policy.thresholdCents ?? 500000}
                  onChange={(v) =>
                    savePolicy({ ...policy, thresholdCents: v })
                  }
                />
              ) : (
                <TextField
                  label="Hora (24h)"
                  value={policy.time ?? "22:00"}
                  onChange={(v) => savePolicy({ ...policy, time: v })}
                />
              )}
            </div>
          )}
        </div>
      </section>

      {disperseOpen && balance && bankLabel && (
        <DisperseSheet
          maxCents={balance.availableCents}
          bankLabel={bankLabel}
          onClose={() => setDisperseOpen(false)}
          onSuccess={() => {
            setDisperseOpen(false);
            startTx(() => router.refresh());
          }}
        />
      )}
    </div>
  );
}

function DisperseSheet({
  maxCents,
  bankLabel,
  onClose,
  onSuccess,
}: {
  maxCents: number;
  bankLabel: string;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const [amount, setAmount] = useState<number>(maxCents);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function go() {
    if (amount <= 0 || amount > maxCents) {
      setErr("Monto inválido.");
      return;
    }
    setBusy(true);
    setErr(null);
    const res = await fetch("/api/operator/wallet/disperse", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ amountCents: amount }),
    });
    setBusy(false);
    const j = await res.json().catch(() => ({}));
    if (!res.ok) {
      setErr(j.message ?? j.error ?? "No pudimos dispersar.");
      return;
    }
    onSuccess();
  }

  return (
    <div
      className="fixed inset-0 z-50 bg-ink/50 flex items-end md:items-center justify-center"
      onClick={onClose}
    >
      <div
        className="w-full md:max-w-md bg-bone text-ink rounded-t-3xl md:rounded-3xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-5 border-b border-hairline flex items-center justify-between">
          <div className="font-display text-xl">Pasar al banco</div>
          <button onClick={onClose} className="text-muted text-sm">
            Cerrar
          </button>
        </div>
        <div className="p-5 space-y-4">
          <div className="font-mono text-[10px] tracking-wider uppercase text-muted">
            Destino · {bankLabel}
          </div>
          <NumberField
            label="Monto"
            value={amount}
            onChange={(v) => setAmount(Math.min(maxCents, v))}
            hint={`Máximo ${fmtCOP(maxCents)}`}
          />
          {err && <div className="text-danger text-sm">{err}</div>}
          <button
            onClick={go}
            disabled={busy || amount <= 0}
            className="w-full h-12 rounded-full bg-terracotta text-bone font-medium disabled:opacity-60"
          >
            {busy ? "Procesando…" : `Enviar ${fmtCOP(amount)}`}
          </button>
          <p className="text-[11px] text-muted-2 text-center">
            La dispersión normalmente se acredita en 1 día hábil.
          </p>
        </div>
      </div>
    </div>
  );
}

function humanKind(k: string): string {
  switch (k) {
    case "credit":
      return "Cobro";
    case "debit":
      return "Débito";
    case "fee":
      return "Comisión";
    case "dispersion":
      return "Transferencia a banco";
    case "adjustment":
      return "Ajuste";
    default:
      return k;
  }
}

function Select({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: [string, string][];
  onChange: (v: string) => void;
}) {
  return (
    <label className="block">
      <span className="font-mono text-[10px] tracking-wider uppercase text-op-muted">
        {label}
      </span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="mt-1 w-full h-10 px-3 rounded-lg border border-op-border bg-op-surface"
      >
        {options.map(([v, l]) => (
          <option key={v} value={v}>
            {l}
          </option>
        ))}
      </select>
    </label>
  );
}

function NumberField({
  label,
  value,
  onChange,
  hint,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  hint?: string;
}) {
  return (
    <label className="block">
      <span className="font-mono text-[10px] tracking-wider uppercase text-muted">
        {label}
      </span>
      <input
        type="number"
        value={value}
        onChange={(e) => onChange(parseInt(e.target.value, 10) || 0)}
        className="mt-1 w-full h-10 px-3 rounded-lg border border-hairline bg-paper"
      />
      {hint && <span className="text-[11px] text-muted">{hint}</span>}
    </label>
  );
}

function TextField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <label className="block">
      <span className="font-mono text-[10px] tracking-wider uppercase text-op-muted">
        {label}
      </span>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="mt-1 w-full h-10 px-3 rounded-lg border border-op-border bg-op-surface"
      />
    </label>
  );
}
