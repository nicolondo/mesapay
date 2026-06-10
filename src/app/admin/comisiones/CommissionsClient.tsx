"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { fmtCOP } from "@/lib/format";

type Rep = { id: string; name: string | null; email: string };

type EntryStatus = "pending" | "paid" | "reversed";

type Entry = {
  id: string;
  createdAt: string;
  baseAmountCents: number;
  bps: number;
  amountCents: number;
  status: EntryStatus;
  salesRep: { id: string; email: string; name: string | null };
  restaurant: { id: string; name: string; slug: string };
  membershipPayment: {
    periodStart: string;
    periodEnd: string;
  } | null;
};

type ApiResponse = {
  entries: Entry[];
  totals: { pendingCents: number; paidCents: number };
};

function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString("es-CO", {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "America/Bogota",
  });
}

export function CommissionsClient({ comerciales }: { comerciales: Rep[] }) {
  const t = useTranslations("opAdminCommissions");

  const [status, setStatus] = useState("");
  const [repId, setRepId] = useState("");
  const [month, setMonth] = useState("");

  const [data, setData] = useState<ApiResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionMsg, setActionMsg] = useState<{
    kind: "ok" | "error";
    text: string;
  } | null>(null);

  const [selected, setSelected] = useState<Set<string>>(new Set());

  const fetchData = useCallback(() => {
    const params = new URLSearchParams();
    if (status) params.set("status", status);
    if (repId) params.set("salesRepUserId", repId);
    if (month) params.set("month", month);
    fetch(`/api/admin/commissions?${params.toString()}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((json) => {
        if (json) setData(json as ApiResponse);
        setLoading(false);
        setSelected(new Set());
      })
      .catch(() => setLoading(false));
  }, [status, repId, month]);

  // Kick off a new fetch whenever filters change. We set loading=true
  // via the initialState (useState(true)) and after each action call;
  // we avoid calling setState synchronously in the effect body to satisfy
  // the react-hooks/set-state-in-effect rule.
  useEffect(() => {
    fetchData();
  }, [fetchData]);

  function toggleSelect(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAll() {
    if (!data) return;
    const pendingIds = data.entries
      .filter((e) => e.status === "pending")
      .map((e) => e.id);
    if (pendingIds.every((id) => selected.has(id))) {
      setSelected(new Set());
    } else {
      setSelected(new Set(pendingIds));
    }
  }

  async function markPaid() {
    const ids = Array.from(selected);
    if (ids.length === 0) return;
    const note = window.prompt(t("markPaidConfirmTitle")) ?? undefined;
    setActionMsg(null);
    const res = await fetch("/api/admin/commissions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "mark_paid", ids, paidNote: note }),
    });
    if (res.ok) {
      setActionMsg({ kind: "ok", text: t("actionOk") });
      fetchData();
    } else {
      setActionMsg({ kind: "error", text: t("actionFailed") });
    }
  }

  async function reverseSelected() {
    const ids = Array.from(selected);
    if (ids.length === 0) return;
    if (!window.confirm(t("reverseConfirm", { count: ids.length }))) return;
    setActionMsg(null);
    const res = await fetch("/api/admin/commissions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "reverse", ids }),
    });
    if (res.ok) {
      setActionMsg({ kind: "ok", text: t("actionOk") });
      fetchData();
    } else {
      setActionMsg({ kind: "error", text: t("actionFailed") });
    }
  }

  const pendingSelected = data
    ? data.entries
        .filter((e) => e.status === "pending" && selected.has(e.id))
        .map((e) => e.id)
    : [];
  const anySelected = selected.size > 0;

  return (
    <div>
      {/* Filters */}
      <div className="flex flex-wrap gap-3 mb-4">
        <div>
          <label className="block font-mono text-[10px] tracking-wider uppercase text-op-muted mb-1">
            {t("filterStatus")}
          </label>
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            className="h-9 px-3 rounded-lg border border-op-border bg-op-surface text-sm focus:outline-none focus:border-terracotta"
          >
            <option value="">{t("filterAll")}</option>
            <option value="pending">{t("filterPending")}</option>
            <option value="paid">{t("filterPaid")}</option>
            <option value="reversed">{t("filterReversed")}</option>
          </select>
        </div>

        <div>
          <label className="block font-mono text-[10px] tracking-wider uppercase text-op-muted mb-1">
            {t("filterRep")}
          </label>
          <select
            value={repId}
            onChange={(e) => setRepId(e.target.value)}
            className="h-9 px-3 rounded-lg border border-op-border bg-op-surface text-sm focus:outline-none focus:border-terracotta"
          >
            <option value="">{t("filterAllReps")}</option>
            {comerciales.map((rep) => (
              <option key={rep.id} value={rep.id}>
                {rep.name ? `${rep.name} (${rep.email})` : rep.email}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="block font-mono text-[10px] tracking-wider uppercase text-op-muted mb-1">
            {t("filterMonth")}
          </label>
          <input
            type="month"
            value={month}
            onChange={(e) => setMonth(e.target.value)}
            className="h-9 px-3 rounded-lg border border-op-border bg-op-surface text-sm focus:outline-none focus:border-terracotta font-mono"
          />
        </div>
      </div>

      {/* Totals chips */}
      {data && (
        <div className="flex flex-wrap gap-2 mb-4">
          <Chip variant="amber">
            {t("chipPending", { amount: fmtCOP(data.totals.pendingCents) })}
          </Chip>
          <Chip variant="green">
            {t("chipPaid", { amount: fmtCOP(data.totals.paidCents) })}
          </Chip>
        </div>
      )}

      {/* Action buttons */}
      {anySelected && (
        <div className="flex items-center gap-3 mb-4">
          {pendingSelected.length > 0 && (
            <button
              type="button"
              onClick={markPaid}
              className="h-9 px-4 rounded-full bg-ink text-bone text-sm font-medium"
            >
              {t("markPaid")}
            </button>
          )}
          <button
            type="button"
            onClick={reverseSelected}
            className="h-9 px-4 rounded-full border border-op-border bg-op-surface text-sm font-medium text-op-text hover:bg-op-bg"
          >
            {t("reverse")}
          </button>
          {actionMsg && (
            <span
              className={
                "text-sm " +
                (actionMsg.kind === "ok" ? "text-ok" : "text-danger")
              }
            >
              {actionMsg.text}
            </span>
          )}
        </div>
      )}

      {/* Table */}
      <div className="rounded-2xl border border-op-border bg-op-surface overflow-hidden">
        {loading ? (
          <div className="p-6 text-sm text-op-muted">{t("loading")}</div>
        ) : !data || data.entries.length === 0 ? (
          <div className="p-6 text-sm text-op-muted">{t("empty")}</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-op-border">
                  <th className="px-4 py-3 w-8">
                    <input
                      type="checkbox"
                      checked={
                        data.entries
                          .filter((e) => e.status === "pending")
                          .every((e) => selected.has(e.id)) &&
                        data.entries.some((e) => e.status === "pending")
                      }
                      onChange={toggleAll}
                      className="rounded"
                    />
                  </th>
                  <Th>{t("colDate")}</Th>
                  <Th>{t("colRep")}</Th>
                  <Th>{t("colRestaurant")}</Th>
                  <Th>{t("colPeriod")}</Th>
                  <Th>{t("colBase")}</Th>
                  <Th>{t("colPct")}</Th>
                  <Th>{t("colAmount")}</Th>
                  <Th>{t("colStatus")}</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-op-border">
                {data.entries.map((e) => (
                  <tr key={e.id} className={selected.has(e.id) ? "bg-op-bg/60" : ""}>
                    <td className="px-4 py-3">
                      <input
                        type="checkbox"
                        checked={selected.has(e.id)}
                        onChange={() => toggleSelect(e.id)}
                        className="rounded"
                      />
                    </td>
                    <Td className="font-mono text-[11px] text-op-muted whitespace-nowrap">
                      {fmtDate(e.createdAt)}
                    </Td>
                    <Td>
                      <div className="text-sm">
                        {e.salesRep.name ?? e.salesRep.email}
                      </div>
                      <div className="font-mono text-[10px] text-op-muted">
                        {e.salesRep.email}
                      </div>
                    </Td>
                    <Td>{e.restaurant.name}</Td>
                    <Td className="font-mono text-[11px] text-op-muted whitespace-nowrap">
                      {e.membershipPayment
                        ? `${fmtDate(e.membershipPayment.periodStart)} → ${fmtDate(e.membershipPayment.periodEnd)}`
                        : "—"}
                    </Td>
                    <Td className="font-mono tabular">
                      {fmtCOP(e.baseAmountCents)}
                    </Td>
                    <Td className="font-mono tabular">
                      {(e.bps / 100).toFixed(2)}
                      {"%"}
                    </Td>
                    <Td className="font-mono tabular font-medium">
                      {fmtCOP(e.amountCents)}
                    </Td>
                    <Td>
                      <CommBadge status={e.status} t={t} />
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return (
    <th className="px-4 py-3 text-left font-mono text-[10px] tracking-wider uppercase text-op-muted font-normal">
      {children}
    </th>
  );
}

function Td({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return <td className={"px-4 py-3 " + (className ?? "")}>{children}</td>;
}

function Chip({
  children,
  variant,
}: {
  children: React.ReactNode;
  variant: "amber" | "green";
}) {
  const cls =
    variant === "amber"
      ? "bg-[#C98A2E]/15 text-[#7F5A1F] border-[#C98A2E]/50"
      : "bg-ok/10 text-[#1E5339] border-ok/30";
  return (
    <span
      className={
        "font-mono text-[11px] px-3 py-1 rounded-full border " + cls
      }
    >
      {children}
    </span>
  );
}

type TFunc = ReturnType<typeof useTranslations<"opAdminCommissions">>;

function CommBadge({
  status,
  t,
}: {
  status: EntryStatus;
  t: TFunc;
}) {
  const map: Record<EntryStatus, string> = {
    pending: "bg-[#C98A2E]/15 text-[#7F5A1F] border-[#C98A2E]/50",
    paid: "bg-ok/10 text-[#1E5339] border-ok/30",
    reversed: "bg-op-bg text-op-muted border-op-border",
  };
  const label: Record<EntryStatus, string> = {
    pending: t("statusPending"),
    paid: t("statusPaid"),
    reversed: t("statusReversed"),
  };
  return (
    <span
      className={
        "font-mono text-[10px] tracking-wider uppercase px-2 py-0.5 rounded border " +
        map[status]
      }
    >
      {label[status]}
    </span>
  );
}
