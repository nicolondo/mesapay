"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

export type MesaPick = {
  number: number;
  label: string | null;
  occupied: boolean;
  mine: boolean;
  // Nombre del otro mesero que la tiene, o null si nadie/ yo.
  holderName: string | null;
};

/**
 * "Mis mesas" interactivo — el mesero toca una mesa para tomarla o
 * soltarla. Una mesa que atiende otro mesero solo se puede tomar si está
 * libre; si está ocupada, queda bloqueada. El backend
 * (/api/mesero/tables/assign) es la fuente de verdad y serializa los
 * cambios; acá hacemos refresh tras cada acción.
 */
export function MisMesasClient({ tables }: { tables: MesaPick[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState<number | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [, startTx] = useTransition();

  const mineCount = tables.filter((t) => t.mine).length;

  async function tap(t: MesaPick) {
    // Bloqueada: ocupada y la atiende otro mesero.
    if (!t.mine && t.holderName && t.occupied) {
      setMsg(`Mesa ${t.number}: la está atendiendo ${t.holderName} (ocupada).`);
      return;
    }
    setMsg(null);
    setBusy(t.number);
    const res = await fetch("/api/mesero/tables/assign", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ number: t.number, assign: !t.mine }),
    });
    setBusy(null);
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      if (j.error === "occupied") {
        setMsg(
          `Mesa ${t.number}: la está atendiendo ${j.holder ?? "otro mesero"} (ocupada).`,
        );
      } else {
        setMsg("No se pudo actualizar. Intenta de nuevo.");
      }
      return;
    }
    startTx(() => router.refresh());
  }

  return (
    <section className="rounded-2xl border border-hairline bg-paper p-5">
      <div className="flex items-center justify-between mb-1">
        <div className="font-mono text-[10px] tracking-[0.15em] uppercase text-muted">
          Mis mesas
        </div>
        <div className="font-mono text-[10px] text-muted-2">
          {mineCount === 0
            ? "Ninguna asignada"
            : `${mineCount} ${mineCount === 1 ? "mesa" : "mesas"}`}
        </div>
      </div>
      <p className="text-xs text-muted mb-3">
        Toca una mesa para tomarla o soltarla. Una mesa ocupada que atiende
        otro mesero no se puede tomar.
      </p>

      {tables.length === 0 ? (
        <p className="text-sm text-ink/80">No hay mesas creadas todavía.</p>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(60px,1fr))] gap-1.5">
          {tables.map((t) => {
            const blocked = !t.mine && !!t.holderName && t.occupied;
            const sub = t.mine
              ? "Tuya"
              : t.holderName
                ? t.holderName
                : t.occupied
                  ? "Ocupada"
                  : "Libre";
            return (
              <button
                key={t.number}
                type="button"
                disabled={busy === t.number}
                onClick={() => tap(t)}
                aria-pressed={t.mine}
                className={
                  "h-14 rounded-xl border flex flex-col items-center justify-center px-1 transition-colors disabled:opacity-50 " +
                  (t.mine
                    ? "bg-ink text-bone border-ink"
                    : blocked
                      ? "bg-ivory border-hairline text-muted cursor-not-allowed"
                      : "bg-paper border-hairline text-ink active:bg-ivory")
                }
              >
                <span className="text-base font-medium tabular leading-none">
                  {t.number}
                </span>
                <span
                  className={
                    "text-[9px] leading-tight mt-0.5 truncate max-w-full " +
                    (t.mine ? "text-bone/80" : "text-muted")
                  }
                >
                  {sub}
                </span>
              </button>
            );
          })}
        </div>
      )}

      {msg && <div className="mt-3 text-xs text-terracotta">{msg}</div>}
    </section>
  );
}
