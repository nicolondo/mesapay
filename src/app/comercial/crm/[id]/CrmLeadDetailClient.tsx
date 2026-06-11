"use client";

import Link from "next/link";
import { useEffect, useState, useTransition } from "react";
import { useTranslations, useFormatter } from "next-intl";
import { waLink } from "@/lib/crm/phone";

// ── Types ──────────────────────────────────────────────────────────────────

export type LeadData = {
  id: string;
  name: string;
  countryCode: string;
  stage: string;
  priority: string;
  address: string | null;
  zone: string | null;
  businessType: string | null;
  source: string | null;
  planProposed: string | null;
  unitsCount: number | null;
  notes: string | null;
  lostReason: string | null;
  nextActionAt: string | null;
  lastActivityAt: string | null;
  createdAt: string;
  city: { id: string; name: string } | null;
  assignedTo: { id: string; name: string | null; email: string } | null;
  createdBy: { id: string; name: string | null; email: string } | null;
};

export type ContactData = {
  id: string;
  name: string;
  role: string | null;
  phone: string | null;
  email: string | null;
  isPrimary: boolean;
  notes: string | null;
};

export type ActivityData = {
  id: string;
  type: string;
  content: string;
  createdAt: string;
  user: { id: string; name: string | null; email: string };
};

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

const LOST_REASONS = [
  "Precio",
  "No ve valor",
  "Ya tiene proveedor",
  "Cerró",
  "Quedó frío",
  "Otro",
] as const;

const PHONE_PREFIXES: Record<string, string> = { CO: "+57", MX: "+52" };

// ── Color helpers ──────────────────────────────────────────────────────────

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

function activityIcon(type: string): React.ReactNode {
  switch (type) {
    case "whatsapp":
      return (
        <svg viewBox="0 0 24 24" fill="currentColor" className="w-4 h-4 text-[#128C7E]">
          <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413Z" />
        </svg>
      );
    case "call":
      return (
        <svg viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4 text-blue-500">
          <path d="M2 3a1 1 0 011-1h2.153a1 1 0 01.986.836l.74 4.435a1 1 0 01-.54 1.06l-1.548.773a11.037 11.037 0 006.105 6.105l.774-1.548a1 1 0 011.059-.54l4.435.74a1 1 0 01.836.986V17a1 1 0 01-1 1h-2C7.82 18 2 12.18 2 5V3z" />
        </svg>
      );
    case "visit":
      return (
        <svg viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4 text-violet-500">
          <path fillRule="evenodd" d="M5.05 4.05a7 7 0 119.9 9.9L10 18.9l-4.95-4.95a7 7 0 010-9.9zM10 11a2 2 0 100-4 2 2 0 000 4z" clipRule="evenodd" />
        </svg>
      );
    case "stage_change":
      return (
        <svg viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4 text-amber-500">
          <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-8.707l-3-3a1 1 0 00-1.414 1.414L10.586 9H7a1 1 0 100 2h3.586l-1.293 1.293a1 1 0 101.414 1.414l3-3a1 1 0 000-1.414z" clipRule="evenodd" />
        </svg>
      );
    default: // note
      return (
        <svg viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4 text-op-muted">
          <path fillRule="evenodd" d="M4 4a2 2 0 012-2h4.586A2 2 0 0112 2.586L15.414 6A2 2 0 0116 7.414V16a2 2 0 01-2 2H6a2 2 0 01-2-2V4z" clipRule="evenodd" />
        </svg>
      );
  }
}

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

function Spinner() {
  return (
    <svg className="w-4 h-4 animate-spin text-op-muted" fill="none" viewBox="0 0 24 24">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
    </svg>
  );
}

// ── Stage sheet ────────────────────────────────────────────────────────────

