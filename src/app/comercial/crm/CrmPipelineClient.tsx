"use client";

import Link from "next/link";
import { useCallback, useRef, useState, useTransition } from "react";
import { useTranslations, useFormatter } from "next-intl";
import { waLink } from "@/lib/crm/phone";
import { CrmNewLeadSheet } from "./CrmNewLeadSheet";

// ── Types ──────────────────────────────────────────────────────────────────

export type LeadCard = {
  id: string;
  name: string;
  countryCode: string;
  stage: string;
  priority: string;
  lastActivityAt: Date | string | null;
  nextActionAt: Date | string | null;
  createdAt: Date | string;
  city: { id: string; name: string } | null;
  assignedTo: { id: string; name: string | null } | null;
  contacts: { id: string; name: string; phone: string | null; email: string | null }[];
};

type StageCounts = Record<string, number>;

type TeamMember = { id: string; name: string | null; email: string };

const STAGES = [
  "nuevo",
  "contactado",
  "demo_agendada",
  "demo_realizada",
  "propuesta_enviada",
  "negociacion",
  "ganado",
  "perdido",
] as const;

type Stage = (typeof STAGES)[number];

// ── Stage helpers ──────────────────────────────────────────────────────────

function stageColor(stage: string): string {
  const map: Record<string, string> = {
    nuevo: "bg-slate-100 text-slate-700",
    contactado: "bg-blue-100 text-blue-700",
    demo_agendada: "bg-violet-100 text-violet-700",
    demo_realizada: "bg-purple-100 text-purple-700",
    propuesta_enviada: "bg-amber-100 text-amber-700",
    negociacion: "bg-orange-100 text-orange-700",
    ganado: "bg-green-100 text-green-700",
    perdido: "bg-rose-100 text-rose-600",
  };
  return map[stage] ?? "bg-op-bg text-op-muted";
}

function priorityDot(priority: string): string {
  return priority === "a"
    ? "bg-rose-500"
    : priority === "b"
      ? "bg-amber-400"
      : "bg-slate-300";
}

// ── Relative time helper ───────────────────────────────────────────────────

function useRelTime() {
  const fmt = useFormatter();
  return useCallback(
    (date: Date | string | null): string => {
      if (!date) return "";
      const d = typeof date === "string" ? new Date(date) : date;
      return fmt.relativeTime(d, new Date());
    },
    [fmt],
  );
}

// ── Main component ─────────────────────────────────────────────────────────

