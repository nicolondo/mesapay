"use client";

import { useState } from "react";

type Mesero = {
  id: string;
  email: string;
  name: string | null;
  assignedTableNumbers: number[];
};

type Table = {
  number: number;
  label: string | null;
};

export function MeserosClient({
  tables,
  meseros: initial,
}: {
  tables: Table[];
  meseros: Mesero[];
}) {
  const [meseros, setMeseros] = useState<Mesero[]>(initial);

  function applyChange(meseroId: string, tableNumbers: number[]) {
    setMeseros((prev) =>
      prev.map((m) =>
        m.id === meseroId ? { ...m, assignedTableNumbers: tableNumbers } : m,
      ),
    );
  }

  return (
    <div className="space-y-4">
      {meseros.map((m) => (
        <MeseroCard
          key={m.id}
          mesero={m}
          tables={tables}
          onChange={(tns) => applyChange(m.id, tns)}
        />
      ))}
    </div>
  );
}

function MeseroCard({
  mesero,
  tables,
  onChange,
}: {
  mesero: Mesero;
  tables: Table[];
  onChange: (tns: number[]) => void;
}) {
  const [selected, setSelected] = useState<Set<number>>(
    new Set(mesero.assignedTableNumbers),
  );
  const [rangeFrom, setRangeFrom] = useState("");
  const [rangeTo, setRangeTo] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<
    { kind: "ok" | "error"; text: string } | null
  >(null);

  const dirty =
    selected.size !== mesero.assignedTableNumbers.length ||
    mesero.assignedTableNumbers.some((n) => !selected.has(n));

  function toggle(num: number) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(num)) next.delete(num);
      else next.add(num);
      return next;
    });
    setMsg(null);
  }

  function selectAll() {
    setSelected(new Set(tables.map((t) => t.number)));
    setMsg(null);
  }
  function clearAll() {
    setSelected(new Set());
    setMsg(null);
  }
  function applyRange() {
    const from = parseInt(rangeFrom, 10);
    const to = parseInt(rangeTo, 10);
    if (!Number.isFinite(from) || !Number.isFinite(to) || from > to) {
      setMsg({ kind: "error", text: "Rango inválido." });
      return;
    }
    setSelected((prev) => {
      const next = new Set(prev);
      for (const t of tables) {
        if (t.number >= from && t.number <= to) next.add(t.number);
      }
      return next;
    });
    setRangeFrom("");
    setRangeTo("");
    setMsg(null);
  }

  async function save() {
    setBusy(true);
    setMsg(null);
    const payload = Array.from(selected).sort((a, b) => a - b);
    const r = await fetch(`/api/operator/users/${mesero.id}/tables`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tableNumbers: payload }),
    });
    setBusy(false);
    if (!r.ok) {
      setMsg({ kind: "error", text: "No pudimos guardar." });
      return;
    }
    onChange(payload);
    setMsg({ kind: "ok", text: "Guardado." });
  }

  const displayName = mesero.name?.trim() || mesero.email;

  return (
    <div className="rounded-2xl border border-op-border bg-op-surface p-5">
      <div className="flex items-baseline justify-between gap-3 flex-wrap mb-3">
        <div className="min-w-0">
          <div className="font-display text-xl truncate">{displayName}</div>
          {mesero.name && (
            <div className="font-mono text-[11px] text-op-muted truncate">
              {mesero.email}
            </div>
          )}
        </div>
        <div className="font-mono text-[11px] tracking-wider uppercase text-op-muted shrink-0">
          {selected.size === 0
            ? "Atiende todas"
            : `${selected.size} ${selected.size === 1 ? "mesa" : "mesas"}`}
        </div>
      </div>

      {/* Quick actions */}
      <div className="flex items-center gap-2 flex-wrap mb-3">
        <button
          type="button"
          onClick={selectAll}
          className="h-7 px-3 rounded-full bg-op-bg border border-op-border text-[11px] font-medium hover:bg-op-surface"
        >
          Todas
        </button>
        <button
          type="button"
          onClick={clearAll}
          className="h-7 px-3 rounded-full bg-op-bg border border-op-border text-[11px] font-medium hover:bg-op-surface"
        >
          Ninguna
        </button>
        <div className="flex items-center gap-1.5 ml-auto">
          <span className="text-[10px] text-op-muted font-mono uppercase tracking-wider">
            Rango
          </span>
          <input
            type="number"
            value={rangeFrom}
            onChange={(e) => setRangeFrom(e.target.value)}
            placeholder="1"
            className="h-7 w-14 px-2 rounded-md border border-op-border bg-op-bg text-xs font-mono tabular text-center"
          />
          <span className="text-op-muted">→</span>
          <input
            type="number"
            value={rangeTo}
            onChange={(e) => setRangeTo(e.target.value)}
            placeholder="10"
            className="h-7 w-14 px-2 rounded-md border border-op-border bg-op-bg text-xs font-mono tabular text-center"
          />
          <button
            type="button"
            onClick={applyRange}
            className="h-7 px-3 rounded-full bg-ink text-bone text-[11px] font-medium hover:bg-ink/90"
          >
            Sumar
          </button>
        </div>
      </div>

      {/* Pill grid — one per mesa */}
      <div className="grid grid-cols-[repeat(auto-fill,minmax(52px,1fr))] gap-2">
        {tables.map((t) => {
          const on = selected.has(t.number);
          return (
            <button
              key={t.number}
              type="button"
              onClick={() => toggle(t.number)}
              aria-pressed={on}
              className={
                "h-10 rounded-lg text-sm font-medium border transition-colors " +
                (on
                  ? "bg-ink text-bone border-ink"
                  : "bg-op-bg text-op-text border-op-border hover:border-op-text/40")
              }
              title={t.label ?? undefined}
            >
              {t.number}
            </button>
          );
        })}
      </div>

      <div className="mt-4 flex items-center justify-end gap-3">
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
