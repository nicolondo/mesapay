"use client";

import Link from "next/link";
import { useEffect, useState, useTransition } from "react";
import { useTranslations } from "next-intl";

// ── Types ──────────────────────────────────────────────────────────────────

type MemberMetrics = {
  memberId: string;
  leadsNuevos: number;
  contactados: number;
  demos: number;
  ganados: number;
  tasaConversion: number;
  tiempoPrimeraRespuestaHrs: number | null;
};

type Member = {
  id: string;
  name: string | null;
  email: string;
  countryCode: string | null;
  commissionBps: number | null;
  disabled: boolean;
  role: string;
  createdAt: string;
  leadCount: number;
  metrics?: MemberMetrics;
};

const PHONE_PREFIXES_COUNTRIES = [
  { code: "CO", name: "Colombia" },
  { code: "MX", name: "México" },
];

// ── Sheet primitives ───────────────────────────────────────────────────────

function Overlay({ onClose, children }: { onClose: () => void; children: React.ReactNode }) {
  useEffect(() => {
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = ""; };
  }, []);
  return (
    <div className="fixed inset-0 z-50 flex flex-col justify-end" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={onClose} aria-hidden="true" />
      {children}
    </div>
  );
}

function SheetContent({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="relative z-10 bg-op-surface rounded-t-2xl max-h-[90dvh] flex flex-col shadow-xl"
      style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
    >
      {children}
    </div>
  );
}

function SheetHandle() {
  return (
    <div className="flex justify-center pt-3 pb-1 shrink-0">
      <div className="w-10 h-1 rounded-full bg-op-border" />
    </div>
  );
}

function SheetHeader({ title, onClose }: { title: string; onClose: () => void }) {
  return (
    <div className="flex items-center justify-between px-4 py-3 border-b border-op-border shrink-0">
      <div className="font-display text-xl">{title}</div>
      <button
        onClick={onClose}
        className="p-2 rounded-lg text-op-muted hover:text-op-text min-h-[44px] min-w-[44px] flex items-center justify-center"
      >
        <svg viewBox="0 0 20 20" fill="currentColor" className="w-5 h-5">
          <path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd" />
        </svg>
      </button>
    </div>
  );
}

function FieldLabel({ children, required }: { children: React.ReactNode; required?: boolean }) {
  return (
    <label className="block font-mono text-[10px] tracking-wider uppercase text-op-muted mb-1">
      {children}
      {required && <span className="text-terracotta ml-0.5">{"*"}</span>}
    </label>
  );
}

function Spinner() {
  return (
    <svg className="w-4 h-4 animate-spin text-op-muted" fill="none" viewBox="0 0 24 24">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
    </svg>
  );
}

// ── Metrics card ──────────────────────────────────────────────────────────