function StageSheet({
  lead,
  stageLabels,
  onSaved,
  onClose,
}: {
  lead: LeadData;
  stageLabels: Record<string, string>;
  onSaved: (stage: string, lostReason?: string) => void;
  onClose: () => void;
}) {
  const t = useTranslations("crm");
  const [selectedStage, setSelectedStage] = useState(lead.stage);
  const [lostReason, setLostReason] = useState(lead.lostReason ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSave() {
    if (selectedStage === lead.stage) { onClose(); return; }
    if (selectedStage === "perdido" && !lostReason) { setError(t("lostReasonRequired")); return; }
    setSaving(true);
    const res = await fetch(`/api/crm/leads/${lead.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ stage: selectedStage, ...(selectedStage === "perdido" ? { lostReason } : {}) }),
    });
    if (res.ok) {
      onSaved(selectedStage, selectedStage === "perdido" ? lostReason : undefined);
    } else {
      setError(t("saveError")); setSaving(false);
    }
  }

  return (
    <Overlay onClose={onClose}>
      <SheetContent>
        <SheetHandle />
        <SheetHeader title={t("changeStageTitle")} onClose={onClose} />
        <div className="px-4 py-4 space-y-3">
          {STAGES.map((s) => (
            <button key={s} onClick={() => setSelectedStage(s)}
              className={"w-full flex items-center justify-between px-4 py-3 rounded-xl border-2 text-sm font-medium min-h-[44px] transition-all " + (selectedStage === s ? stageColor(s) + " border-current" : "border-op-border text-op-muted hover:border-op-text")}>
              <span>{stageLabels[s] ?? s}</span>
              {selectedStage === s && <svg viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4"><path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" /></svg>}
            </button>
          ))}
          {selectedStage === "perdido" && (
            <div className="pt-2">
              <FieldLabel required>{t("lostReasonLabel")}</FieldLabel>
              <select value={lostReason} onChange={(e) => { setLostReason(e.target.value); setError(null); }}
                className="w-full px-3 py-2.5 rounded-xl border border-op-border bg-op-bg text-sm focus:outline-none focus:ring-1 focus:ring-terracotta min-h-[44px]">
                <option value="">{"—"}</option>
                {LOST_REASONS.map((r) => <option key={r} value={r}>{r}</option>)}
              </select>
            </div>
          )}
          {error && <p className="text-sm text-terracotta">{error}</p>}
          <button onClick={handleSave} disabled={saving} className="w-full py-3.5 rounded-xl bg-terracotta text-white font-medium disabled:opacity-50 min-h-[44px] mt-2">
            {saving ? <span className="flex justify-center"><Spinner /></span> : t("saveChanges")}
          </button>
        </div>
      </SheetContent>
    </Overlay>
  );
}

// ── Next action sheet ──────────────────────────────────────────────────────

function NextActionSheet({
  lead,
  onSaved,
  onClose,
}: {
  lead: LeadData;
  onSaved: (iso: string | null) => void;
  onClose: () => void;
}) {
  const t = useTranslations("crm");
  const [dateVal, setDateVal] = useState(lead.nextActionAt ? lead.nextActionAt.slice(0, 10) : "");
  const [saving, setSaving] = useState(false);

  async function handleSave() {
    setSaving(true);
    const iso = dateVal ? new Date(dateVal + "T12:00:00.000Z").toISOString() : null;
    const res = await fetch(`/api/crm/leads/${lead.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ nextActionAt: iso }),
    });
    if (res.ok) { onSaved(iso); } else { setSaving(false); }
  }

  return (
    <Overlay onClose={onClose}>
      <SheetContent>
        <SheetHandle />
        <SheetHeader title={t("nextActionTitle")} onClose={onClose} />
        <div className="px-4 py-4 space-y-4">
          <div>
            <FieldLabel>{t("nextActionDate")}</FieldLabel>
            <input type="date" value={dateVal} onChange={(e) => setDateVal(e.target.value)}
              className="w-full px-3 py-2.5 rounded-xl border border-op-border bg-op-bg text-sm focus:outline-none focus:ring-1 focus:ring-terracotta min-h-[44px]" />
          </div>
          <div className="flex gap-3">
            {dateVal && (
              <button onClick={() => setDateVal("")} className="flex-1 py-3 rounded-xl border border-op-border text-sm font-medium min-h-[44px] text-op-muted">{t("clearDate")}</button>
            )}
            <button onClick={handleSave} disabled={saving} className="flex-1 py-3.5 rounded-xl bg-terracotta text-white font-medium disabled:opacity-50 min-h-[44px]">
              {saving ? <span className="flex justify-center"><Spinner /></span> : t("saveChanges")}
            </button>
          </div>
        </div>
      </SheetContent>
    </Overlay>
  );
}

// ── Contact sheet ──────────────────────────────────────────────────────────