export function CrmPipelineClient({
  initialLeads,
  nextCursor: initialCursor,
  stageCounts,
  role,
  userId,
  userCountryCode,
  teamMembers,
  showConfigHint,
  configHintText,
  initialAssignedTo,
}: {
  initialLeads: LeadCard[];
  nextCursor: string | undefined;
  stageCounts: StageCounts;
  role: string;
  /** The current user's own ID — used so "Yo" option sends the right id. */
  userId: string;
  userCountryCode: string | null;
  teamMembers: TeamMember[];
  showConfigHint: boolean;
  configHintText: string;
  /** Pre-selected assignedTo value from query param (e.g. from /equipo link). */
  initialAssignedTo?: string;
}) {
  const t = useTranslations("crm");
  const relTime = useRelTime();

  // ── Filters state
  const [activeStage, setActiveStage] = useState<Stage | "all">("all");
  const [q, setQ] = useState("");
  // "" = full visible scope (used for "Todo mi equipo")
  // userId = only current user's leads (used for "Yo")
  // specific member id = only that member's leads
  const [assignedTo, setAssignedTo] = useState<string>(initialAssignedTo ?? "");
  const [leads, setLeads] = useState<LeadCard[]>(initialLeads);
  const [cursor, setCursor] = useState<string | undefined>(initialCursor);
  const [hasMore, setHasMore] = useState(!!initialCursor);
  const [loading, setLoading] = useState(false);
  const [showNewLead, setShowNewLead] = useState(false);

  // Debounce ref for search
  const searchRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [, startTransition] = useTransition();

  // ── Fetch function
  const fetchLeads = useCallback(
    async (opts: {
      stage?: Stage | "all";
      q?: string;
      assignedTo?: string;
      cursor?: string;
      reset?: boolean;
    }) => {
      setLoading(true);
      try {
        const params = new URLSearchParams();
        if (opts.stage && opts.stage !== "all") params.set("stage", opts.stage);
        if (opts.q) params.set("q", opts.q);
        if (opts.assignedTo) params.set("assignedTo", opts.assignedTo);
        if (opts.cursor) params.set("cursor", opts.cursor);

        const res = await fetch(`/api/crm/leads?${params.toString()}`);
        const json = await res.json();
        const newLeads: LeadCard[] = json.leads ?? [];

        startTransition(() => {
          if (opts.reset) {
            setLeads(newLeads);
          } else {
            setLeads((prev) => [...prev, ...newLeads]);
          }
          setCursor(json.nextCursor);
          setHasMore(!!json.nextCursor);
        });
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  // Stage chip click
  function handleStageClick(stage: Stage | "all") {
    setActiveStage(stage);
    fetchLeads({ stage, q, assignedTo, reset: true });
  }

  // Search input
  function handleSearchChange(val: string) {
    setQ(val);
    if (searchRef.current) clearTimeout(searchRef.current);
    searchRef.current = setTimeout(() => {
      fetchLeads({ stage: activeStage, q: val, assignedTo, reset: true });
    }, 350);
  }

  // Assigned-to selector (gerente)
  // selector value "" = "Todo mi equipo" → omit param → full visible scope
  // selector value userId = "Yo" → restrict to own leads
  // selector value = specific member id → restrict to that member
  function handleAssignedToChange(val: string) {
    setAssignedTo(val);
    fetchLeads({ stage: activeStage, q, assignedTo: val, reset: true });
  }

  // Load more
  function handleLoadMore() {
    if (!cursor) return;
    fetchLeads({ stage: activeStage, q, assignedTo, cursor });
  }

  // New lead created callback
  function onLeadCreated() {
    setShowNewLead(false);
    fetchLeads({ stage: activeStage, q, assignedTo, reset: true });
  }

  // ── Stage label map
  const stageLabel: Record<string, string> = {
    nuevo: t("stageNuevo"),
    contactado: t("stageContactado"),
    demo_agendada: t("stageDemoAgendada"),
    demo_realizada: t("stageDemoRealizada"),
    propuesta_enviada: t("stagePropuestaEnviada"),
    negociacion: t("stageNegociacion"),
    ganado: t("stageGanado"),
    perdido: t("stagePerdido"),
  };

  // ── Render ─────────────────────────────────────────────────────────────

  return (
    <div className="flex-1 flex flex-col">
      {/* Config hint */}
      {showConfigHint && (
        <div className="mx-4 mt-4 p-3 rounded-xl bg-amber-50 border border-amber-200 text-sm text-amber-800">
          {configHintText}
        </div>
      )}

      {/* Top bar: title + search */}
      <div className="px-4 pt-4 pb-3 space-y-3">
        <div className="flex items-center justify-between">
          <div className="font-display text-xl">{t("pageTitle")}</div>
        </div>

        {/* Search */}
        <div className="relative">
          <svg
            viewBox="0 0 20 20"
            fill="currentColor"
            className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-op-muted pointer-events-none"
          >
            <path
              fillRule="evenodd"
              d="M8 4a4 4 0 100 8 4 4 0 000-8zM2 8a6 6 0 1110.89 3.476l4.817 4.817a1 1 0 01-1.414 1.414l-4.816-4.816A6 6 0 012 8z"
              clipRule="evenodd"
            />
          </svg>
          <input
            type="search"
            value={q}
            onChange={(e) => handleSearchChange(e.target.value)}
            placeholder={t("searchPlaceholder")}
            className="w-full pl-9 pr-3 py-2 rounded-xl border border-op-border bg-op-bg text-sm focus:outline-none focus:ring-1 focus:ring-terracotta min-h-[44px]"
          />
        </div>

        {/* Gerente: view selector */}
        {(role === "gerente_comercial" || role === "platform_admin") &&
          teamMembers.length > 0 && (
            <select
              value={assignedTo}
              onChange={(e) => handleAssignedToChange(e.target.value)}
              className="w-full px-3 py-2 rounded-xl border border-op-border bg-op-bg text-sm focus:outline-none min-h-[44px]"
            >
              {/* "" = omit assignedTo param → server returns full visible scope */}
              <option value={""}>{t("viewSelectorTeam")}</option>
              {/* Own id → restrict to current user's leads only */}
              <option value={userId}>{t("viewSelectorMe")}</option>
              {teamMembers.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name ?? m.email}
                </option>
              ))}
            </select>
          )}
      </div>

      {/* Stage chips — horizontal scroll */}
      <div className="overflow-x-auto scrollbar-none px-4 pb-3">
        <div className="flex gap-2 min-w-max">
          <StageChip
            label={t("stageAll")}
            count={stageCounts.total ?? 0}
            active={activeStage === "all"}
            onClick={() => handleStageClick("all")}
          />
          {STAGES.map((s) => (
            <StageChip
              key={s}
              label={stageLabel[s] ?? s}
              count={stageCounts[s] ?? 0}
              active={activeStage === s}
              onClick={() => handleStageClick(s)}
            />
          ))}
        </div>
      </div>

      {/* MOBILE: List view (<lg) */}
      <div className="lg:hidden flex-1 px-4 pb-4 space-y-3">
        {leads.length === 0 && !loading ? (
          <p className="text-sm text-op-muted py-6 text-center">
            {t("emptyLeads")}
          </p>
        ) : (
          leads.map((lead) => (
            <LeadListCard
              key={lead.id}
              lead={lead}
              relTime={relTime}
              stageLabel={stageLabel}
              t={t}
            />
          ))
        )}

        {loading && (
          <div className="flex justify-center py-4">
            <Spinner />
          </div>
        )}

        {hasMore && !loading && (
          <button
            onClick={handleLoadMore}
            className="w-full py-3 text-sm text-op-muted hover:text-op-text border border-op-border rounded-xl min-h-[44px]"
          >
            {t("loadMore")}
          </button>
        )}
      </div>

      {/* DESKTOP: Kanban view (lg+) */}
      <div className="hidden lg:flex flex-1 overflow-x-auto px-4 pb-4 gap-3 items-start">
        {STAGES.map((s) => {
          const colLeads = leads.filter((l) => l.stage === s);
          const count = stageCounts[s] ?? 0;
          return (
            <KanbanColumn
              key={s}
              stage={s}
              label={stageLabel[s] ?? s}
              leads={colLeads}
              relTime={relTime}
              t={t}
              kanbanColumnHeader={t("kanbanColumnHeader", { count })}
            />
          );
        })}
      </div>

      {/* FAB */}
      <button
        onClick={() => setShowNewLead(true)}
        aria-label={t("newLeadTitle")}
        className="fixed bottom-[calc(env(safe-area-inset-bottom,0px)+4.5rem)] right-4 lg:bottom-6 z-30 w-14 h-14 rounded-full bg-terracotta text-white shadow-lg flex items-center justify-center hover:opacity-90 active:scale-95 transition-all"
      >
        <svg viewBox="0 0 20 20" fill="currentColor" className="w-6 h-6">
          <path
            fillRule="evenodd"
            d="M10 3a1 1 0 011 1v5h5a1 1 0 110 2h-5v5a1 1 0 11-2 0v-5H4a1 1 0 110-2h5V4a1 1 0 011-1z"
            clipRule="evenodd"
          />
        </svg>
      </button>

      {/* New Lead bottom sheet */}
      {showNewLead && (
        <CrmNewLeadSheet
          userCountryCode={userCountryCode}
          onClose={() => setShowNewLead(false)}
          onCreated={onLeadCreated}
        />
      )}
    </div>
  );
}

