"use client";

import Link from "next/link";
import { useRef, useState, useTransition } from "react";
import { useTranslations } from "next-intl";

// ── Types ──────────────────────────────────────────────────────────────────

export type AppointmentItem = {
  id: string;
  title: string;
  startsAt: string;
  endsAt: string;
  notes: string | null;
  status: string;
  leadId: string;
  lead: { id: string; name: string } | null;
  user: { id: string; name: string | null; email: string };
};

// ── Helpers ────────────────────────────────────────────────────────────────

/** Return ISO date for Monday of the week containing `date`. */
function weekStart(date: Date): Date {
  const d = new Date(date);
  const day = d.getDay(); // 0=Sun, 1=Mon...
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  d.setHours(0, 0, 0, 0);
  return d;
}

function addDays(date: Date, days: number): Date {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

function toIso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function formatHhmm(iso: string): string {
  const d = new Date(iso);
  // Bogota = UTC-5
  const b = new Date(d.getTime() - 5 * 60 * 60 * 1000);
  const hh = String(b.getUTCHours()).padStart(2, "0");
  const mm = String(b.getUTCMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

function isoDateBogota(iso: string): string {
  const d = new Date(iso);
  const b = new Date(d.getTime() - 5 * 60 * 60 * 1000);
  return `${b.getUTCFullYear()}-${String(b.getUTCMonth() + 1).padStart(2, "0")}-${String(b.getUTCDate()).padStart(2, "0")}`;
}

const STATUS_COLORS: Record<string, string> = {
  scheduled: "bg-violet-100 text-violet-700 border-violet-200",
  done: "bg-green-100 text-green-700 border-green-200",
  cancelled: "bg-rose-100 text-rose-600 border-rose-200",
};

// ── Appointment row (mobile list) ──────────────────────────────────────────

function AppointmentRow({
  appt,
  onStatusChange,
}: {
  appt: AppointmentItem;
  onStatusChange: (id: string, status: "done" | "cancelled") => void;
}) {
  const t = useTranslations("crm");
  const [menuOpen, setMenuOpen] = useState(false);

  const statusLabel: Record<string, string> = {
    scheduled: t("appointStatusScheduled"),
    done: t("appointStatusDone"),
    cancelled: t("appointStatusCancelled"),
  };

  return (
    <div className={"rounded-xl border px-4 py-3 flex items-start gap-3 " + (STATUS_COLORS[appt.status] ?? "bg-op-surface border-op-border")}>
      <div className="font-mono text-xs text-current shrink-0 w-10 text-center mt-0.5">
        {formatHhmm(appt.startsAt)}
      </div>
      <div className="flex-1 min-w-0">
        <div className="font-medium text-sm truncate">{appt.title}</div>
        {appt.lead && (
          <Link
            href={`/comercial/crm/${appt.lead.id}`}
            className="text-xs hover:underline opacity-70"
          >
            {appt.lead.name}
          </Link>
        )}
        {appt.notes && (
          <div className="text-xs opacity-60 truncate mt-0.5">{appt.notes}</div>
        )}
      </div>
      {appt.status === "scheduled" && (
        <div className="relative shrink-0">
          <button
            onClick={() => setMenuOpen((v) => !v)}
            className="min-w-[44px] min-h-[44px] flex items-center justify-center rounded-lg hover:bg-black/10 transition-colors"
          >
            <svg viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
              <path d="M10 6a2 2 0 110-4 2 2 0 010 4zM10 12a2 2 0 110-4 2 2 0 010 4zM10 18a2 2 0 110-4 2 2 0 010 4z" />
            </svg>
          </button>
          {menuOpen && (
            <div className="absolute right-0 top-full mt-1 z-50 bg-op-surface border border-op-border rounded-xl shadow-lg min-w-[160px]">
              <button
                onClick={() => { setMenuOpen(false); onStatusChange(appt.id, "done"); }}
                className="w-full text-left px-4 py-3 text-sm hover:bg-op-bg min-h-[44px]"
              >
                {t("appointMarkDone")}
              </button>
              <button
                onClick={() => { setMenuOpen(false); onStatusChange(appt.id, "cancelled"); }}
                className="w-full text-left px-4 py-3 text-sm text-rose-600 hover:bg-op-bg min-h-[44px]"
              >
                {t("appointMarkCancelled")}
              </button>
            </div>
          )}
        </div>
      )}
      {appt.status !== "scheduled" && (
        <span className="text-[10px] font-mono uppercase opacity-60 shrink-0 mt-1">
          {statusLabel[appt.status] ?? appt.status}
        </span>
      )}
    </div>
  );
}

// ── New appointment sheet ──────────────────────────────────────────────────

function NewAppointmentSheet({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (appt: AppointmentItem) => void;
}) {
  const t = useTranslations("crm");
  const [title, setTitle] = useState("");
  const [dateVal, setDateVal] = useState(() => new Date().toISOString().slice(0, 10));
  const [timeVal, setTimeVal] = useState(() => {
    const d = new Date();
    return `${String(d.getHours()).padStart(2, "0")}:${d.getMinutes() >= 30 ? "30" : "00"}`;
  });
  const [durationMins, setDurationMins] = useState(60);
  const [notes, setNotes] = useState("");
  const [leadSearch, setLeadSearch] = useState("");
  const [leadResults, setLeadResults] = useState<{ id: string; name: string }[]>([]);
  const [selectedLead, setSelectedLead] = useState<{ id: string; name: string } | null>(null);
  const [showLeadDropdown, setShowLeadDropdown] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const searchRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Search leads
  function handleLeadSearch(val: string) {
    setLeadSearch(val);
    setSelectedLead(null);
    setShowLeadDropdown(true);
    if (searchRef.current) clearTimeout(searchRef.current);
    if (!val.trim()) { setLeadResults([]); return; }
    searchRef.current = setTimeout(async () => {
      try {
        const res = await fetch(`/api/crm/leads?q=${encodeURIComponent(val)}&take=10`);
        const json = await res.json();
        setLeadResults((json.leads ?? []).map((l: { id: string; name: string }) => ({ id: l.id, name: l.name })));
      } catch { /* ignore */ }
    }, 300);
  }

  async function handleSave() {
    if (!title.trim() || !selectedLead || !dateVal || !timeVal) return;
    setSaving(true);
    setError(null);
    try {
      const startsAt = new Date(`${dateVal}T${timeVal}:00`).toISOString();
      const endsAt = new Date(
        new Date(`${dateVal}T${timeVal}:00`).getTime() + durationMins * 60 * 1000,
      ).toISOString();
      const res = await fetch("/api/crm/appointments", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ leadId: selectedLead.id, title: title.trim(), startsAt, endsAt, notes: notes.trim() || undefined }),
      });
      const json = await res.json();
      if (!res.ok) { setError(t("saveError")); setSaving(false); return; }
      onCreated({
        id: json.appointment.id,
        title: json.appointment.title,
        startsAt: json.appointment.startsAt,
        endsAt: json.appointment.endsAt,
        notes: json.appointment.notes ?? null,
        status: json.appointment.status,
        leadId: selectedLead.id,
        lead: { id: selectedLead.id, name: selectedLead.name },
        user: json.appointment.user ?? { id: "", name: null, email: "" },
      });
    } catch {
      setError(t("saveError")); setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex flex-col justify-end" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={onClose} aria-hidden="true" />
      <div className="relative z-10 bg-op-surface rounded-t-2xl max-h-[90dvh] flex flex-col shadow-xl"
        style={{ paddingBottom: "env(safe-area-inset-bottom)" }}>
        <div className="flex justify-center pt-3 pb-1">
          <div className="w-10 h-1 rounded-full bg-op-border" />
        </div>
        <div className="flex items-center justify-between px-4 py-3 border-b border-op-border">
          <div className="font-display text-xl">{t("calendarNewAppointment")}</div>
          <button onClick={onClose} className="p-2 rounded-lg text-op-muted hover:text-op-text min-h-[44px] min-w-[44px] flex items-center justify-center">
            <svg viewBox="0 0 20 20" fill="currentColor" className="w-5 h-5">
              <path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd" />
            </svg>
          </button>
        </div>
        <div className="overflow-y-auto flex-1 px-4 py-4 space-y-4 pb-6">
          {/* Lead search */}
          <div>
            <label className="block font-mono text-[10px] tracking-wider uppercase text-op-muted mb-1">{t("appointFieldLead")} <span className="text-terracotta">{"*"}</span></label>
            <div className="relative">
              <input type="text" value={leadSearch} onChange={(e) => handleLeadSearch(e.target.value)}
                onFocus={() => setShowLeadDropdown(true)}
                placeholder={t("appointLeadPlaceholder")} autoComplete="off"
                className="w-full px-3 py-2.5 rounded-xl border border-op-border bg-op-bg text-sm focus:outline-none focus:ring-1 focus:ring-terracotta min-h-[44px]" />
              {selectedLead && (
                <div className="mt-1 text-xs text-terracotta font-medium px-1">{selectedLead.name}</div>
              )}
              {showLeadDropdown && leadResults.length > 0 && (
                <ul className="absolute z-50 left-0 right-0 top-full mt-1 max-h-48 overflow-y-auto rounded-xl border border-op-border bg-op-surface shadow-lg">
                  {leadResults.map((l) => (
                    <li key={l.id}>
                      <button type="button" onMouseDown={() => { setSelectedLead(l); setLeadSearch(l.name); setShowLeadDropdown(false); }}
                        className="w-full text-left px-4 py-3 text-sm hover:bg-op-bg min-h-[44px]">
                        {l.name}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
          {/* Title */}
          <div>
            <label className="block font-mono text-[10px] tracking-wider uppercase text-op-muted mb-1">{t("appointFieldTitle")} <span className="text-terracotta">{"*"}</span></label>
            <input type="text" value={title} onChange={(e) => setTitle(e.target.value)}
              className="w-full px-3 py-2.5 rounded-xl border border-op-border bg-op-bg text-sm focus:outline-none focus:ring-1 focus:ring-terracotta min-h-[44px]" />
          </div>
          {/* Date + Time */}
          <div className="flex gap-3">
            <div className="flex-1">
              <label className="block font-mono text-[10px] tracking-wider uppercase text-op-muted mb-1">{t("appointFieldDate")} <span className="text-terracotta">{"*"}</span></label>
              <input type="date" value={dateVal} onChange={(e) => setDateVal(e.target.value)}
                className="w-full px-3 py-2.5 rounded-xl border border-op-border bg-op-bg text-sm focus:outline-none focus:ring-1 focus:ring-terracotta min-h-[44px]" />
            </div>
            <div className="flex-1">
              <label className="block font-mono text-[10px] tracking-wider uppercase text-op-muted mb-1">{t("appointFieldTime")} <span className="text-terracotta">{"*"}</span></label>
              <input type="time" value={timeVal} onChange={(e) => setTimeVal(e.target.value)}
                className="w-full px-3 py-2.5 rounded-xl border border-op-border bg-op-bg text-sm focus:outline-none focus:ring-1 focus:ring-terracotta min-h-[44px]" />
            </div>
          </div>
          {/* Duration */}
          <div>
            <label className="block font-mono text-[10px] tracking-wider uppercase text-op-muted mb-1">{t("appointFieldDuration")}</label>
            <div className="flex gap-2">
              {([30, 60, 90] as const).map((d) => (
                <button key={d} type="button" onClick={() => setDurationMins(d)}
                  className={"flex-1 py-2.5 rounded-xl border-2 text-sm font-medium min-h-[44px] transition-all " +
                    (durationMins === d ? "border-terracotta bg-terracotta/5 text-terracotta" : "border-op-border text-op-muted hover:border-op-text")}>
                  {d === 30 ? t("appointDuration30") : d === 60 ? t("appointDuration60") : t("appointDuration90")}
                </button>
              ))}
            </div>
          </div>
          {/* Notes */}
          <div>
            <label className="block font-mono text-[10px] tracking-wider uppercase text-op-muted mb-1">{t("appointFieldNotes")}</label>
            <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2}
              className="w-full px-3 py-2.5 rounded-xl border border-op-border bg-op-bg text-sm focus:outline-none focus:ring-1 focus:ring-terracotta resize-none" />
          </div>
          {error && <p className="text-sm text-terracotta">{error}</p>}
          <button onClick={handleSave} disabled={saving || !title.trim() || !selectedLead}
            className="w-full py-3.5 rounded-xl bg-terracotta text-white font-medium disabled:opacity-50 min-h-[44px]">
            {saving ? t("appointCreating") : t("appointSubmitCreate")}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Main client ────────────────────────────────────────────────────────────

export function CrmCalendarioClient({
  initialAppointments,
  initialFrom,
}: {
  initialAppointments: AppointmentItem[];
  initialFrom: string; // ISO date
  initialTo?: string; // ISO date — reserved for future use
}) {
  const t = useTranslations("crm");
  const [, startTransition] = useTransition();

  // Week anchor = Monday of current week.
  const [weekAnchor, setWeekAnchor] = useState<Date>(() => {
    const d = new Date(initialFrom);
    d.setHours(0, 0, 0, 0);
    return d;
  });

  const [appointments, setAppointments] = useState<AppointmentItem[]>(initialAppointments);
  const [loading, setLoading] = useState(false);
  const [showNew, setShowNew] = useState(false);

  // Derive week days Mon-Sun
  const days = Array.from({ length: 7 }, (_, i) => addDays(weekAnchor, i));

  // Group appointments by Bogota date
  const byDay: Record<string, AppointmentItem[]> = {};
  for (const appt of appointments) {
    const dateKey = isoDateBogota(appt.startsAt);
    if (!byDay[dateKey]) byDay[dateKey] = [];
    byDay[dateKey].push(appt);
  }

  const todayIso = toIso(new Date());

  async function loadWeek(anchor: Date) {
    setLoading(true);
    try {
      const from = anchor.toISOString();
      const to = addDays(anchor, 7).toISOString();
      const res = await fetch(`/api/crm/appointments?from=${from}&to=${to}`);
      const json = await res.json();
      startTransition(() => {
        setAppointments(json.appointments ?? []);
      });
    } finally {
      setLoading(false);
    }
  }

  function goPrev() {
    const next = addDays(weekAnchor, -7);
    setWeekAnchor(next);
    loadWeek(next);
  }

  function goNext() {
    const next = addDays(weekAnchor, 7);
    setWeekAnchor(next);
    loadWeek(next);
  }

  function goToday() {
    const anchor = weekStart(new Date());
    setWeekAnchor(anchor);
    loadWeek(anchor);
  }

  function handleStatusChange(id: string, status: "done" | "cancelled") {
    fetch(`/api/crm/appointments/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status }),
    }).then(async (res) => {
      if (res.ok) {
        startTransition(() => {
          setAppointments((prev) =>
            prev.map((a) => (a.id === id ? { ...a, status } : a)),
          );
        });
      }
    }).catch(() => {});
  }

  function handleCreated(appt: AppointmentItem) {
    startTransition(() => {
      setAppointments((prev) => [...prev, appt].sort(
        (a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime(),
      ));
      setShowNew(false);
    });
  }

  const weekLabel = (() => {
    const mon = weekAnchor;
    const sun = addDays(weekAnchor, 6);
    const mStr = `${mon.getDate()} ${mon.toLocaleString("default", { month: "short" })}`;
    const sStr = `${sun.getDate()} ${sun.toLocaleString("default", { month: "short" })} ${sun.getFullYear()}`;
    return `${mStr} – ${sStr}`;
  })();

  // ── MOBILE: grouped list per day ────────────────────────────────────────
  // ── DESKTOP: 7-column grid ────────────────────────────────────────────

  return (
    <div className="flex-1 flex flex-col">
      {/* Header */}
      <div className="px-4 pt-4 pb-3 border-b border-op-border">
        <div className="flex items-center justify-between gap-2 mb-3">
          <div className="font-display text-xl">{t("calendarPageTitle")}</div>
          <button
            onClick={() => setShowNew(true)}
            className="px-3 py-2 rounded-xl bg-terracotta text-white text-xs font-medium min-h-[44px] flex items-center gap-1.5 hover:opacity-90 transition-opacity"
          >
            <svg viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
              <path fillRule="evenodd" d="M10 3a1 1 0 011 1v5h5a1 1 0 110 2h-5v5a1 1 0 11-2 0v-5H4a1 1 0 110-2h5V4a1 1 0 011-1z" clipRule="evenodd" />
            </svg>
            {t("calendarNewAppointment")}
          </button>
        </div>
        {/* Week navigation */}
        <div className="flex items-center gap-2">
          <button onClick={goPrev} aria-label={t("calendarPrevWeek")}
            className="min-w-[44px] min-h-[44px] flex items-center justify-center rounded-xl border border-op-border hover:bg-op-bg transition-colors">
            <svg viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
              <path fillRule="evenodd" d="M12.707 5.293a1 1 0 010 1.414L9.414 10l3.293 3.293a1 1 0 01-1.414 1.414l-4-4a1 1 0 010-1.414l4-4a1 1 0 011.414 0z" clipRule="evenodd" />
            </svg>
          </button>
          <span className="flex-1 text-center text-sm font-medium">{weekLabel}</span>
          <button onClick={goNext} aria-label={t("calendarNextWeek")}
            className="min-w-[44px] min-h-[44px] flex items-center justify-center rounded-xl border border-op-border hover:bg-op-bg transition-colors">
            <svg viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
              <path fillRule="evenodd" d="M7.293 14.707a1 1 0 010-1.414L10.586 10 7.293 6.707a1 1 0 011.414-1.414l4 4a1 1 0 010 1.414l-4 4a1 1 0 01-1.414 0z" clipRule="evenodd" />
            </svg>
          </button>
          <button onClick={goToday}
            className="px-3 py-2 rounded-xl border border-op-border text-xs font-medium min-h-[44px] hover:bg-op-bg transition-colors">
            {t("calendarToday")}
          </button>
        </div>
      </div>

      {loading && (
        <div className="flex justify-center py-6">
          <svg className="w-5 h-5 animate-spin text-op-muted" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
          </svg>
        </div>
      )}

      {!loading && (
        <>
          {/* ── MOBILE: list grouped by day ── */}
          <div className="lg:hidden flex-1 overflow-y-auto px-4 py-4 pb-24 space-y-4">
            {days.map((day) => {
              const dayIso = toIso(day);
              const dayAppts = byDay[dayIso] ?? [];
              const isToday = dayIso === todayIso;
              const dayLabel = day.toLocaleDateString("default", {
                weekday: "short",
                day: "numeric",
                month: "short",
              });
              return (
                <div key={dayIso}>
                  <div className={"flex items-center gap-2 mb-2"}>
                    <span className={"font-mono text-[10px] tracking-wider uppercase " + (isToday ? "text-terracotta font-bold" : "text-op-muted")}>
                      {dayLabel}
                    </span>
                    {isToday && <span className="w-1.5 h-1.5 rounded-full bg-terracotta" />}
                  </div>
                  {dayAppts.length === 0 ? (
                    <div className="text-xs text-op-muted pl-1">{"—"}</div>
                  ) : (
                    <div className="space-y-2">
                      {dayAppts.map((appt) => (
                        <AppointmentRow key={appt.id} appt={appt} onStatusChange={handleStatusChange} />
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
            {appointments.length === 0 && (
              <p className="text-sm text-op-muted text-center py-8">{t("calendarNoAppointments")}</p>
            )}
          </div>

          {/* ── DESKTOP: 7-column weekly grid ── */}
          <div className="hidden lg:flex flex-1 overflow-auto px-4 py-4 pb-4 gap-2">
            {days.map((day) => {
              const dayIso = toIso(day);
              const dayAppts = byDay[dayIso] ?? [];
              const isToday = dayIso === todayIso;
              const dayLabel = day.toLocaleDateString("default", { weekday: "short", day: "numeric" });
              return (
                <div key={dayIso} className={"flex-1 min-w-0 flex flex-col rounded-xl border overflow-hidden " + (isToday ? "border-terracotta" : "border-op-border")}>
                  <div className={"px-2 py-2 text-center font-mono text-[10px] tracking-wider uppercase " + (isToday ? "bg-terracotta text-white" : "bg-op-surface text-op-muted")}>
                    {dayLabel}
                  </div>
                  <div className="flex-1 p-2 space-y-1.5 overflow-y-auto bg-op-bg min-h-[300px]">
                    {dayAppts.length === 0 ? (
                      <div className="text-[10px] text-op-muted text-center pt-3">{"—"}</div>
                    ) : (
                      dayAppts.map((appt) => (
                        <div key={appt.id}
                          className={"rounded-lg border px-2 py-1.5 text-xs " + (STATUS_COLORS[appt.status] ?? "bg-op-surface border-op-border")}>
                          <div className="font-medium truncate">{formatHhmm(appt.startsAt)} {appt.title}</div>
                          {appt.lead && (
                            <Link href={`/comercial/crm/${appt.lead.id}`} className="opacity-70 hover:opacity-100 truncate block">
                              {appt.lead.name}
                            </Link>
                          )}
                        </div>
                      ))
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}

      {showNew && (
        <NewAppointmentSheet onClose={() => setShowNew(false)} onCreated={handleCreated} />
      )}
    </div>
  );
}
