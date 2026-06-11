"use client";

import { useCallback, useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { fmtCOP } from "@/lib/format";
import { fmtBogotaDateTime } from "@/lib/bogota";

// ── Types ─────────────────────────────────────────────────────────────────────

type RepDetail = {
  id: string;
  name: string | null;
  email: string;
  commissionBps: number | null;
  disabledAt: string | null;
  restaurantCount: number;
  pendingCents: number;
};

// Kept for filters dropdown — subset of RepDetail.
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
  return fmtBogotaDateTime(new Date(iso)).date;
}

// ── Main client component ──────────────────────────────────────────────────────

export function CommissionsClient({ comerciales: initialComerciales }: { comerciales: RepDetail[] }) {
  const t = useTranslations("opAdminCommissions");
  const router = useRouter();
  const [, startTx] = useTransition();

  // Use the prop directly — router.refresh() will cause the page to re-run
  // server-side and pass fresh props down to this component.
  const comerciales = initialComerciales;

  // ── Nuevo comercial form ─────────────────────────────────────────────────────
  const [showNewRep, setShowNewRep] = useState(false);
  const [repEmail, setRepEmail] = useState("");
  const [repName, setRepName] = useState("");
  const [repPassword, setRepPassword] = useState("");
  const [repBps, setRepBps] = useState("");
  const [repBusy, setRepBusy] = useState(false);
  const [repErr, setRepErr] = useState<string | null>(null);
  const [repOk, setRepOk] = useState(false);

  async function createComercial() {
    setRepBusy(true);
    setRepErr(null);
    setRepOk(false);
    const bpsNum = repBps.trim() !== "" ? Math.round(parseFloat(repBps) * 100) : undefined;
    const res = await fetch("/api/admin/users", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: repEmail.trim(),
        name: repName.trim() || undefined,
        password: repPassword,
        role: "comercial",
        ...(bpsNum !== undefined ? { commissionBps: bpsNum } : {}),
      }),
    });
    setRepBusy(false);
    if (!res.ok) {
      const j = await res.json().catch(() => ({})) as { error?: string };
      switch (j.error) {
        case "email_taken": setRepErr(t("newRepErrEmailTaken")); break;
        default: setRepErr(j.error ?? t("newRepErrCreate")); break;
      }
      return;
    }
    setRepEmail("");
    setRepName("");
    setRepPassword("");
    setRepBps("");
    setRepOk(true);
    setShowNewRep(false);
    startTx(() => router.refresh());
  }

  // ── Comerciales management ───────────────────────────────────────────────────

  // Edit form state (null = form closed).
  const [editingRep, setEditingRep] = useState<RepDetail | null>(null);
  const [editName, setEditName] = useState("");
  const [editEmail, setEditEmail] = useState("");
  const [editBps, setEditBps] = useState("");
  const [editPassword, setEditPassword] = useState("");
  const [editBusy, setEditBusy] = useState(false);
  const [editErr, setEditErr] = useState<string | null>(null);
  const [editOk, setEditOk] = useState(false);
  const [mgmtMsg, setMgmtMsg] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  function openEdit(rep: RepDetail) {
    setEditingRep(rep);
    setEditName(rep.name ?? "");
    setEditEmail(rep.email);
    setEditBps(rep.commissionBps !== null ? (rep.commissionBps / 100).toFixed(2) : "");
    setEditPassword("");
    setEditErr(null);
    setEditOk(false);
  }

  function closeEdit() {
    setEditingRep(null);
    setEditErr(null);
    setEditOk(false);
  }

  async function saveEdit() {
    if (!editingRep) return;
    setEditBusy(true);
    setEditErr(null);
    setEditOk(false);
    const body: Record<string, unknown> = {};
    if (editName.trim() !== (editingRep.name ?? "")) body.name = editName.trim();
    if (editEmail.trim().toLowerCase() !== editingRep.email) body.email = editEmail.trim();
    if (editPassword.trim()) body.password = editPassword.trim();
    const bpsRaw = editBps.trim();
    const bpsNum = bpsRaw !== "" ? Math.round(parseFloat(bpsRaw) * 100) : null;
    if (bpsNum !== editingRep.commissionBps) body.commissionBps = bpsNum;
    if (Object.keys(body).length === 0) { setEditBusy(false); closeEdit(); return; }
    const res = await fetch(`/api/admin/users/${editingRep.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    setEditBusy(false);
    if (!res.ok) {
      const j = await res.json().catch(() => ({})) as { error?: string };
      setEditErr(j.error === "email_taken" ? t("newRepErrEmailTaken") : t("mgmtEditFailed"));
      return;
    }
    setEditOk(true);
    closeEdit();
    setMgmtMsg({ kind: "ok", text: t("mgmtEditOk") });
    startTx(() => router.refresh());
  }

  async function toggleDisabled(rep: RepDetail) {
    const isDisabled = rep.disabledAt !== null;
    const confirmMsg = isDisabled
      ? t("mgmtConfirmEnable", { name: rep.name ?? rep.email })
      : t("mgmtConfirmDisable", { name: rep.name ?? rep.email });
    if (!window.confirm(confirmMsg)) return;
    setMgmtMsg(null);
    const res = await fetch(`/api/admin/users/${rep.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ disabled: !isDisabled }),
    });
    if (res.ok) {
      setMgmtMsg({ kind: "ok", text: t("mgmtActionOk") });
      startTx(() => router.refresh());
    } else {
      setMgmtMsg({ kind: "error", text: t("mgmtActionFailed") });
    }
  }

  async function deleteRep(rep: RepDetail) {
    if (!window.confirm(t("mgmtDeleteTitle"))) return;
    setMgmtMsg(null);
    const res = await fetch(`/api/admin/users/${rep.id}`, { method: "DELETE" });
    if (res.ok) {
      setMgmtMsg({ kind: "ok", text: t("mgmtActionOk") });
      startTx(() => router.refresh());
    } else {
      const j = await res.json().catch(() => ({})) as { error?: string };
      if (j.error === "has_commissions") {
        setMgmtMsg({ kind: "error", text: t("mgmtDeleteHasHistory") });
      } else {
        setMgmtMsg({ kind: "error", text: t("mgmtActionFailed") });
      }
    }
  }

  // ── Ledger filters / actions ────────────────────────────────────────────────

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

  // Filters dropdown data (slim version of comerciales).
  const comercialesForFilter: Rep[] = comerciales.map((c) => ({
    id: c.id,
    name: c.name,
    email: c.email,
  }));

  // ── Render ───────────────────────────────────────────────────────────────────
  return (
    <div>
      {/* ── Comerciales management section ────────────────────────────────── */}
      <div className="rounded-2xl border border-op-border bg-op-surface p-4 mb-6">
        <div className="flex items-center justify-between mb-3">
          <div className="font-mono text-[10px] tracking-wider uppercase text-op-muted">
            {t("mgmtTitle")}
          </div>
          <button
            type="button"
            onClick={() => { setShowNewRep((v) => !v); setRepErr(null); setRepOk(false); }}
            className="h-7 px-3 rounded-full bg-ink text-bone text-[11px] font-medium"
          >
            {showNewRep ? t("newRepClose") : t("newRepCreate")}
          </button>
        </div>

        {/* Feedback messages */}
        {repOk && <div className="text-sm text-ok mb-2">{t("newRepOk")}</div>}
        {mgmtMsg && (
          <div className={`text-sm mb-2 ${mgmtMsg.kind === "ok" ? "text-ok" : "text-danger"}`}>
            {mgmtMsg.text}
          </div>
        )}

        {/* New comercial form */}
        {showNewRep && (
          <div className="pt-3 border-t border-op-border space-y-3 mb-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <RepField label={t("newRepFieldEmail")} value={repEmail} onChange={setRepEmail} type="email" />
              <RepField label={t("newRepFieldName")} value={repName} onChange={setRepName} />
              <RepField label={t("newRepFieldPassword")} value={repPassword} onChange={setRepPassword} type="password" />
              <RepField label={t("newRepFieldBps")} value={repBps} onChange={setRepBps} type="number" />
            </div>
            {repErr && <div className="text-danger text-sm">{repErr}</div>}
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={createComercial}
                disabled={repBusy || !repEmail.trim() || repPassword.length < 8}
                className="h-10 px-5 rounded-full bg-ink text-bone text-sm font-medium disabled:opacity-50"
              >
                {repBusy ? t("newRepSaving") : t("newRepSave")}
              </button>
            </div>
          </div>
        )}

        {/* Edit form (inline, shown below table when editing) */}
        {editingRep && (
          <div className="pt-3 border-t border-op-border space-y-3 mb-4">
            <div className="font-mono text-[10px] tracking-wider uppercase text-op-muted">
              {t("mgmtEditTitle")} — {editingRep.email}
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <RepField label={t("mgmtEditFieldName")} value={editName} onChange={setEditName} />
              <RepField label={t("mgmtEditFieldEmail")} value={editEmail} onChange={setEditEmail} type="email" />
              <RepField label={t("mgmtEditFieldBps")} value={editBps} onChange={setEditBps} type="number" />
              <RepField label={t("mgmtEditFieldPassword")} value={editPassword} onChange={setEditPassword} type="password" />
            </div>
            {editErr && <div className="text-danger text-sm">{editErr}</div>}
            {editOk && <div className="text-ok text-sm">{t("mgmtEditOk")}</div>}
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={saveEdit}
                disabled={editBusy}
                className="h-9 px-4 rounded-full bg-ink text-bone text-sm font-medium disabled:opacity-50"
              >
                {editBusy ? t("mgmtEditSaving") : t("mgmtEditSave")}
              </button>
              <button
                type="button"
                onClick={closeEdit}
                className="h-9 px-4 rounded-full border border-op-border bg-op-bg text-sm font-medium"
              >
                {t("mgmtEditCancel")}
              </button>
            </div>
          </div>
        )}

        {/* Comerciales table */}
        {comerciales.length === 0 ? (
          <div className="text-sm text-op-muted">{t("mgmtEmpty")}</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-op-border">
                  <Th>{t("mgmtColName")}</Th>
                  <Th>{t("mgmtColBps")}</Th>
                  <Th>{t("mgmtColRestaurants")}</Th>
                  <Th>{t("mgmtColPending")}</Th>
                  <Th>{t("mgmtColStatus")}</Th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody className="divide-y divide-op-border">
                {comerciales.map((rep) => (
                  <tr key={rep.id} className={rep.disabledAt ? "opacity-60" : ""}>
                    <Td>
                      <div className="font-medium">{rep.name ?? "—"}</div>
                      <div className="font-mono text-[10px] text-op-muted">{rep.email}</div>
                    </Td>
                    <Td className="font-mono text-[11px]">
                      {rep.commissionBps !== null
                        ? `${(rep.commissionBps / 100).toFixed(2)}%`
                        : <span className="text-op-muted">{t("mgmtBpsGlobal")}</span>}
                    </Td>
                    <Td className="font-mono tabular">{rep.restaurantCount}</Td>
                    <Td className="font-mono tabular">
                      {rep.pendingCents > 0 ? fmtCOP(rep.pendingCents) : "—"}
                    </Td>
                    <Td>
                      <StatusBadge disabled={rep.disabledAt !== null} t={t} />
                    </Td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1 justify-end flex-wrap">
                        <ActionBtn onClick={() => openEdit(rep)}>
                          {t("mgmtEdit")}
                        </ActionBtn>
                        <ActionBtn onClick={() => toggleDisabled(rep)}>
                          {rep.disabledAt ? t("mgmtEnable") : t("mgmtDisable")}
                        </ActionBtn>
                        <ActionBtn
                          onClick={() => deleteRep(rep)}
                          disabled={rep.pendingCents > 0}
                          variant="danger"
                        >
                          {t("mgmtDelete")}
                        </ActionBtn>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ── Filters ───────────────────────────────────────────────────────── */}
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
            {comercialesForFilter.map((rep) => (
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

      {/* ── Ledger table ──────────────────────────────────────────────────── */}
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

// ── Sub-components ────────────────────────────────────────────────────────────

function RepField({
  label,
  value,
  onChange,
  type,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
}) {
  return (
    <label className="block">
      <span className="font-mono text-[10px] tracking-wider uppercase text-op-muted">
        {label}
      </span>
      <input
        type={type ?? "text"}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="mt-1 w-full h-10 px-3 rounded-lg border border-op-border bg-op-bg text-sm focus:outline-none focus:border-terracotta"
      />
    </label>
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

function ActionBtn({
  children,
  onClick,
  disabled,
  variant,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  variant?: "danger";
}) {
  const base = "h-7 px-3 rounded-full text-[11px] font-medium border transition-opacity";
  const cls =
    variant === "danger"
      ? `${base} border-danger/50 text-danger bg-danger/5 hover:bg-danger/10 disabled:opacity-30 disabled:cursor-not-allowed`
      : `${base} border-op-border text-op-text bg-op-bg hover:bg-op-surface disabled:opacity-40 disabled:cursor-not-allowed`;
  return (
    <button type="button" onClick={onClick} disabled={disabled} className={cls}>
      {children}
    </button>
  );
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

function StatusBadge({ disabled, t }: { disabled: boolean; t: TFunc }) {
  const cls = disabled
    ? "bg-op-bg text-op-muted border-op-border"
    : "bg-ok/10 text-[#1E5339] border-ok/30";
  return (
    <span
      className={
        "font-mono text-[10px] tracking-wider uppercase px-2 py-0.5 rounded border " +
        cls
      }
    >
      {disabled ? t("mgmtStatusDisabled") : t("mgmtStatusActive")}
    </span>
  );
}

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
