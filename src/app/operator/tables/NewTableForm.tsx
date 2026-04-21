"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

export function NewTableForm({ suggestedNumber }: { suggestedNumber: number }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [number, setNumber] = useState<string>(String(suggestedNumber));
  const [label, setLabel] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [, startTx] = useTransition();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const n = Number(number);
    if (!Number.isInteger(n) || n < 1) {
      setErr("El número debe ser un entero positivo.");
      return;
    }
    setErr(null);
    setBusy(true);
    const res = await fetch("/api/operator/tables", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ number: n, label: label.trim() || undefined }),
    });
    setBusy(false);
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      setErr(j.error ?? "No se pudo crear la mesa.");
      return;
    }
    setNumber(String(n + 1));
    setLabel("");
    setOpen(false);
    startTx(() => router.refresh());
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="h-10 px-5 rounded-full bg-ink text-bone inline-flex items-center text-sm font-medium"
      >
        + Añadir mesa
      </button>
    );
  }

  return (
    <form
      onSubmit={submit}
      className="flex flex-wrap items-end gap-3 bg-op-surface border border-op-border rounded-xl px-4 py-3"
    >
      <label className="flex flex-col">
        <span className="font-mono text-[10px] tracking-[0.14em] uppercase text-op-muted mb-1">
          Número
        </span>
        <input
          type="number"
          min={1}
          max={999}
          value={number}
          onChange={(e) => setNumber(e.target.value)}
          className="w-20 h-10 px-3 rounded-lg border border-op-border bg-op-bg text-sm"
          autoFocus
        />
      </label>
      <label className="flex flex-col flex-1 min-w-[160px]">
        <span className="font-mono text-[10px] tracking-[0.14em] uppercase text-op-muted mb-1">
          Etiqueta (opcional)
        </span>
        <input
          type="text"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="Terraza, Ventana…"
          maxLength={40}
          className="h-10 px-3 rounded-lg border border-op-border bg-op-bg text-sm"
        />
      </label>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => {
            setOpen(false);
            setErr(null);
          }}
          className="h-10 px-4 rounded-full border border-op-border text-sm"
        >
          Cancelar
        </button>
        <button
          type="submit"
          disabled={busy}
          className="h-10 px-5 rounded-full bg-ink text-bone text-sm font-medium disabled:opacity-60"
        >
          {busy ? "Creando…" : "Crear"}
        </button>
      </div>
      {err && (
        <div className="w-full text-danger text-xs">{err}</div>
      )}
    </form>
  );
}