function MetricsCard({ metrics }: { metrics: MemberMetrics }) {
  const t = useTranslations("crm");
  const hasData = metrics.leadsNuevos > 0 || metrics.contactados > 0 || metrics.demos > 0 || metrics.ganados > 0;
  if (!hasData) {
    return (
      <div className="rounded-xl bg-op-bg border border-op-border px-3 py-2 text-xs text-op-muted">
        {t("metricsNoData")}
      </div>
    );
  }
  const pct = (metrics.tasaConversion * 100).toFixed(0);
  const stats = [
    { label: t("metricsLeadsNuevos"), value: String(metrics.leadsNuevos) },
    { label: t("metricsContactados"), value: String(metrics.contactados) },
    { label: t("metricsDemos"), value: String(metrics.demos) },
    { label: t("metricsGanados"), value: String(metrics.ganados) },
    { label: t("metricsTasa"), value: `${pct}%` },
    ...(metrics.tiempoPrimeraRespuestaHrs !== null
      ? [{ label: t("metricsRespuesta"), value: t("metricsRespuestaHrs", { hrs: metrics.tiempoPrimeraRespuestaHrs.toFixed(1) }) }]
      : []),
  ];
  return (
    <div className="rounded-xl bg-op-bg border border-op-border overflow-hidden">
      <div className="px-3 py-1.5 border-b border-op-border">
        <span className="font-mono text-[9px] tracking-wider uppercase text-op-muted">{t("metricsTitle")}</span>
      </div>
      <div className="grid grid-cols-3 divide-x divide-op-border">
        {stats.map(({ label, value }) => (
          <div key={label} className="px-2 py-2 text-center">
            <div className="font-display text-lg leading-tight">{value}</div>
            <div className="font-mono text-[9px] tracking-wide uppercase text-op-muted mt-0.5 leading-tight">{label}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Create member sheet ────────────────────────────────────────────────────

function CreateSheet({
  onCreated,
  onClose,
}: {
  onCreated: (members: Member[]) => void;
  onClose: () => void;
}) {
  const t = useTranslations("crm");
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [countryCode, setCountryCode] = useState("");
  const [commissionBps, setCommissionBps] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/crm/team", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: email.toLowerCase().trim(),
          name: name.trim(),
          password,
          countryCode: countryCode || undefined,
          commissionBps: commissionBps ? parseInt(commissionBps, 10) : undefined,
        }),
      });
      const json = await res.json();
      if (res.status === 409) { setError(t("emailTaken")); setSaving(false); return; }
      if (!res.ok) { setError(json.error ?? "error"); setSaving(false); return; }

      // Refresh list.
      const fresh = await fetch("/api/crm/team");
      if (fresh.ok) {
        const fd = await fresh.json();
        onCreated(
          (fd.members ?? []).map((m: Member & { disabledAt?: string | null }) => ({
            ...m,
            disabled: m.disabled ?? m.disabledAt != null,
          })),
        );
      } else {
        onClose();
      }
    } catch {
      setError("network_error");
      setSaving(false);
    }
  }

  return (
    <Overlay onClose={onClose}>
      <SheetContent>
        <SheetHandle />
        <SheetHeader title={t("createMemberTitle")} onClose={onClose} />
        <form onSubmit={handleSubmit} className="overflow-y-auto flex-1 px-4 py-4 space-y-4">
          <div>
            <FieldLabel required>{"Email"}</FieldLabel>
            <input
              type="email" required value={email} onChange={(e) => setEmail(e.target.value)}
              className="w-full px-3 py-2.5 rounded-xl border border-op-border bg-op-bg text-sm focus:outline-none focus:ring-1 focus:ring-terracotta min-h-[44px]"
            />
          </div>
          <div>
            <FieldLabel required>{t("fieldMemberName")}</FieldLabel>
            <input
              type="text" required value={name} onChange={(e) => setName(e.target.value)}
              className="w-full px-3 py-2.5 rounded-xl border border-op-border bg-op-bg text-sm focus:outline-none focus:ring-1 focus:ring-terracotta min-h-[44px]"
            />
          </div>
          <div>
            <FieldLabel required>{t("fieldPassword")}</FieldLabel>
            <input
              type="password" required minLength={8} value={password} onChange={(e) => setPassword(e.target.value)}
              className="w-full px-3 py-2.5 rounded-xl border border-op-border bg-op-bg text-sm focus:outline-none focus:ring-1 focus:ring-terracotta min-h-[44px]"
            />
          </div>
          <div>
            <FieldLabel>{t("fieldCountry")}</FieldLabel>
            <select
              value={countryCode} onChange={(e) => setCountryCode(e.target.value)}
              className="w-full px-3 py-2.5 rounded-xl border border-op-border bg-op-bg text-sm focus:outline-none focus:ring-1 focus:ring-terracotta min-h-[44px]"
            >
              <option value="">{"—"}</option>
              {PHONE_PREFIXES_COUNTRIES.map((c) => (
                <option key={c.code} value={c.code}>{c.name}</option>
              ))}
            </select>
          </div>
          <div>
            <FieldLabel>{t("fieldCommissionBps")}</FieldLabel>
            <div className="flex items-center gap-2">
              <input
                type="number" min="0" max="5000" value={commissionBps} onChange={(e) => setCommissionBps(e.target.value)}
                className="w-full px-3 py-2.5 rounded-xl border border-op-border bg-op-bg text-sm focus:outline-none focus:ring-1 focus:ring-terracotta min-h-[44px]"
              />
              <span className="text-sm text-op-muted whitespace-nowrap">{"bps"}</span>
            </div>
            {commissionBps && (
              <p className="text-xs text-op-muted mt-1">
                {(parseInt(commissionBps, 10) / 100).toFixed(2)}{"% por transacción"}
              </p>
            )}
          </div>
          {error && <p className="text-sm text-terracotta">{error}</p>}
          <button
            type="submit" disabled={saving || !email.trim() || !name.trim() || password.length < 8}
            className="w-full py-3.5 rounded-xl bg-terracotta text-white font-medium disabled:opacity-50 min-h-[44px]"
          >
            {saving ? <span className="flex justify-center"><Spinner /></span> : t("createMemberSubmit")}
          </button>
        </form>
      </SheetContent>
    </Overlay>
  );
}

// ── Edit member sheet ──────────────────────────────────────────────────────

