"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import type { Locale } from "@/i18n/config";
import { fmtCOP, formatDate } from "@/lib/format";
import { fmtBogotaDateTime } from "@/lib/bogota";

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
  depositStatus: string;
  depositCents: number | null;
};

const OFFSET_MS = -5 * 60 * 60 * 1000;

const DEPOSIT_META: Record<string, { labelKey: string; tint: string }> = {
  pending: { labelKey: "depositPending", tint: "bg-[#C98A2E]/15 text-[#8F6828]" },
  paid: { labelKey: "depositPaid", tint: "bg-[#2E6B4C]/15 text-[#1E5339]" },
  applied: { labelKey: "depositAppliedLabel", tint: "bg-op-bg text-op-muted" },
  forfeited: { labelKey: "depositForfeited", tint: "bg-danger/15 text-danger" },
  refunded: { labelKey: "depositRefunded", tint: "bg-op-bg text-op-muted" },
};

function fmtDayTime(iso: string, locale: Locale): { day: string; time: string } {
  const d = new Date(iso);
  // formatDate usa America/Bogota por defecto — mismo día calendario que
  // fmtBogotaDateTime, del que tomamos la hora HH:MM.
  const day = formatDate(d, {
    locale,
    weekday: "short",
    day: "numeric",
    month: "short",
  });
  return { day, time: fmtBogotaDateTime(d).time };
}

const STATUS_META: Record<string, { labelKey: string; tint: string }> = {
  pending: { labelKey: "statusPending", tint: "bg-[#C98A2E]/15 text-[#8F6828]" },
  confirmed: { labelKey: "statusConfirmed", tint: "bg-[#2E6B4C]/15 text-[#1E5339]" },
  seated: { labelKey: "statusSeated", tint: "bg-[#2E6B4C]/25 text-[#1E5339]" },
  completed: { labelKey: "statusCompleted", tint: "bg-op-bg text-op-muted" },
  cancelled: { labelKey: "statusCancelled", tint: "bg-danger/15 text-danger" },
  no_show: { labelKey: "statusNoShow", tint: "bg-danger/15 text-danger" },
};

const SOURCE_KEYS: Record<string, string> = {
  direct: "sourceDirect",
  google_maps: "sourceGoogleMaps",
  whatsapp: "sourceWhatsapp",
  phone: "sourcePhone",
};

const FILTERS = [
  { key: "active", labelKey: "filterActive" },
  { key: "today", labelKey: "filterToday" },
  { key: "all", labelKey: "filterAll" },
] as const;
type FilterKey = (typeof FILTERS)[number]["key"];

export function ReservasBoard({
  initialRows,
}: {
  initialRows: ReservationRow[];
}) {
  const t = useTranslations("opReservas");
  const locale = useLocale() as Locale;
  const router = useRouter();
  const [rows, setRows] = useState(initialRows);
  const [filter, setFilter] = useState<FilterKey>("active");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  async function setStatus(id: string, status: string) {
    setBusyId(id);
    setMsg(null);
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

  async function applyDeposit(id: string) {
    setBusyId(id);
    setMsg(null);
    const res = await fetch(`/api/operator/reservations/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "apply_deposit" }),
    });
    await res.json().catch(() => ({}));
    setBusyId(null);
    if (res.ok) {
      setRows((rs) =>
        rs.map((r) => (r.id === id ? { ...r, depositStatus: "applied" } : r)),
      );
      setMsg(t("depositApplied"));
      router.refresh();
    } else {
      setMsg(t("depositError"));
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

  const emptyMsg =
    filter === "active"
      ? t("emptyActive")
      : filter === "today"
        ? t("emptyToday")
        : t("emptyAll");

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
            {t(f.labelKey)}
          </button>
        ))}
      </div>

      {msg && (
        <div className="mb-3 rounded-xl border border-op-border bg-op-surface px-4 py-2 text-sm text-op-text">
          {msg}
        </div>
      )}

      {filtered.length === 0 ? (
        <div className="rounded-2xl border border-op-border bg-op-surface px-4 py-10 text-center text-sm text-op-muted">
          {emptyMsg}
        </div>
      ) : (
        <ul className="space-y-2">
          {filtered.map((r) => {
            const { day, time } = fmtDayTime(r.startsAtISO, locale);
            const meta = STATUS_META[r.status];
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
                          (meta?.tint ?? "bg-op-bg text-op-muted")
                        }
                      >
                        {meta ? t(meta.labelKey) : r.status}
                      </span>
                      {r.depositStatus !== "none" &&
                        r.depositCents != null &&
                        r.depositCents > 0 && (
                          <span
                            className={
                              "inline-flex items-center h-5 px-2 rounded-full text-[10px] font-medium " +
                              (DEPOSIT_META[r.depositStatus]?.tint ??
                                "bg-op-bg text-op-muted")
                            }
                          >
                            {DEPOSIT_META[r.depositStatus]
                              ? t(DEPOSIT_META[r.depositStatus].labelKey)
                              : t("depositGeneric")}{" "}
                            {fmtCOP(r.depositCents)}
                          </span>
                        )}
                    </div>
                    <div className="text-sm mt-1">
                      <strong>{r.customerName}</strong>{" "}
                      <span aria-hidden>{"· "}</span>
                      {t("cardMeta", {
                        party: t("partySize", { count: r.partySize }),
                        table: r.tableLabel,
                      })}
                    </div>
                    <div className="text-[11px] text-op-muted mt-0.5">
                      {r.customerPhone ? `${r.customerPhone} · ` : ""}
                      {r.customerEmail}
                      {" · "}
                      {SOURCE_KEYS[r.source] ? t(SOURCE_KEYS[r.source]) : r.source}
                      {" · "}
                      {r.confirmationCode}
                    </div>
                    {r.notes && (
                      <div className="text-[11px] text-ink-3 mt-1 italic">
                        {"“"}
                        {r.notes}
                        {"”"}
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
                      {t("actionConfirm")}
                    </ActionBtn>
                  )}
                  {(r.status === "pending" || r.status === "confirmed") && (
                    <>
                      <ActionBtn
                        onClick={() => setStatus(r.id, "seated")}
                        disabled={busy}
                      >
                        {t("actionArrived")}
                      </ActionBtn>
                      <ActionBtn
                        onClick={() => setStatus(r.id, "no_show")}
                        disabled={busy}
                        tone="danger"
                      >
                        {t("actionNoShow")}
                      </ActionBtn>
                      <ActionBtn
                        onClick={() => setStatus(r.id, "cancelled")}
                        disabled={busy}
                        tone="muted"
                      >
                        {t("actionCancel")}
                      </ActionBtn>
                    </>
                  )}
                  {r.status === "seated" &&
                    r.depositStatus === "paid" &&
                    r.depositCents != null &&
                    r.depositCents > 0 && (
                      <ActionBtn
                        onClick={() => applyDeposit(r.id)}
                        disabled={busy}
                        tone="ok"
                      >
                        {t("actionApplyDeposit", { amount: fmtCOP(r.depositCents) })}
                      </ActionBtn>
                    )}
                  {r.status === "seated" && (
                    <ActionBtn
                      onClick={() => setStatus(r.id, "completed")}
                      disabled={busy}
                    >
                      {t("actionComplete")}
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