function ContactSheet({
  leadId,
  lead,
  editingContact,
  countryCode,
  onSaved,
  onClose,
}: {
  leadId: string;
  lead: LeadData;
  editingContact: ContactData | null;
  countryCode: string;
  onSaved: (contacts: ContactData[]) => void;
  onClose: () => void;
}) {
  const t = useTranslations("crm");
  const isEdit = !!editingContact;
  const [name, setName] = useState(editingContact?.name ?? "");
  const [role, setRole] = useState(editingContact?.role ?? "");
  const [phone, setPhone] = useState(editingContact?.phone ?? "");
  const [email, setEmail] = useState(editingContact?.email ?? "");
  const [isPrimary, setIsPrimary] = useState(editingContact?.isPrimary ?? false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const prefix = PHONE_PREFIXES[countryCode?.toUpperCase() ?? ""] ?? "";

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true); setError(null);
    const rawPhone = phone ? (phone.startsWith("+") ? phone : prefix + phone.replace(/\D/g, "")) : undefined;
    try {
      let res: Response;
      if (isEdit && editingContact) {
        res = await fetch(`/api/crm/contacts/${editingContact.id}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: name.trim(), role: role || null, phone: rawPhone ?? null, email: email || null, isPrimary }),
        });
      } else {
        res = await fetch(`/api/crm/leads/${leadId}/contacts`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: name.trim(), role: role || undefined, phone: rawPhone, email: email || undefined, isPrimary }),
        });
      }
      const json = await res.json();
      if (!res.ok) { setError(json.error ?? "error"); setSaving(false); return; }
      // Refresh contacts.
      const fresh = await fetch(`/api/crm/leads/${lead.id}`);
      if (fresh.ok) {
        const fd = await fresh.json();
        onSaved(fd.contacts ?? []);
      } else { onClose(); }
    } catch { setError("network_error"); setSaving(false); }
  }

  return (
    <Overlay onClose={onClose}>
      <SheetContent>
        <SheetHandle />
        <SheetHeader title={isEdit ? t("editContactTitle") : t("addContactTitle")} onClose={onClose} />
        <form onSubmit={handleSubmit} className="px-4 py-4 space-y-4">
          <div>
            <FieldLabel required>{t("fieldContactName")}</FieldLabel>
            <input type="text" required value={name} onChange={(e) => setName(e.target.value)}
              className="w-full px-3 py-2.5 rounded-xl border border-op-border bg-op-bg text-sm focus:outline-none focus:ring-1 focus:ring-terracotta min-h-[44px]" />
          </div>
          <div>
            <FieldLabel>{t("fieldContactRole")}</FieldLabel>
            <input type="text" value={role} onChange={(e) => setRole(e.target.value)}
              className="w-full px-3 py-2.5 rounded-xl border border-op-border bg-op-bg text-sm focus:outline-none focus:ring-1 focus:ring-terracotta min-h-[44px]" />
          </div>
          <div>
            <FieldLabel>{t("fieldPhone")}</FieldLabel>
            <div className="flex gap-2 items-center">
              {prefix && <span className="font-mono text-sm text-op-muted border border-op-border rounded-xl px-3 py-2.5 bg-op-bg whitespace-nowrap min-h-[44px] flex items-center">{prefix}</span>}
              <input type="tel" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)}
                className="flex-1 px-3 py-2.5 rounded-xl border border-op-border bg-op-bg text-sm focus:outline-none focus:ring-1 focus:ring-terracotta min-h-[44px]" />
            </div>
          </div>
          <div>
            <FieldLabel>{"Email"}</FieldLabel>
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)}
              className="w-full px-3 py-2.5 rounded-xl border border-op-border bg-op-bg text-sm focus:outline-none focus:ring-1 focus:ring-terracotta min-h-[44px]" />
          </div>
          <label className="flex items-center gap-3 cursor-pointer min-h-[44px]">
            <input type="checkbox" checked={isPrimary} onChange={(e) => setIsPrimary(e.target.checked)} className="w-4 h-4 rounded accent-terracotta" />
            <span className="text-sm">{t("setPrimary")}</span>
          </label>
          {error && <p className="text-sm text-terracotta">{error}</p>}
          <button type="submit" disabled={saving || !name.trim()} className="w-full py-3.5 rounded-xl bg-terracotta text-white font-medium disabled:opacity-50 min-h-[44px]">
            {saving ? <span className="flex justify-center"><Spinner /></span> : t("saveChanges")}
          </button>
        </form>
      </SheetContent>
    </Overlay>
  );
}

// ── Biz data sheet ─────────────────────────────────────────────────────────

function BizSheet({
  lead,
  onSaved,
  onClose,
}: {
  lead: LeadData;
  onSaved: (patch: Partial<LeadData>) => void;
  onClose: () => void;
}) {
  const t = useTranslations("crm");
  const [address, setAddress] = useState(lead.address ?? "");
  const [zone, setZone] = useState(lead.zone ?? "");
  const [businessType, setBusinessType] = useState(lead.businessType ?? "");
  const [planProposed, setPlanProposed] = useState(lead.planProposed ?? "");
  const [unitsCount, setUnitsCount] = useState(String(lead.unitsCount ?? ""));
  const [source, setSource] = useState(lead.source ?? "");
  const [notes, setNotes] = useState(lead.notes ?? "");
  const [saving, setSaving] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    const patch = { address: address || null, zone: zone || null, businessType: businessType || null, planProposed: planProposed || null, unitsCount: unitsCount ? parseInt(unitsCount, 10) : null, source: source || null, notes: notes || null };
    const res = await fetch(`/api/crm/leads/${lead.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(patch) });
    if (res.ok) { onSaved(patch); } else { setSaving(false); }
  }

  return (
    <Overlay onClose={onClose}>
      <SheetContent>
        <SheetHandle />
        <SheetHeader title={t("editBizTitle")} onClose={onClose} />
        <form onSubmit={handleSubmit} className="px-4 py-4 space-y-4 overflow-y-auto">
          {[
            { label: t("fieldAddress"), val: address, set: setAddress },
            { label: t("fieldZone"), val: zone, set: setZone },
            { label: t("fieldBusinessType"), val: businessType, set: setBusinessType },
            { label: t("fieldPlanProposed"), val: planProposed, set: setPlanProposed },
            { label: t("fieldSource"), val: source, set: setSource },
          ].map(({ label, val, set }) => (
            <div key={label}>
              <FieldLabel>{label}</FieldLabel>
              <input type="text" value={val} onChange={(e) => set(e.target.value)}
                className="w-full px-3 py-2.5 rounded-xl border border-op-border bg-op-bg text-sm focus:outline-none focus:ring-1 focus:ring-terracotta min-h-[44px]" />
            </div>
          ))}
          <div>
            <FieldLabel>{t("fieldUnitsCount")}</FieldLabel>
            <input type="number" min="1" value={unitsCount} onChange={(e) => setUnitsCount(e.target.value)}
              className="w-full px-3 py-2.5 rounded-xl border border-op-border bg-op-bg text-sm focus:outline-none focus:ring-1 focus:ring-terracotta min-h-[44px]" />
          </div>
          <div>
            <FieldLabel>{t("fieldNotes")}</FieldLabel>
            <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={4}
              className="w-full px-3 py-2.5 rounded-xl border border-op-border bg-op-bg text-sm focus:outline-none focus:ring-1 focus:ring-terracotta resize-none" />
          </div>
          <button type="submit" disabled={saving} className="w-full py-3.5 rounded-xl bg-terracotta text-white font-medium disabled:opacity-50 min-h-[44px]">
            {saving ? <span className="flex justify-center"><Spinner /></span> : t("saveChanges")}
          </button>
        </form>
      </SheetContent>
    </Overlay>
  );
}

// ── Activity sheet ─────────────────────────────────────────────────────────

function ActivitySheet({
  leadId,
  userId,
  onSaved,
  onClose,
}: {
  leadId: string;
  userId: string;
  onSaved: (activity: ActivityData, nextActionAt?: string) => void;
  onClose: () => void;
}) {
  const t = useTranslations("crm");
  const [actType, setActType] = useState<"note" | "call" | "whatsapp" | "visit">("note");
  const [content, setContent] = useState("");
  const [nextDate, setNextDate] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const actTypes = [
    { value: "note" as const, label: t("actTypeNote") },
    { value: "call" as const, label: t("actTypeCall") },
    { value: "whatsapp" as const, label: t("actTypeWhatsapp") },
    { value: "visit" as const, label: t("actTypeVisit") },
  ];

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true); setError(null);
    try {
      const iso = nextDate ? new Date(nextDate + "T12:00:00.000Z").toISOString() : undefined;
      const res = await fetch(`/api/crm/leads/${leadId}/activities`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: actType, content: content.trim(), nextActionAt: iso }),
      });
      const json = await res.json();
      if (!res.ok) { setError(json.error ?? "error"); setSaving(false); return; }
      const newAct: ActivityData = {
        id: json.activity?.id ?? crypto.randomUUID(),
        type: actType, content: content.trim(), createdAt: new Date().toISOString(),
        user: { id: userId, name: null, email: "" },
      };
      onSaved(newAct, iso);
    } catch { setError("network_error"); setSaving(false); }
  }

  return (
    <Overlay onClose={onClose}>
      <SheetContent>
        <SheetHandle />
        <SheetHeader title={t("addActivityTitle")} onClose={onClose} />
        <form onSubmit={handleSubmit} className="px-4 py-4 space-y-4">
          <div className="flex gap-2 flex-wrap">
            {actTypes.map(({ value, label }) => (
              <button key={value} type="button" onClick={() => setActType(value)}
                className={"px-3 py-2 rounded-xl border text-sm font-medium min-h-[44px] transition-all " + (actType === value ? "bg-terracotta text-white border-terracotta" : "border-op-border text-op-muted hover:border-op-text")}>
                {label}
              </button>
            ))}
          </div>
          <div>
            <FieldLabel>{t("activityContent")}</FieldLabel>
            <textarea value={content} onChange={(e) => setContent(e.target.value)} rows={3}
              placeholder={t("activityPlaceholder")}
              className="w-full px-3 py-2.5 rounded-xl border border-op-border bg-op-bg text-sm focus:outline-none focus:ring-1 focus:ring-terracotta resize-none" />
          </div>
          <div>
            <FieldLabel>{t("nextActionDate")}</FieldLabel>
            <input type="date" value={nextDate} onChange={(e) => setNextDate(e.target.value)}
              className="w-full px-3 py-2.5 rounded-xl border border-op-border bg-op-bg text-sm focus:outline-none focus:ring-1 focus:ring-terracotta min-h-[44px]" />
          </div>
          {error && <p className="text-sm text-terracotta">{error}</p>}
          <button type="submit" disabled={saving} className="w-full py-3.5 rounded-xl bg-terracotta text-white font-medium disabled:opacity-50 min-h-[44px]">
            {saving ? <span className="flex justify-center"><Spinner /></span> : t("addActivitySubmit")}
          </button>
        </form>
      </SheetContent>
    </Overlay>
  );
}

