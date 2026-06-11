"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { useTranslations, useFormatter } from "next-intl";
import { openWhatsApp } from "@/lib/crm/openWhatsApp";
import { applyDrop, applyDropCounts } from "@/lib/crm/kanbanDnd";
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
  unitsCount: number | null;
  unitNames: string[];
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

const LOST_REASONS = [
  "Precio",
  "No ve valor",
  "Ya tiene proveedor",
  "Cerró",
  "Quedó frío",
  "Otro",
] as const;

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

// ── Sheet primitives (needed for DnD sheets) ───────────────────────────────

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
      className="relative z-10 bg-op-surface rounded-t-2xl max-h-[90dvh] flex flex-col shadow-xl overflow-y-auto"
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
      <button onClick={onClose} className="p-2 rounded-lg text-op-muted hover:text-op-text min-h-[44px] min-w-[44px] flex items-center justify-center">
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

// ── DndConvertSheet ────────────────────────────────────────────────────────

function DndConvertSheet({
  lead,
  role,
  onConverted,
  onClose,
}: {
  lead: LeadCard;
  role: string;
  onConverted: (restaurantId: string) => void;
  onClose: () => void;
}) {
  const t = useTranslations("crm");

  function suggestSlug(name: string) {
    return name
      .toLowerCase()
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 40);
  }

  const [name, setName] = useState(lead.name);
  const [slug, setSlug] = useState(() => suggestSlug(lead.name));
  const [plan, setPlan] = useState<"trial" | "basic" | "pro">("trial");
  const [monthlyPrice, setMonthlyPrice] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<{ restaurantId: string } | null>(null);

  function handleNameChange(v: string) {
    setName(v);
    setSlug(suggestSlug(v));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/crm/leads/${lead.id}/convert`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          slug: slug.trim(),
          plan,
          monthlyPriceCents: monthlyPrice ? parseInt(monthlyPrice, 10) : 0,
        }),
      });
      const json = await res.json();
      if (res.status === 409) {
        setError(t("convertAlreadyConverted"));
        setSaving(false);
        return;
      }
      if (!res.ok) {
        setError(t("convertError", { detail: json.error ?? "error" }));
        setSaving(false);
        return;
      }
      setSuccess({ restaurantId: json.restaurantId });
      onConverted(json.restaurantId);
    } catch {
      setError(t("convertError", { detail: "network error" }));
      setSaving(false);
    }
  }

  const PLANS = [
    { value: "trial" as const, label: t("convertPlanTrial") },
    { value: "basic" as const, label: t("convertPlanBasic") },
    { value: "pro" as const, label: t("convertPlanPro") },
  ];

  return (
    <Overlay onClose={onClose}>
      <SheetContent>
        <SheetHandle />
        <SheetHeader title={t("dndConvertTitle")} onClose={onClose} />
        {success ? (
          <div className="px-4 py-6 space-y-4">
            <p className="text-sm text-green-600 font-medium">{t("dndConvertSuccess")}</p>
            {role === "platform_admin" && (
              <a
                href={`/admin/restaurants/${success.restaurantId}`}
                className="block w-full py-3.5 rounded-xl bg-terracotta text-white text-sm font-medium text-center min-h-[44px]"
              >
                {t("convertViewAdmin")}
              </a>
            )}
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="overflow-y-auto flex-1 px-4 py-4 space-y-4">
            <div>
              <FieldLabel required>{t("convertFieldName")}</FieldLabel>
              <input
                type="text" required value={name} onChange={(e) => handleNameChange(e.target.value)}
                className="w-full px-3 py-2.5 rounded-xl border border-op-border bg-op-bg text-sm focus:outline-none focus:ring-1 focus:ring-terracotta min-h-[44px]"
              />
            </div>
            <div>
              <FieldLabel required>{t("convertFieldSlug")}</FieldLabel>
              <input
                type="text" required value={slug} onChange={(e) => setSlug(e.target.value)}
                className="w-full px-3 py-2.5 rounded-xl border border-op-border bg-op-bg text-sm font-mono focus:outline-none focus:ring-1 focus:ring-terracotta min-h-[44px]"
              />
              <p className="text-xs text-op-muted mt-1">{"app.mesapay.co/t/" + (slug || "…")}</p>
            </div>
            <div>
              <FieldLabel required>{t("convertFieldPlan")}</FieldLabel>
              <div className="flex gap-2">
                {PLANS.map(({ value, label }) => (
                  <button
                    key={value}
                    type="button"
                    onClick={() => setPlan(value)}
                    className={
                      "flex-1 py-2.5 rounded-xl border-2 text-sm font-medium min-h-[44px] transition-all " +
                      (plan === value
                        ? "border-terracotta bg-terracotta/5 text-terracotta"
                        : "border-op-border text-op-muted hover:border-op-text")
                    }
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <FieldLabel>{t("convertFieldMonthly")}</FieldLabel>
              <input
                type="number" min="0" value={monthlyPrice}
                onChange={(e) => setMonthlyPrice(e.target.value)}
                className="w-full px-3 py-2.5 rounded-xl border border-op-border bg-op-bg text-sm focus:outline-none focus:ring-1 focus:ring-terracotta min-h-[44px]"
              />
            </div>
            {error && <p className="text-sm text-terracotta">{error}</p>}
            <button
              type="submit"
              disabled={saving || !name.trim() || !slug.trim()}
              className="w-full py-3.5 rounded-xl bg-terracotta text-white font-medium disabled:opacity-50 min-h-[44px]"
            >
              {saving ? <span className="flex justify-center"><Spinner /></span> : t("convertSubmit")}
            </button>
          </form>
        )}
      </SheetContent>
    </Overlay>
  );
}

// ── DndLostReasonSheet ─────────────────────────────────────────────────────

function DndLostReasonSheet({
  lead,
  onConfirmed,
  onClose,
}: {
  lead: LeadCard;
  onConfirmed: (lostReason: string) => void;
  onClose: () => void;
}) {
  const t = useTranslations("crm");
  const [lostReason, setLostReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleConfirm() {
    if (!lostReason) { setError(t("lostReasonRequired")); return; }
    setSaving(true);
    const res = await fetch(`/api/crm/leads/${lead.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ stage: "perdido", lostReason }),
    });
    if (res.ok) {
      onConfirmed(lostReason);
    } else {
      setError(t("dndErrorStage"));
      setSaving(false);
    }
  }

  return (
    <Overlay onClose={onClose}>
      <SheetContent>
        <SheetHandle />
        <SheetHeader title={t("dndLostTitle")} onClose={onClose} />
        <div className="px-4 py-4 space-y-4">
          <FieldLabel required>{t("lostReasonLabel")}</FieldLabel>
          <select
            value={lostReason}
            onChange={(e) => { setLostReason(e.target.value); setError(null); }}
            className="w-full px-3 py-2.5 rounded-xl border border-op-border bg-op-bg text-sm focus:outline-none focus:ring-1 focus:ring-terracotta min-h-[44px]"
          >
            <option value="">{"—"}</option>
            {LOST_REASONS.map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
          {error && <p className="text-sm text-terracotta">{error}</p>}
          <div className="flex gap-3">
            <button
              onClick={onClose}
              className="flex-1 py-3 rounded-xl border border-op-border text-sm font-medium min-h-[44px] text-op-muted"
            >
              {t("dupesCancel")}
            </button>
            <button
              onClick={handleConfirm}
              disabled={saving}
              className="flex-1 py-3.5 rounded-xl bg-terracotta text-white font-medium disabled:opacity-50 min-h-[44px]"
            >
              {saving ? <span className="flex justify-center"><Spinner /></span> : t("dndLostConfirm")}
            </button>
          </div>
        </div>
      </SheetContent>
    </Overlay>
  );
}