function EditSheet({
  member,
  onSaved,
  onClose,
}: {
  member: Member;
  onSaved: (updated: Partial<Member>) => void;
  onClose: () => void;
}) {
  const t = useTranslations("crm");
  const [name, setName] = useState(member.name ?? "");
  const [countryCode, setCountryCode] = useState(member.countryCode ?? "");
  const [commissionBps, setCommissionBps] = useState(String(member.commissionBps ?? ""));
  const [disabled, setDisabled] = useState(member.disabled);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/crm/team/${member.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: name.trim() || undefined,
          countryCode: countryCode || null,
          commissionBps: commissionBps !== "" ? parseInt(commissionBps, 10) : null,
          disabled,
        }),
      });
      const json = await res.json();
      if (!res.ok) { setError(json.error ?? "error"); setSaving(false); return; }

      onSaved({
        name: name.trim() || member.name,
        countryCode: countryCode || null,
        commissionBps: commissionBps !== "" ? parseInt(commissionBps, 10) : null,
        disabled,
      });
    } catch {
      setError("network_error");
      setSaving(false);
    }
  }

  return (
    <Overlay onClose={onClose}>
      <SheetContent>
        <SheetHandle />
        <SheetHeader title={t("editMemberTitle")} onClose={onClose} />
        <form onSubmit={handleSubmit} className="overflow-y-auto flex-1 px-4 py-4 space-y-4">
          <div>
            <FieldLabel>{t("fieldMemberName")}</FieldLabel>
            <input
              type="text" value={name} onChange={(e) => setName(e.target.value)}
              className="w-full px-3 py-2.5 rounded-xl border border-op-border bg-op-bg text-sm focus:outline-none focus:ring-1 focus:ring-terracotta min-h-[44px]"
            />
          </div>
          <div>
            <FieldLabel>{t("fieldCountry")}</FieldLabel>
            <select
              value={countryCode} onChange={(e) => setCountryCode(e.target.value)}
              className="w-full px-3 py-2.5 rounded-xl border border-op-border bg-op-bg text-sm focus:outline-none focus:ring-1 focus:ring-terracotta min-h-[44px]"
            >
              <option value="">{"—"}</option>
              {PHONE_PREFIXES_COUNTRIES.map((c) => (
                <option key={c.code} value={c.code}>{c.name}</option>
              ))}
            </select>
          </div>
          <div>
            <FieldLabel>{t("fieldCommissionBps")}</FieldLabel>
            <input
              type="number" min="0" max="5000" value={commissionBps} onChange={(e) => setCommissionBps(e.target.value)}
              className="w-full px-3 py-2.5 rounded-xl border border-op-border bg-op-bg text-sm focus:outline-none focus:ring-1 focus:ring-terracotta min-h-[44px]"
            />
          </div>
          <label className="flex items-center gap-3 cursor-pointer min-h-[44px]">
            <input
              type="checkbox" checked={disabled} onChange={(e) => setDisabled(e.target.checked)}
              className="w-4 h-4 rounded"
            />
            <span className="text-sm">{t("memberDisableLabel")}</span>
          </label>
          {error && <p className="text-sm text-terracotta">{error}</p>}
          <button
            type="submit" disabled={saving}
            className="w-full py-3.5 rounded-xl bg-terracotta text-white font-medium disabled:opacity-50 min-h-[44px]"
          >
            {saving ? <span className="flex justify-center"><Spinner /></span> : t("saveChanges")}
          </button>
        </form>
      </SheetContent>
    </Overlay>
  );
}

// ── Main component ─────────────────────────────────────────────────────────

