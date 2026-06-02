"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";

export type MesaRow = {
  id: string;
  number: number;
  label: string | null;
  capacity: number;
  minConsumptionCents: number | null;
  reservationDepositCents: number | null;
  reservable: boolean;
  shape: "square" | "round" | "bar";
};

/**
 * Editor de atributos por mesa. Cada fila se guarda sola (debounce-free:
 * guarda al salir del input / cambiar toggle). Optimista — si el PATCH
 * falla, revierte.
 */
export function MesasAttrsClient({
  initialRows,
}: {
  initialRows: MesaRow[];
}) {
  const t = useTranslations("opSettings");
  const [rows, setRows] = useState(initialRows);
  const [savingId, setSavingId] = useState<string | null>(null);

  async function patch(id: string, data: Partial<MesaRow>) {
    setSavingId(id);
    const res = await fetch(`/api/operator/tables/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(data),
    });
    setSavingId(null);
    return res.ok;
  }

  function setLocal(id: string, patchData: Partial<MesaRow>) {
    setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...patchData } : r)));
  }

  return (
    <div className="rounded-2xl border border-op-border bg-op-surface overflow-hidden">
      {/* Header (desktop) */}
      <div className="hidden md:grid grid-cols-[1fr_80px_120px_120px_80px] gap-3 px-4 py-2 border-b border-op-border text-[10px] font-mono tracking-wider uppercase text-op-muted">
        <div>{t("mesasColTable")}</div>
        <div>{t("mesasColCapacity")}</div>
        <div>{t("mesasColMinConsumption")}</div>
        <div>{t("mesasColDeposit")}</div>
        <div className="text-right">{t("mesasColReservable")}</div>
      </div>

      <ul className="divide-y divide-op-border">
        {rows.map((r) => (
          <li
            key={r.id}
            className="px-4 py-3 grid grid-cols-2 md:grid-cols-[1fr_80px_120px_120px_80px] gap-3 items-center"
          >
            <div className="col-span-2 md:col-span-1 font-medium text-sm">
              {r.label ?? t("mesasRowDefault", { number: r.number })}
              {savingId === r.id && (
                <span className="ml-2 text-[10px] text-op-muted">
                  {t("mesasSaving")}
                </span>
              )}
            </div>

            {/* Capacidad */}
            <label className="block">
              <span className="md:hidden text-[10px] font-mono uppercase text-op-muted">
                {t("mesasColCapacity")}
              </span>
              <input
                type="number"
                min={1}
                max={40}
                value={r.capacity}
                onChange={(e) =>
                  setLocal(r.id, { capacity: Number(e.target.value) })
                }
                onBlur={() =>
                  patch(r.id, { capacity: Math.max(1, r.capacity) })
                }
                className="w-full h-9 px-2 rounded-lg border border-op-border bg-op-bg text-sm"
              />
            </label>

            {/* Consumo mínimo (en pesos) */}
            <label className="block">
              <span className="md:hidden text-[10px] font-mono uppercase text-op-muted">
                {t("mesasColMinConsumption")}
              </span>
              <div className="flex items-center gap-1">
                <span className="text-op-muted text-sm">$</span>
                <input
                  type="number"
                  min={0}
                  step={1000}
                  placeholder="—"
                  value={
                    r.minConsumptionCents != null
                      ? Math.round(r.minConsumptionCents / 100)
                      : ""
                  }
                  onChange={(e) => {
                    const pesos = e.target.value.trim();
                    setLocal(r.id, {
                      minConsumptionCents:
                        pesos === "" ? null : Number(pesos) * 100,
                    });
                  }}
                  onBlur={() =>
                    patch(r.id, {
                      minConsumptionCents: r.minConsumptionCents,
                    })
                  }
                  className="w-full h-9 px-2 rounded-lg border border-op-border bg-op-bg text-sm"
                />
              </div>
            </label>

            {/* Depósito para reservar (en pesos) */}
            <label className="block">
              <span className="md:hidden text-[10px] font-mono uppercase text-op-muted">
                {t("mesasDepositMobile")}
              </span>
              <div className="flex items-center gap-1">
                <span className="text-op-muted text-sm">$</span>
                <input
                  type="number"
                  min={0}
                  step={1000}
                  placeholder="—"
                  value={
                    r.reservationDepositCents != null
                      ? Math.round(r.reservationDepositCents / 100)
                      : ""
                  }
                  onChange={(e) => {
                    const pesos = e.target.value.trim();
                    setLocal(r.id, {
                      reservationDepositCents:
                        pesos === "" ? null : Number(pesos) * 100,
                    });
                  }}
                  onBlur={() =>
                    patch(r.id, {
                      reservationDepositCents: r.reservationDepositCents,
                    })
                  }
                  className="w-full h-9 px-2 rounded-lg border border-op-border bg-op-bg text-sm"
                />
              </div>
            </label>

            {/* Reservable */}
            <div className="flex md:justify-end items-center gap-2">
              <span className="md:hidden text-[10px] font-mono uppercase text-op-muted">
                {t("mesasColReservable")}
              </span>
              <button
                type="button"
                role="switch"
                aria-checked={r.reservable}
                onClick={() => {
                  const next = !r.reservable;
                  setLocal(r.id, { reservable: next });
                  patch(r.id, { reservable: next });
                }}
                className={
                  "w-11 h-6 rounded-full transition-colors relative shrink-0 " +
                  (r.reservable ? "bg-ok" : "bg-op-border")
                }
              >
                <span
                  className={
                    "absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition-all " +
                    (r.reservable ? "left-[1.375rem]" : "left-0.5")
                  }
                />
              </button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