// ── Reassign sheet ─────────────────────────────────────────────────────────

function ReassignSheet({
  lead,
  teamMembers,
  onSaved,
  onClose,
}: {
  lead: LeadData;
  teamMembers: TeamMember[];
  onSaved: (member: TeamMember) => void;
  onClose: () => void;
}) {
  const t = useTranslations("crm");
  const [targetId, setTargetId] = useState(lead.assignedTo?.id ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSave() {
    if (!targetId || targetId === lead.assignedTo?.id) { onClose(); return; }
    setSaving(true);
    const res = await fetch(`/api/crm/leads/${lead.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ assignedToUserId: targetId }),
    });
    if (res.ok) {
      const member = teamMembers.find((m) => m.id === targetId);
      if (member) onSaved(member);
    } else {
      setError(t("saveError")); setSaving(false);
    }
  }

  return (
    <Overlay onClose={onClose}>
      <SheetContent>
        <SheetHandle />
        <SheetHeader title={t("reassignTitle")} onClose={onClose} />
        <div className="px-4 py-4 space-y-3">
          {teamMembers.map((m) => (
            <button key={m.id} onClick={() => setTargetId(m.id)}
              className={"w-full flex items-center justify-between px-4 py-3 rounded-xl border-2 text-sm min-h-[44px] transition-all " + (targetId === m.id ? "border-terracotta bg-terracotta/5" : "border-op-border hover:border-op-text")}>
              <span className="font-medium">{m.name ?? m.email}</span>
              <span className="text-op-muted text-xs">{m.email}</span>
            </button>
          ))}
          {error && <p className="text-sm text-terracotta">{error}</p>}
          <button onClick={handleSave} disabled={saving} className="w-full py-3.5 rounded-xl bg-terracotta text-white font-medium disabled:opacity-50 min-h-[44px]">
            {saving ? <span className="flex justify-center"><Spinner /></span> : t("saveChanges")}
          </button>
        </div>
      </SheetContent>
    </Overlay>
  );
}

// ── Contact card ───────────────────────────────────────────────────────────

function ContactCard({
  contact,
  leadId,
  onEdit,
  t,
}: {
  contact: ContactData;
  leadId: string;
  onEdit: () => void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  t: (key: string) => any;
}) {
  function handleWhatsApp() {
    if (!contact.phone) return;
    fetch(`/api/crm/leads/${leadId}/activities`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "whatsapp", content: "WhatsApp tap" }),
    }).catch(() => {});
    window.open(waLink(contact.phone), "_blank", "noopener,noreferrer");
  }

  return (
    <div className="rounded-2xl border border-op-border bg-op-surface p-4 space-y-3">
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <div className="font-medium text-sm flex items-center gap-1.5">
            {contact.name}
            {contact.isPrimary && (
              <span className="font-mono text-[9px] tracking-wider uppercase bg-terracotta/10 text-terracotta px-1.5 py-0.5 rounded">
                {t("primaryBadge")}
              </span>
            )}
          </div>
          {contact.role && <div className="text-xs text-op-muted mt-0.5">{contact.role}</div>}
        </div>
        <button onClick={onEdit} className="text-xs text-op-muted hover:text-op-text min-h-[44px] px-2 flex items-center">{t("editBtn")}</button>
      </div>
      <div className="flex gap-2 flex-wrap">
        {contact.phone && (
          <button onClick={handleWhatsApp}
            className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-[#25D366]/10 text-[#128C7E] text-xs font-medium min-h-[44px] hover:bg-[#25D366]/20 transition-colors">
            <svg viewBox="0 0 24 24" fill="currentColor" className="w-4 h-4">
              <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413Z" />
            </svg>
            {t("whatsappLabel")}
          </button>
        )}
        {contact.phone && (
          <a href={`tel:${contact.phone}`}
            className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-op-bg border border-op-border text-xs font-medium min-h-[44px] hover:bg-op-surface transition-colors">
            <svg viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
              <path d="M2 3a1 1 0 011-1h2.153a1 1 0 01.986.836l.74 4.435a1 1 0 01-.54 1.06l-1.548.773a11.037 11.037 0 006.105 6.105l.774-1.548a1 1 0 011.059-.54l4.435.74a1 1 0 01.836.986V17a1 1 0 01-1 1h-2C7.82 18 2 12.18 2 5V3z" />
            </svg>
            {t("callLabel")}
          </a>
        )}
        {contact.email && (
          <a href={`mailto:${contact.email}`}
            className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-op-bg border border-op-border text-xs font-medium min-h-[44px] hover:bg-op-surface transition-colors">
            <svg viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
              <path d="M2.003 5.884L10 9.882l7.997-3.998A2 2 0 0016 4H4a2 2 0 00-1.997 1.884z" />
              <path d="M18 8.118l-8 4-8-4V14a2 2 0 002 2h12a2 2 0 002-2V8.118z" />
            </svg>
            {t("emailLabel")}
          </a>
        )}
      </div>
    </div>
  );
}

// ── Main component ─────────────────────────────────────────────────────────

export function CrmLeadDetailClient({
  lead: initialLead,
  contacts: initialContacts,
  activities: initialActivities,
  teamMembers,
  role,
  userId,
  countryCode,
  stageLabels,
}: {
  lead: LeadData;
  contacts: ContactData[];
  activities: ActivityData[];
  teamMembers: TeamMember[];
  role: string;
  userId: string;
  countryCode: string;
  stageLabels: Record<string, string>;
}) {
  const t = useTranslations("crm");
  const fmt = useFormatter();
  const [, startTransition] = useTransition();

  const [lead, setLead] = useState<LeadData>(initialLead);
  const [contacts, setContacts] = useState<ContactData[]>(initialContacts);
  const [activities, setActivities] = useState<ActivityData[]>(initialActivities);

  type SheetType = "stage" | "nextAction" | "addContact" | "editContact" | "editBiz" | "addActivity" | "reassign" | null;
  const [sheet, setSheet] = useState<SheetType>(null);
  const [editingContact, setEditingContact] = useState<ContactData | null>(null);

  function relTime(date: string | null): string {
    if (!date) return "";
    return fmt.relativeTime(new Date(date), new Date());
  }

  function isOverdue(date: string | null): boolean {
    if (!date) return false;
    return new Date(date) < new Date();
  }

  return (
    <div className="flex-1 flex flex-col">
      {/* ── Header ── */}
      <div className="px-4 pt-4 pb-3 border-b border-op-border">
        <Link href="/comercial/crm" className="inline-flex items-center gap-1.5 text-xs text-op-muted hover:text-op-text mb-3">
          <svg viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
            <path fillRule="evenodd" d="M9.707 16.707a1 1 0 01-1.414 0l-6-6a1 1 0 010-1.414l6-6a1 1 0 011.414 1.414L5.414 9H17a1 1 0 110 2H5.414l4.293 4.293a1 1 0 010 1.414z" clipRule="evenodd" />
          </svg>
          {t("backToPipeline")}
        </Link>
        <div className="flex items-start gap-3">
          <span className={"w-2.5 h-2.5 rounded-full shrink-0 mt-1.5 " + priorityDot(lead.priority)} aria-hidden />
          <div className="flex-1 min-w-0">
            <h1 className="font-display text-2xl leading-tight">{lead.name}</h1>
            <div className="flex items-center gap-2 mt-1 flex-wrap">
              {lead.city ? <span className="text-xs text-op-muted">{lead.city.name}</span> : <span className="text-xs text-op-muted">{lead.countryCode}</span>}
              <button onClick={() => setSheet("stage")}
                className={"font-mono text-[10px] tracking-wide uppercase px-2 py-0.5 rounded cursor-pointer hover:opacity-80 transition-opacity " + stageColor(lead.stage)}>
                {stageLabels[lead.stage] ?? lead.stage}
              </button>
              {lead.lostReason && <span className="text-xs text-rose-600">{"· " + lead.lostReason}</span>}
            </div>
          </div>
        </div>
        {/* Next action */}
        <div className="mt-3">
          <button onClick={() => setSheet("nextAction")}
            className={"flex items-center gap-2 px-3 py-2 rounded-xl border text-sm min-h-[44px] hover:border-terracotta transition-colors " + (lead.nextActionAt && isOverdue(lead.nextActionAt) ? "border-rose-300 bg-rose-50 text-rose-700" : "border-op-border text-op-muted")}>
            <svg viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4 shrink-0">
              <path fillRule="evenodd" d="M6 2a1 1 0 00-1 1v1H4a2 2 0 00-2 2v10a2 2 0 002 2h12a2 2 0 002-2V6a2 2 0 00-2-2h-1V3a1 1 0 10-2 0v1H7V3a1 1 0 00-1-1zm0 5a1 1 0 000 2h8a1 1 0 100-2H6z" clipRule="evenodd" />
            </svg>
            <span>{lead.nextActionAt ? `${t("nextAction")}: ${new Date(lead.nextActionAt).toLocaleDateString()}` : t("setNextAction")}</span>
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-6 pb-24">
        {/* ── Contacts ── */}
        <section>
          <div className="flex items-center justify-between mb-3">
            <div className="font-mono text-[10px] tracking-wider uppercase text-op-muted">{t("sectionContacts")}</div>
            <button onClick={() => { setEditingContact(null); setSheet("addContact"); }}
              className="text-xs text-terracotta hover:underline min-h-[44px] px-2 flex items-center">
              {"+ " + t("addContact")}
            </button>
          </div>
          {contacts.length === 0 ? <p className="text-sm text-op-muted">{t("noContacts")}</p> : (
            <div className="space-y-3">
              {contacts.map((c) => (
                <ContactCard key={c.id} contact={c} leadId={lead.id} t={t}
                  onEdit={() => { setEditingContact(c); setSheet("editContact"); }} />
              ))}
            </div>
          )}
        </section>

        {/* ── Business data ── */}
        <section>
          <div className="flex items-center justify-between mb-3">
            <div className="font-mono text-[10px] tracking-wider uppercase text-op-muted">{t("sectionBizData")}</div>
            <button onClick={() => setSheet("editBiz")} className="text-xs text-terracotta hover:underline min-h-[44px] px-2 flex items-center">{t("editBizBtn")}</button>
          </div>
          <div className="rounded-2xl border border-op-border bg-op-surface p-4 space-y-2.5 text-sm">
            {[
              { label: t("fieldAddress"), value: lead.address },
              { label: t("fieldZone"), value: lead.zone },
              { label: t("fieldBusinessType"), value: lead.businessType },
              { label: t("fieldPlanProposed"), value: lead.planProposed },
              { label: t("fieldUnitsCount"), value: lead.unitsCount?.toString() },
              { label: t("fieldSource"), value: lead.source },
              { label: t("fieldNotes"), value: lead.notes },
            ].map(({ label, value }) => value ? (
              <div key={label} className="flex gap-2">
                <span className="text-op-muted shrink-0 w-28">{label}</span>
                <span className="text-op-text break-words min-w-0">{value}</span>
              </div>
            ) : null)}
            {!lead.address && !lead.zone && !lead.businessType && !lead.planProposed && !lead.notes && (
              <p className="text-op-muted">{t("noBizData")}</p>
            )}
            <div className="flex gap-2 pt-1">
              <span className="text-op-muted w-28">{t("assignedTo")}</span>
              <span>{lead.assignedTo?.name ?? lead.assignedTo?.email ?? "—"}</span>
            </div>
          </div>
        </section>

        {/* ── Reassign (gerente/admin) ── */}
        {(role === "gerente_comercial" || role === "platform_admin") && teamMembers.length > 0 && (
          <section>
            <button onClick={() => setSheet("reassign")}
              className="w-full flex items-center justify-between px-4 py-3 rounded-xl border border-op-border hover:border-terracotta text-sm min-h-[44px] transition-colors">
              <span className="text-op-muted">{t("reassignBtn")}</span>
              <svg viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4 text-op-muted">
                <path fillRule="evenodd" d="M7.293 14.707a1 1 0 010-1.414L10.586 10 7.293 6.707a1 1 0 011.414-1.414l4 4a1 1 0 010 1.414l-4 4a1 1 0 01-1.414 0z" clipRule="evenodd" />
              </svg>
            </button>
          </section>
        )}

        {/* ── Timeline ── */}
        <section>
          <div className="font-mono text-[10px] tracking-wider uppercase text-op-muted mb-3">{t("sectionTimeline")}</div>
          {activities.length === 0 ? <p className="text-sm text-op-muted">{t("noActivities")}</p> : (
            <div className="space-y-3">
              {activities.map((a) => (
                <div key={a.id} className="flex gap-3">
                  <div className="mt-1 shrink-0">{activityIcon(a.type)}</div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm">{a.content || "—"}</p>
                    <p className="text-xs text-op-muted mt-0.5">{a.user.name ?? a.user.email} · {relTime(a.createdAt)}</p>
                  </div>
                </div>
              ))}
              {activities.length === 30 && <p className="text-xs text-op-muted text-center py-2">{t("activitiesMax30")}</p>}
            </div>
          )}
        </section>
      </div>

      {/* ── Sticky add activity ── */}
      <div className="fixed bottom-[calc(env(safe-area-inset-bottom,0px)+4.5rem)] left-0 right-0 px-4 lg:static lg:border-t lg:border-op-border lg:px-4 lg:py-3 z-20">
        <button onClick={() => setSheet("addActivity")}
          className="w-full py-3 rounded-xl bg-op-surface border border-terracotta text-terracotta text-sm font-medium min-h-[44px] hover:bg-terracotta hover:text-white transition-colors shadow-lg lg:shadow-none">
          {"+ " + t("addActivityBtn")}
        </button>
      </div>

      {/* ── Sheets ── */}
      {sheet === "stage" && (
        <StageSheet lead={lead} stageLabels={stageLabels}
          onClose={() => setSheet(null)}
          onSaved={(stage, lostReason) => {
            startTransition(() => {
              setLead((prev) => ({ ...prev, stage, lostReason: lostReason ?? prev.lostReason }));
              setSheet(null);
            });
          }} />
      )}
      {sheet === "nextAction" && (
        <NextActionSheet lead={lead}
          onClose={() => setSheet(null)}
          onSaved={(iso) => {
            startTransition(() => {
              setLead((prev) => ({ ...prev, nextActionAt: iso }));
              setSheet(null);
            });
          }} />
      )}
      {(sheet === "addContact" || sheet === "editContact") && (
        <ContactSheet leadId={lead.id} lead={lead} editingContact={editingContact} countryCode={countryCode}
          onClose={() => { setSheet(null); setEditingContact(null); }}
          onSaved={(newContacts) => {
            startTransition(() => {
              setContacts(newContacts);
              setSheet(null);
              setEditingContact(null);
            });
          }} />
      )}
      {sheet === "editBiz" && (
        <BizSheet lead={lead}
          onClose={() => setSheet(null)}
          onSaved={(patch) => {
            startTransition(() => {
              setLead((prev) => ({ ...prev, ...patch }));
              setSheet(null);
            });
          }} />
      )}
      {sheet === "addActivity" && (
        <ActivitySheet leadId={lead.id} userId={userId}
          onClose={() => setSheet(null)}
          onSaved={(activity, nextActionAt) => {
            startTransition(() => {
              setActivities((prev) => [activity, ...prev]);
              if (nextActionAt) setLead((prev) => ({ ...prev, nextActionAt }));
              setLead((prev) => ({ ...prev, lastActivityAt: new Date().toISOString() }));
              setSheet(null);
            });
          }} />
      )}
      {sheet === "reassign" && (
        <ReassignSheet lead={lead} teamMembers={teamMembers}
          onClose={() => setSheet(null)}
          onSaved={(member) => {
            startTransition(() => {
              setLead((prev) => ({ ...prev, assignedTo: { id: member.id, name: member.name, email: member.email } }));
              setSheet(null);
            });
          }} />
      )}
    </div>
  );
}