// ── Sub-components ─────────────────────────────────────────────────────────

function StageChip({
  label,
  count,
  active,
  onClick,
}: {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={
        "flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium border transition-colors min-h-[36px] whitespace-nowrap " +
        (active
          ? "bg-terracotta text-white border-terracotta"
          : "bg-op-surface text-op-muted border-op-border hover:border-terracotta hover:text-op-text")
      }
    >
      {label}
      <span
        className={
          "font-mono tabular-nums " + (active ? "opacity-80" : "text-op-muted")
        }
      >
        {count}
      </span>
    </button>
  );
}

function LeadListCard({
  lead,
  relTime,
  stageLabel,
  t,
}: {
  lead: LeadCard;
  relTime: (d: Date | string | null) => string;
  stageLabel: Record<string, string>;
  t: (key: string) => string;
}) {
  const primaryContact = lead.contacts[0] ?? null;

  function handleWhatsApp(e: React.MouseEvent) {
    e.preventDefault();
    if (!primaryContact?.phone) return;
    // Fire-and-forget: record activity
    fetch(`/api/crm/leads/${lead.id}/activities`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "whatsapp", content: "WhatsApp tap" }),
    }).catch(() => {});
    window.open(waLink(primaryContact.phone), "_blank", "noopener,noreferrer");
  }

  return (
    <div className="rounded-2xl border border-op-border bg-op-surface p-4 space-y-3">
      {/* Header: name + priority dot + stage */}
      <div className="flex items-start justify-between gap-2">
        <Link
          href={`/comercial/crm/${lead.id}`}
          className="font-medium text-sm flex-1 min-w-0 hover:text-terracotta"
        >
          <span className="flex items-center gap-1.5">
            <span
              className={"w-2 h-2 rounded-full shrink-0 mt-0.5 " + priorityDot(lead.priority)}
              aria-hidden
            />
            <span className="truncate">{lead.name}</span>
          </span>
        </Link>
        <span
          className={
            "font-mono text-[10px] tracking-wide uppercase px-1.5 py-0.5 rounded shrink-0 " +
            stageColor(lead.stage)
          }
        >
          {stageLabel[lead.stage] ?? lead.stage}
        </span>
      </div>

      {/* City + last activity time */}
      <div className="flex items-center justify-between text-xs text-op-muted">
        {lead.city ? (
          <span>{lead.city.name}</span>
        ) : (
          <span>{lead.countryCode}</span>
        )}
        <span>
          {lead.lastActivityAt
            ? relTime(lead.lastActivityAt)
            : t("lastActivityNever")}
        </span>
      </div>

      {/* Action buttons */}
      {primaryContact && (
        <div className="flex gap-2">
          {primaryContact.phone && (
            <button
              onClick={handleWhatsApp}
              className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-[#25D366]/10 text-[#128C7E] text-xs font-medium min-h-[44px] min-w-[44px] hover:bg-[#25D366]/20 transition-colors"
            >
              <svg viewBox="0 0 24 24" fill="currentColor" className="w-4 h-4">
                <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413Z" />
              </svg>
              {t("whatsappLabel")}
            </button>
          )}
          {primaryContact.phone && (
            <a
              href={`tel:${primaryContact.phone}`}
              className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-op-bg border border-op-border text-xs font-medium min-h-[44px] min-w-[44px] hover:bg-op-surface transition-colors"
            >
              <svg viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
                <path d="M2 3a1 1 0 011-1h2.153a1 1 0 01.986.836l.74 4.435a1 1 0 01-.54 1.06l-1.548.773a11.037 11.037 0 006.105 6.105l.774-1.548a1 1 0 011.059-.54l4.435.74a1 1 0 01.836.986V17a1 1 0 01-1 1h-2C7.82 18 2 12.18 2 5V3z" />
              </svg>
              {t("callLabel")}
            </a>
          )}
        </div>
      )}
    </div>
  );
}