export function CrmTeamClient({
  initialMembers,
  role,
  pageTitle,
}: {
  initialMembers: Member[];
  role: string;
  pageTitle: string;
}) {
  const t = useTranslations("crm");
  const [, startTransition] = useTransition();

  const [members, setMembers] = useState<Member[]>(initialMembers);
  const [sheet, setSheet] = useState<"create" | "edit" | null>(null);
  const [editingMember, setEditingMember] = useState<Member | null>(null);

  // Suppress unused variable warning if role is not yet used for conditional UI
  void role;

  return (
    <div className="flex-1 flex flex-col">
      {/* Header */}
      <div className="px-4 pt-4 pb-3 flex items-center justify-between">
        <div>
          <Link
            href="/comercial/mas"
            className="inline-flex items-center gap-1.5 text-xs text-op-muted hover:text-op-text mb-2"
          >
            <svg viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
              <path fillRule="evenodd" d="M9.707 16.707a1 1 0 01-1.414 0l-6-6a1 1 0 010-1.414l6-6a1 1 0 011.414 1.414L5.414 9H17a1 1 0 110 2H5.414l4.293 4.293a1 1 0 010 1.414z" clipRule="evenodd" />
            </svg>
            {t("navMas")}
          </Link>
          <div className="font-display text-2xl">{pageTitle}</div>
        </div>
        <button
          onClick={() => { setEditingMember(null); setSheet("create"); }}
          className="flex items-center gap-1.5 px-4 py-2.5 rounded-xl bg-terracotta text-white text-sm font-medium min-h-[44px] hover:opacity-90 transition-opacity"
        >
          <svg viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
            <path fillRule="evenodd" d="M10 3a1 1 0 011 1v5h5a1 1 0 110 2h-5v5a1 1 0 11-2 0v-5H4a1 1 0 110-2h5V4a1 1 0 011-1z" clipRule="evenodd" />
          </svg>
          {t("createMemberBtn")}
        </button>
      </div>

      {/* Member list */}
      <div className="flex-1 px-4 pb-6 space-y-3">
        {members.length === 0 ? (
          <p className="text-sm text-op-muted py-6 text-center">{t("emptyTeam")}</p>
        ) : (
          members.map((m) => (
            <div
              key={m.id}
              className={
                "rounded-2xl border border-op-border bg-op-surface p-4 space-y-3 " +
                (m.disabled ? "opacity-60" : "")
              }
            >
              {/* Info row */}
              <div className="flex items-start justify-between gap-3">
                <div className="flex-1 min-w-0">
                  <div className="font-medium text-sm flex items-center gap-2">
                    {m.name ?? m.email}
                    {m.disabled && (
                      <span className="font-mono text-[9px] tracking-wider uppercase bg-rose-100 text-rose-700 px-1.5 py-0.5 rounded">
                        {t("disabledBadge")}
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-op-muted mt-0.5">{m.email}</div>
                  <div className="flex gap-3 mt-1.5 text-xs text-op-muted flex-wrap">
                    {m.countryCode && <span>{m.countryCode}</span>}
                    {m.commissionBps != null && (
                      <span>{(m.commissionBps / 100).toFixed(2)}{"% com."}</span>
                    )}
                    <span className="flex items-center gap-1">
                      <svg viewBox="0 0 20 20" fill="currentColor" className="w-3 h-3">
                        <path d="M2 11a1 1 0 011-1h2a1 1 0 011 1v5a1 1 0 01-1 1H3a1 1 0 01-1-1v-5zM8 7a1 1 0 011-1h2a1 1 0 011 1v9a1 1 0 01-1 1H9a1 1 0 01-1-1V7zM14 4a1 1 0 011-1h2a1 1 0 011 1v12a1 1 0 01-1 1h-2a1 1 0 01-1-1V4z" />
                      </svg>
                      {m.leadCount} {t("leadsCountLabel")}
                    </span>
                  </div>
                </div>
                <button
                  onClick={() => { setEditingMember(m); setSheet("edit"); }}
                  className="text-xs text-op-muted hover:text-op-text min-h-[44px] px-2 flex items-center shrink-0"
                >
                  {t("editBtn")}
                </button>
              </div>

              {/* Metrics */}
              {m.metrics && <MetricsCard metrics={m.metrics} />}

              {/* Link to their pipeline */}
              <Link
                href={`/comercial/crm?assignedTo=${m.id}`}
                className="flex items-center gap-1.5 text-xs text-terracotta hover:underline min-h-[36px]"
              >
                <svg viewBox="0 0 20 20" fill="currentColor" className="w-3.5 h-3.5">
                  <path d="M2 11a1 1 0 011-1h2a1 1 0 011 1v5a1 1 0 01-1 1H3a1 1 0 01-1-1v-5zM8 7a1 1 0 011-1h2a1 1 0 011 1v9a1 1 0 01-1 1H9a1 1 0 01-1-1V7zM14 4a1 1 0 011-1h2a1 1 0 011 1v12a1 1 0 01-1 1h-2a1 1 0 01-1-1V4z" />
                </svg>
                {t("viewPipelineLink")}
              </Link>
            </div>
          ))
        )}
      </div>

      {/* Sheets */}
      {sheet === "create" && (
        <CreateSheet
          onClose={() => setSheet(null)}
          onCreated={(newMembers) => {
            startTransition(() => {
              setMembers(newMembers);
              setSheet(null);
            });
          }}
        />
      )}
      {sheet === "edit" && editingMember && (
        <EditSheet
          member={editingMember}
          onClose={() => { setSheet(null); setEditingMember(null); }}
          onSaved={(updated) => {
            startTransition(() => {
              setMembers((prev) =>
                prev.map((mem) =>
                  mem.id === editingMember.id ? { ...mem, ...updated } : mem,
                ),
              );
              setSheet(null);
              setEditingMember(null);
            });
          }}
        />
      )}
    </div>
  );
}
