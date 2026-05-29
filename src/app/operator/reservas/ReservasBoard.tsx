"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export type ReservationRow = {
  id: string;
  customerName: string;
  customerEmail: string;
  customerPhone: string | null;
  partySize: number;
  startsAtISO: string;
  status: string;
  source: string;
  notes: string | null;
  tableLabel: string;
  confirmationCode: string;
};

const OFFSET_MS = -5 * 60 * 60 * 1000;

function fmtDayTime(iso: string): { day: string; time: string } {
  const d = new Date(iso);
  const b = new Date(d.getTime() + OFFSET_MS);
  const day = b.toLocaleDateString("es-CO", {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });
  const time = `${String(b.getUTCHours()).padStart(2, "0")}:${String(b.getUTCMinutes()).padStart(2, "0")}`;
  return { day, time };
}

const STATUS_META: Record<string, { label: string; tint: string }> = {
  pending: { label: "Pendiente", tint: "bg-[#C98A2E]/15 text-[#8F6828]" },
  confirmed: { label: "Confirmada", tint: "bg-[#2E6B4C]/15 text-[#1E5339]" },
  seated: { label: "Sentados", tint: "bg-[#2E6B4C]/25 text-[#1E5339]" },
  completed: { label: "Completada", tint: "bg-op-bg text-op-muted" },
  cancelled: { label: "Cancelada", tint: "bg-danger/15 text-danger" },
  no_show: { label: "No-show", tint: "bg-danger/15 text-danger" },
};

const SOURCE_LABEL: Record<string, string> = {
  direct: "Link directo",
  google_maps: "Google Maps",
  whatsapp: "WhatsApp",
  phone: "Teléfono",
};

const FILTERS = [
  { key: "active", label: "Activas" },
  { key: "today", label: "Hoy" },
  { key: "all", label: "Todas" },
] as const;
type FilterKey = (typeof FILTERS)[number]["key"];

export function ReservasBoard({
  initialRows,
}: {
  initialRows: ReservationRow[];
}) {
  const router = useRouter();
  const [rows, setRows] = useState(initialRows);
  const [filter, setFilter] = useState<FilterKey>("active");
  const [busyId, setBusyId] = useState<string | null>(null);

  async function setStatus(id: string, status: string) {
    setBusyId(id);
    const res = await fetch(`/api/operator/reservations/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status }),
    });
    setBusyId(null);
    if (res.ok) {
      // Optimista — actualizamos local + refresh para reordenar.
      setRows((rs) => rs.map((r) => (r.id === id ? { ...r, status } : r)));
      router.refresh();
    }
  }

  const todayBogota = (() => {
    const b = new Date(Date.now() + OFFSET_MS);
    return `${b.getUTCFullYear()}-${b.getUTCMonth()}-${b.getUTCDate()}`;
  })();

  const filtered = rows.filter((r) => {
    if (filter === "all") return true;
    if (filter === "active")
      return r.status === "pending" || r.status === "confirmed" || r.status === "seated";
    if (filter === "today") {
      const b = new Date(new Date(r.startsAtISO).getTime() + OFFSET_MS);
      const key = `${b.getUTCFullYear()}-${b.getUTCMonth()}-${b.getUTCDate()}`;
      return key === todayBogota;
    }
    return true;
  });

  return (
    <div>
      <div className="flex gap-2 mb-4">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            type="button"
            onClick={() => setFilter(f.key)}
            className={
              "h-8 px-3 rounded-full text-xs font-medium border " +
              (filter === f.key
                ? "bg-ink text-bone border-ink"
                : "bg-op-surface border-op-border text-op-muted hover:text-op-text")
            }
          >
            {f.label}
          </button>
        ))}
      </div>

      {filtered.length === 0 ? (
        <div className="rounded-2xl border border-op-border bg-op-surface px-4 py-10 text-center text-sm text-op-muted">
          No hay reservas {filter === "active" ? "activas" : filter === "today" ? "para hoy" : ""}.
        </div>
      ) : (
        <ul className="space-y-2">
          {filtered.map((r) => {
            const { day, time } = fmtDayTime(r.startsAtISO);
            const meta = STATUS_META[r.status] ?? {
              label: r.status,
              tint: "bg-op-bg text-op-muted",
            };
            const busy = busyId === r.id;
            return (
              <li
                key={r.id}
                className="rounded-2xl border border-op-border bg-op-surface p-4"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-display text-lg leading-tight">
                        {time}
                      </span>
                      <span className="text-xs text-op-muted">{day}</span>
                      <span
                        className={
                          "inline-flex items-center h-5 px-2 rounded-full text-[10px] font-medium " +
                          meta.tint
                        }
                      >
                        {meta.label}
                      </span>
                    </div>
                    <div className="text-sm mt-1">
                      <strong>{r.customerName}</strong> · {r.partySize}{" "}
                      {r.partySize === 1 ? "persona" : "personas"} ·{" "}
                      {r.tableLabel}
                    </div>
                    <div className="text-[11px] text-op-muted mt-0.5">
                      {r.customerPhone ? `${r.customerPhone} · ` : ""}
                      {r.customerEmail} · {SOURCE_LABEL[r.source] ?? r.source} ·{" "}
                      {r.confirmationCode}
                    </div>
                    {r.notes && (
                      <div className="text-[11px] text-ink-3 mt-1 italic">
                        “{r.notes}”
                      </div>
                    )}
                  </div>
                </div>

                {/* Acciones por estado */}
                <div className="flex flex-wrap gap-2 mt-3">
                  {r.status === "pending" && (
                    <ActionBtn
                      onClick={() => setStatus(r.id, "confirmed")}
                      disabled={busy}
                      tone="ok"
                    >
                      Confirmar
                    </ActionBtn>
                  )}
                  {(r.status === "pending" || r.status === "confirmed") && (
                    <>
                      <ActionBtn
                        onClick={() => setStatus(r.id, "seated")}
                        disabled={busy}
                      >
                        Llegaron
                      </ActionBtn>
                      <ActionBtn
                        onClick={() => setStatus(r.id, "no_show")}
                        disabled={busy}
                        tone="danger"
                      >
                        No-show
                      </ActionBtn>
                      <ActionBtn
                        onClick={() => setStatus(r.id, "cancelled")}
                        disabled={busy}
                        tone="muted"
                      >
                        Cancelar
                      </ActionBtn>
                    </>
                  )}
                  {r.status === "seated" && (
                    <ActionBtn
                      onClick={() => setStatus(r.id, "completed")}
                      disabled={busy}
                    >
                      Marcar completada
                    </ActionBtn>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function ActionBtn({
  children,
  onClick,
  disabled,
  tone = "default",
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  tone?: "default" | "ok" | "danger" | "muted";
}) {
  const cls =
    tone === "ok"
      ? "bg-[#2E6B4C] text-white border-[#2E6B4C]"
      : tone === "danger"
        ? "border-danger/40 text-danger"
        : tone === "muted"
          ? "border-op-border text-op-muted"
          : "bg-ink text-bone border-ink";
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={
        "h-9 px-4 rounded-full text-xs font-medium border disabled:opacity-50 " +
        cls
      }
    >
      {children}
    </button>
  );
}