function KanbanColumn({
  stage,
  label,
  leads,
  relTime,
  t,
  kanbanColumnHeader,
}: {
  stage: string;
  label: string;
  leads: LeadCard[];
  relTime: (d: Date | string | null) => string;
  t: (key: string) => string;
  kanbanColumnHeader: string;
}) {
  return (
    <div className="w-64 shrink-0 flex flex-col gap-2">
      {/* Column header */}
      <div
        className={
          "flex items-center justify-between px-3 py-2 rounded-xl " +
          stageColor(stage)
        }
      >
        <span className="text-xs font-semibold uppercase tracking-wide">
          {label}
        </span>
        <span className="font-mono text-xs">{kanbanColumnHeader}</span>
      </div>

      {/* Cards */}
      {leads.length === 0 ? (
        <div className="text-xs text-op-muted text-center py-4">{t("emptyLeads")}</div>
      ) : (
        leads.map((lead) => (
          <div
            key={lead.id}
            className="rounded-xl border border-op-border bg-op-surface p-3 space-y-2"
          >
            <Link
              href={`/comercial/crm/${lead.id}`}
              className="font-medium text-sm hover:text-terracotta flex items-center gap-1.5"
            >
              <span
                className={"w-2 h-2 rounded-full shrink-0 " + priorityDot(lead.priority)}
                aria-hidden
              />
              <span className="truncate">{lead.name}</span>
            </Link>
            {lead.city && (
              <div className="text-xs text-op-muted">{lead.city.name}</div>
            )}
            <div className="text-xs text-op-muted">
              {lead.lastActivityAt
                ? relTime(lead.lastActivityAt)
                : t("lastActivityNever")}
            </div>
            {lead.contacts[0]?.phone && (
              <div className="flex gap-1.5">
                <KanbanWaButton
                  leadId={lead.id}
                  phone={lead.contacts[0].phone}
                  label={t("whatsappLabel")}
                />
                <a
                  href={`tel:${lead.contacts[0].phone}`}
                  className="px-2 py-1.5 rounded-lg bg-op-bg border border-op-border text-xs min-h-[44px] flex items-center"
                >
                  {t("callLabel")}
                </a>
              </div>
            )}
          </div>
        ))
      )}
    </div>
  );
}

function KanbanWaButton({
  leadId,
  phone,
  label,
}: {
  leadId: string;
  phone: string;
  label: string;
}) {
  function handleClick() {
    fetch(`/api/crm/leads/${leadId}/activities`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "whatsapp", content: "WhatsApp tap" }),
    }).catch(() => {});
    window.open(waLink(phone), "_blank", "noopener,noreferrer");
  }

  return (
    <button
      onClick={handleClick}
      className="px-2 py-1.5 rounded-lg bg-[#25D366]/10 text-[#128C7E] text-xs min-h-[44px] flex items-center gap-1"
    >
      {label}
    </button>
  );
}

function Spinner() {
  return (
    <svg
      className="w-5 h-5 animate-spin text-op-muted"
      fill="none"
      viewBox="0 0 24 24"
    >
      <circle
        className="opacity-25"
        cx="12"
        cy="12"
        r="10"
        stroke="currentColor"
        strokeWidth="4"
      />
      <path
        className="opacity-75"
        fill="currentColor"
        d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"
      />
    </svg>
  );
}