// ── Main component ─────────────────────────────────────────────────────────

export function CrmPipelineClient({
  initialLeads,
  nextCursor: initialCursor,
  stageCounts: initialStageCounts,
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
  const [counts, setCounts] = useState<StageCounts>(initialStageCounts);
  const [cursor, setCursor] = useState<string | undefined>(initialCursor);
  const [hasMore, setHasMore] = useState(!!initialCursor);
  const [loading, setLoading] = useState(false);
  const [showNewLead, setShowNewLead] = useState(false);

  // ── DnD state (desktop kanban only)
  const dragRef = useRef<{ leadId: string; fromStage: string } | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  type DndSheet =
    | { kind: "convert"; lead: LeadCard }
    | { kind: "lost"; lead: LeadCard }
    | null;
  const [dndSheet, setDndSheet] = useState<DndSheet>(null);
  const [dndToast, setDndToast] = useState<{ msg: string; ok: boolean } | null>(null);

  // ── Kanban full-load state (desktop only)
  const KANBAN_CAP = 500;
  const [kanbanLoadingAll, setKanbanLoadingAll] = useState(false);
  const [kanbanHitCap, setKanbanHitCap] = useState(false);
  // Ref so loadAllKanbanPages can check whether it's already running
  const kanbanLoadingRef = useRef(false);
  // Ref to track whether a silent background refresh is in-flight
  const refreshInFlightRef = useRef(false);

  function showDndToast(msg: string, ok: boolean) {
    setDndToast({ msg, ok });
    setTimeout(() => setDndToast(null), 3500);
  }

  // Debounce ref for search
  const searchRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [, startTransition] = useTransition();

  // ── Fetch function — returns the nextCursor so callers can chain loadAllKanbanPages
  const fetchLeads = useCallback(
    async (opts: {
      stage?: Stage | "all";
      q?: string;
      assignedTo?: string;
      cursor?: string;
      reset?: boolean;
      includeCounts?: boolean;
      /** When true, does not flip the loading spinner (silent background refresh). */
      silent?: boolean;
    }): Promise<string | undefined> => {
      if (!opts.silent) setLoading(true);
      try {
        const params = new URLSearchParams();
        if (opts.stage && opts.stage !== "all") params.set("stage", opts.stage);
        if (opts.q) params.set("q", opts.q);
        if (opts.assignedTo) params.set("assignedTo", opts.assignedTo);
        if (opts.cursor) params.set("cursor", opts.cursor);
        if (opts.includeCounts) params.set("counts", "1");

        const res = await fetch(`/api/crm/leads?${params.toString()}`);
        const json = await res.json();
        const newLeads: LeadCard[] = json.leads ?? [];
        const nextCursor: string | undefined = json.nextCursor;

        startTransition(() => {
          if (opts.reset) {
            setLeads(newLeads);
          } else {
            setLeads((prev) => [...prev, ...newLeads]);
          }
          setCursor(nextCursor);
          setHasMore(!!nextCursor);
          if (opts.includeCounts && json.stageCounts) {
            setCounts(json.stageCounts);
          }
        });

        return nextCursor;
      } finally {
        if (!opts.silent) setLoading(false);
      }
    },
    [],
  );

  // ── Kanban: load ALL remaining pages after initial fetch (desktop only)
  // Silently fetches sequential pages (no spinner on existing content) until
  // nextCursor is null or KANBAN_CAP leads have been loaded.
  // `startCursor` is the cursor returned by the preceding reset fetch.
  // `seedLeads` is the page-1 array already fetched (passed on refresh so we
  //  can accumulate everything locally and do ONE setState at the end instead
  //  of per-page repaints). On first mount, seedLeads is undefined and we fall
  //  back to progressive appending (acceptable; cards not yet visible).
  const loadAllKanbanPages = useCallback(
    async (opts: {
      stage: Stage | "all";
      q: string;
      assignedTo: string;
      startCursor: string | undefined;
      /** Page-1 leads already fetched — when provided, accumulates silently
       *  and does a single setState with all pages concatenated. */
      seedLeads?: LeadCard[];
    }) => {
      if (!opts.startCursor) return; // nothing to load
      if (kanbanLoadingRef.current) return;
      kanbanLoadingRef.current = true;
      setKanbanLoadingAll(true);
      setKanbanHitCap(false);
      try {
        let localCursor: string | undefined = opts.startCursor;

        if (opts.seedLeads !== undefined) {
          // ── Silent refresh path: accumulate all pages locally, single swap ──
          const accumulated: LeadCard[] = [...opts.seedLeads];
          let lastCursor: string | undefined = opts.startCursor;

          while (localCursor && accumulated.length < KANBAN_CAP) {
            const params = new URLSearchParams();
            if (opts.stage && opts.stage !== "all") params.set("stage", opts.stage);
            if (opts.q) params.set("q", opts.q);
            if (opts.assignedTo) params.set("assignedTo", opts.assignedTo);
            params.set("cursor", localCursor);

            const res = await fetch(`/api/crm/leads?${params.toString()}`);
            const json = await res.json();
            const newLeads: LeadCard[] = json.leads ?? [];
            const nextCur: string | undefined = json.nextCursor;

            accumulated.push(...newLeads);
            localCursor = nextCur;
            lastCursor = nextCur;
          }

          // Single state swap — no intermediate repaints
          startTransition(() => {
            setLeads(accumulated);
            setCursor(lastCursor);
            setHasMore(!!lastCursor);
          });

          if (accumulated.length >= KANBAN_CAP && localCursor) {
            setKanbanHitCap(true);
          }
        } else {
          // ── First-mount path: progressive append (cards scroll in naturally) ──
          let localTotal = 0;
          setLeads((current) => { localTotal = current.length; return current; });

          while (localCursor && localTotal < KANBAN_CAP) {
            const params = new URLSearchParams();
            if (opts.stage && opts.stage !== "all") params.set("stage", opts.stage);
            if (opts.q) params.set("q", opts.q);
            if (opts.assignedTo) params.set("assignedTo", opts.assignedTo);
            params.set("cursor", localCursor);

            const res = await fetch(`/api/crm/leads?${params.toString()}`);
            const json = await res.json();
            const newLeads: LeadCard[] = json.leads ?? [];
            const nextCur: string | undefined = json.nextCursor;

            startTransition(() => {
              setLeads((prev) => [...prev, ...newLeads]);
              setCursor(nextCur);
              setHasMore(!!nextCur);
            });

            localCursor = nextCur;
            localTotal += newLeads.length;
          }

          if (localTotal >= KANBAN_CAP && localCursor) {
            setKanbanHitCap(true);
          }
        }
      } finally {
        kanbanLoadingRef.current = false;
        setKanbanLoadingAll(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  // ── Silent background refresh (covers back-nav stale router-cache props)
  // Throttled to at most once every 60 s; skipped while a dnd sheet is open,
  // a drag is in progress, or a refresh fetch is already in-flight.
  const lastRefreshRef = useRef<number>(0);

  // Ref to current leads so the identity guard can compare without a dep
  const leadsRef = useRef<LeadCard[]>(leads);
  useEffect(() => { leadsRef.current = leads; }, [leads]);

  const refreshAll = useCallback(() => {
    // Skip if a dnd sheet is open, a drag is active, or already fetching
    if (dndSheet !== null || dragRef.current !== null) return;
    if (refreshInFlightRef.current) return;
    const now = Date.now();
    if (now - lastRefreshRef.current < 60_000) return;
    lastRefreshRef.current = now;
    refreshInFlightRef.current = true;

    // Re-fetch page 1 with current filters + counts silently (no spinner over
    // existing content — data swaps in when the full load completes).
    fetch(`/api/crm/leads?${(() => {
      const p = new URLSearchParams();
      if (activeStage && activeStage !== "all") p.set("stage", activeStage);
      if (q) p.set("q", q);
      if (assignedTo) p.set("assignedTo", assignedTo);
      p.set("counts", "1");
      return p.toString();
    })()}`)
      .then(async (res) => {
        const json = await res.json();
        const page1Leads: LeadCard[] = json.leads ?? [];
        const nextCursor: string | undefined = json.nextCursor;

        if (json.stageCounts) {
          startTransition(() => setCounts(json.stageCounts));
        }

        if (!nextCursor) {
          // Only one page — identity guard before swapping
          type Projection = { id: string; stage: string; lastActivityAt: string | null };
          const project = (arr: LeadCard[]): Projection[] =>
            arr.map((l) => ({ id: l.id, stage: l.stage, lastActivityAt: l.lastActivityAt ? String(l.lastActivityAt) : null }));
          if (JSON.stringify(project(page1Leads)) !== JSON.stringify(project(leadsRef.current))) {
            startTransition(() => {
              setLeads(page1Leads);
              setCursor(undefined);
              setHasMore(false);
            });
          }
        } else {
          // Multi-page: accumulate silently via loadAllKanbanPages
          await loadAllKanbanPages({
            stage: activeStage,
            q,
            assignedTo,
            startCursor: nextCursor,
            seedLeads: page1Leads,
          });
        }
      })
      .catch(() => {/* silent — stale data stays */})
      .finally(() => { refreshInFlightRef.current = false; });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeStage, q, assignedTo, dndSheet, loadAllKanbanPages]);

  // On mount: refreshAll fires (throttle gate is open at t=0) — it fetches
  // page 1 + full kanban silently. The fallback loadAllKanbanPages call below
  // covers the edge case where refreshAll is somehow skipped (gate closed),
  // using the SSR cursor so the initial kanban still loads.
  useEffect(() => {
    refreshAll();
    if (initialCursor) {
      // Runs only if refreshAll was skipped (kanbanLoadingRef guards double-run).
      loadAllKanbanPages({ stage: activeStage, q, assignedTo, startCursor: initialCursor });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // On window focus / visibilitychange (covers returning to tab/PWA)
  useEffect(() => {
    function handleFocus() { refreshAll(); }
    function handleVisibility() {
      if (!document.hidden) refreshAll();
    }
    window.addEventListener("focus", handleFocus);
    document.addEventListener("visibilitychange", handleVisibility);
    return () => {
      window.removeEventListener("focus", handleFocus);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [refreshAll]);

  // Stage chip click
  function handleStageClick(stage: Stage | "all") {
    setActiveStage(stage);
    fetchLeads({ stage, q, assignedTo, reset: true, includeCounts: true })
      .then((nextCursor) => loadAllKanbanPages({ stage, q, assignedTo, startCursor: nextCursor }));
  }

  // Search input
  function handleSearchChange(val: string) {
    setQ(val);
    if (searchRef.current) clearTimeout(searchRef.current);
    searchRef.current = setTimeout(() => {
      fetchLeads({ stage: activeStage, q: val, assignedTo, reset: true })
        .then((nextCursor) => loadAllKanbanPages({ stage: activeStage, q: val, assignedTo, startCursor: nextCursor }));
    }, 350);
  }

  // Assigned-to selector (gerente)
  // selector value "" = "Todo mi equipo" → omit param → full visible scope
  // selector value userId = "Yo" → restrict to own leads
  // selector value = specific member id → restrict to that member
  function handleAssignedToChange(val: string) {
    setAssignedTo(val);
    fetchLeads({ stage: activeStage, q, assignedTo: val, reset: true })
      .then((nextCursor) => loadAllKanbanPages({ stage: activeStage, q, assignedTo: val, startCursor: nextCursor }));
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

  // ── DnD drop handler (desktop only)
  function handleDrop(toStage: string) {
    const drag = dragRef.current;
    if (!drag) return;
    const { leadId, fromStage } = drag;
    dragRef.current = null;
    setDropTarget(null);

    if (fromStage === toStage) return; // no-op

    const lead = leads.find((l) => l.id === leadId);
    if (!lead) return;

    if (toStage === "ganado") {
      setDndSheet({ kind: "convert", lead });
      return;
    }

    if (toStage === "perdido") {
      setDndSheet({ kind: "lost", lead });
      return;
    }

    // Optimistic update for all other stages
    const prevLeads = leads;
    const prevCounts = counts;
    setLeads(applyDrop(leads, leadId, fromStage, toStage));
    setCounts(applyDropCounts(counts, fromStage, toStage));

    fetch(`/api/crm/leads/${leadId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ stage: toStage }),
    })
      .then((res) => {
        if (res.ok) {
          showDndToast(t("dndToastMoved", { stage: stageLabel[toStage] ?? toStage }), true);
        } else {
          setLeads(prevLeads);
          setCounts(prevCounts);
          showDndToast(t("dndErrorStage"), false);
        }
      })
      .catch(() => {
        setLeads(prevLeads);
        setCounts(prevCounts);
        showDndToast(t("dndErrorStage"), false);
      });
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
            count={counts.total ?? 0}
            active={activeStage === "all"}
            onClick={() => handleStageClick("all")}
          />
          {STAGES.map((s) => (
            <StageChip
              key={s}
              label={stageLabel[s] ?? s}
              count={counts[s] ?? 0}
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
      <div className="hidden lg:flex flex-1 overflow-x-auto px-4 pb-4 gap-3 items-stretch">
        {STAGES.map((s) => {
          const colLeads = leads.filter((l) => l.stage === s);
          return (
            <KanbanColumn
              key={s}
              stage={s}
              label={stageLabel[s] ?? s}
              leads={colLeads}
              relTime={relTime}
              t={t}
              kanbanColumnHeader={t("kanbanColumnHeader", { count: counts[s] ?? 0 })}
              isDragOver={dropTarget === s}
              onDragOverColumn={(e) => { e.preventDefault(); setDropTarget(s); }}
              onDragLeaveColumn={() => setDropTarget(null)}
              onDropColumn={() => handleDrop(s)}
              onCardDragStart={(leadId) => { dragRef.current = { leadId, fromStage: s }; }}
              onCardDragEnd={() => { dragRef.current = null; setDropTarget(null); }}
            />
          );
        })}
      </div>

      {/* Kanban: subtle loading + cap note (desktop only) */}
      {(kanbanLoadingAll || kanbanHitCap) && (
        <div className="hidden lg:flex justify-center pb-3">
          {kanbanLoadingAll && (
            <span className="flex items-center gap-2 text-xs text-op-muted">
              <Spinner />
              {t("kanbanLoadingAll")}
            </span>
          )}
          {kanbanHitCap && !kanbanLoadingAll && (
            <span className="text-xs text-op-muted">{t("kanbanCap")}</span>
          )}
        </div>
      )}

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

      {/* DnD toast */}
      {dndToast && (
        <div
          className={
            "fixed bottom-24 left-1/2 -translate-x-1/2 z-50 px-4 py-2 rounded-xl shadow-lg text-sm font-medium whitespace-nowrap " +
            (dndToast.ok ? "bg-green-600 text-white" : "bg-rose-600 text-white")
          }
        >
          {dndToast.msg}
        </div>
      )}

      {/* DnD sheets */}
      {dndSheet?.kind === "convert" && (
        <DndConvertSheet
          lead={dndSheet.lead}
          role={role}
          onClose={() => setDndSheet(null)}
          onConverted={(_restaurantId) => {
            const fromStage = dndSheet.lead.stage;
            setLeads((prev) =>
              prev.map((l) =>
                l.id === dndSheet.lead.id
                  ? { ...l, stage: "ganado" }
                  : l,
              ),
            );
            setCounts((prev) => applyDropCounts(prev, fromStage, "ganado"));
            setDndSheet(null);
            showDndToast(t("dndToastMoved", { stage: stageLabel["ganado"] ?? "ganado" }), true);
          }}
        />
      )}
      {dndSheet?.kind === "lost" && (
        <DndLostReasonSheet
          lead={dndSheet.lead}
          onClose={() => setDndSheet(null)}
          onConfirmed={(lostReason) => {
            const fromStage = dndSheet.lead.stage;
            setLeads((prev) =>
              prev.map((l) =>
                l.id === dndSheet.lead.id
                  ? { ...l, stage: "perdido", lostReason }
                  : l,
              ),
            );
            setCounts((prev) => applyDropCounts(prev, fromStage, "perdido"));
            setDndSheet(null);
            showDndToast(
              t("dndToastMoved", { stage: stageLabel["perdido"] ?? "perdido" }),
              true,
            );
          }}
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

function GroupUnitsBadge({
  lead,
  t,
}: {
  lead: LeadCard;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  t: (key: string, vars?: Record<string, any>) => string;
}) {
  if (lead.unitNames.length > 0) {
    const first2 = lead.unitNames.slice(0, 2).join(", ");
    const rest = lead.unitNames.length - 2;
    const summary =
      rest > 0
        ? t("groupUnitsSummary", { first: first2, rest })
        : first2;
    const count = lead.unitNames.length;
    return (
      <div className="flex items-center gap-1.5 flex-wrap min-w-0">
        <span className="text-xs text-op-muted truncate max-w-[140px]">{summary}</span>
        <span className="font-mono text-[10px] bg-slate-100 text-slate-600 px-1.5 py-0.5 rounded shrink-0 whitespace-nowrap">
          {t("groupUnitsCount", { count })}
        </span>
      </div>
    );
  }
  if (lead.unitsCount && lead.unitsCount > 1) {
    return (
      <span className="font-mono text-[10px] bg-slate-100 text-slate-600 px-1.5 py-0.5 rounded shrink-0 whitespace-nowrap">
        {t("groupUnitsCount", { count: lead.unitsCount })}
      </span>
    );
  }
  return null;
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  t: (key: string, vars?: Record<string, any>) => string;
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
    openWhatsApp(primaryContact.phone);
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

      {/* Group units summary */}
      <GroupUnitsBadge lead={lead} t={t} />

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
  isDragOver,
  onDragOverColumn,
  onDragLeaveColumn,
  onDropColumn,
  onCardDragStart,
  onCardDragEnd,
}: {
  stage: string;
  label: string;
  leads: LeadCard[];
  relTime: (d: Date | string | null) => string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  t: (key: string, vars?: Record<string, any>) => string;
  kanbanColumnHeader: string;
  isDragOver: boolean;
  onDragOverColumn: (e: React.DragEvent) => void;
  onDragLeaveColumn: () => void;
  onDropColumn: () => void;
  onCardDragStart: (leadId: string) => void;
  onCardDragEnd: () => void;
}) {
  return (
    <div
      className={
        "w-64 shrink-0 flex flex-col gap-2 rounded-xl p-1 transition-colors self-stretch min-h-[200px] " +
        (isDragOver ? "ring-2 ring-terracotta bg-terracotta/5" : "")
      }
      onDragOver={(e) => { e.preventDefault(); onDragOverColumn(e); }}
      onDragLeave={onDragLeaveColumn}
      onDrop={(e) => { e.preventDefault(); onDropColumn(); }}
    >
      {/* Column header */}
      <div
        className={
          "flex items-center justify-between px-3 py-2 rounded-xl shrink-0 " +
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
        <div className="flex-1 text-xs text-op-muted text-center py-4">{t("emptyLeads")}</div>
      ) : (
        leads.map((lead) => (
          <div
            key={lead.id}
            draggable
            onDragStart={(e) => {
              e.dataTransfer.effectAllowed = "move";
              onCardDragStart(lead.id);
            }}
            onDragEnd={onCardDragEnd}
            onDragOver={(e) => e.preventDefault()}
            className="rounded-xl border border-op-border bg-op-surface p-3 space-y-2 cursor-grab active:cursor-grabbing active:opacity-50 select-none transition-opacity"
          >
            <Link
              href={`/comercial/crm/${lead.id}`}
              className="font-medium text-sm hover:text-terracotta flex items-center gap-1.5"
              onClick={(e) => {
                // Prevent navigation during drag
                if (e.currentTarget.closest("[draggable]")?.getAttribute("draggable") === "true") {
                  // Allow normal clicks (no drag in progress)
                }
              }}
            >
              <span
                className={"w-2 h-2 rounded-full shrink-0 " + priorityDot(lead.priority)}
                aria-hidden
              />
              <span className="truncate">{lead.name}</span>
            </Link>
            <GroupUnitsBadge lead={lead} t={t} />
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
    openWhatsApp(phone);
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
