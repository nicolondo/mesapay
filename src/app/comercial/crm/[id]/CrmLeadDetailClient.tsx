"use client";

import Link from "next/link";
import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useTranslations, useFormatter } from "next-intl";
import { CALLING_CODES } from "@/lib/crm/phone";
import { openWhatsApp } from "@/lib/crm/openWhatsApp";
import { renderTemplate } from "@/lib/crm/templateRender";

/** Abre el picker nativo al tocar cualquier parte de un input date/time
 *  (sin esto, Chrome desktop solo lo abre al hacer clic en el iconito). */
function openNativePicker(e: React.MouseEvent<HTMLInputElement>) {
  try {
    (e.currentTarget as HTMLInputElement & { showPicker?: () => void }).showPicker?.();
  } catch {
    // Algunos navegadores lanzan si no lo consideran un gesto válido —
    // el input sigue funcionando de forma normal.
  }
}

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
  unitNames: string[];
  notes: string | null;
  lostReason: string | null;
  nextActionAt: string | null;
  lastActivityAt: string | null;
  createdAt: string;
  restaurantId: string | null;
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

export type AppointmentData = {
  id: string;
  title: string;
  startsAt: string;
  endsAt: string;
  notes: string | null;
  status: string;
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

// Phone prefix select options (derived from authoritative CALLING_CODES)
const PHONE_PREFIX_OPTIONS = Object.entries(CALLING_CODES).map(([cc, code]) => ({
  cc,
  label: `+${code}`,
  digits: code,
}));

/** Detect the country code from a "+"-prefixed E.164 number, or fall back to defaultCc. */
function detectPrefixCc(phone: string, defaultCc: string): string {
  if (!phone.startsWith("+")) return defaultCc;
  const digits = phone.slice(1).replace(/\D/g, "");
  // Try longest match first (3-digit codes before 2-digit)
  const sorted = [...PHONE_PREFIX_OPTIONS].sort((a, b) => b.digits.length - a.digits.length);
  for (const opt of sorted) {
    if (digits.startsWith(opt.digits)) return opt.cc;
  }
  return defaultCc;
}

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
    <div className="fixed inset-0 z-50 flex flex-col justify-end lg:items-center lg:justify-center" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={onClose} aria-hidden="true" />
      {children}
    </div>
  );
}

function SheetContent({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="relative z-10 bg-op-surface rounded-t-2xl max-h-[90dvh] flex flex-col shadow-xl overflow-y-auto lg:rounded-2xl lg:max-w-lg lg:w-full lg:max-h-[85vh]"
      style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
    >
      {children}
    </div>
  );
}

function SheetHandle() {
  return (
    <div className="flex justify-center pt-3 pb-1 shrink-0 lg:hidden">
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
    // R2: "ganado" is only reachable via /convert — skip PATCH and hand off directly.
    if (selectedStage === "ganado") { onSaved("ganado"); return; }
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
              onClick={openNativePicker}
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
  // For edit mode: initialize with the full stored phone (including "+").
  // The select shows the detected country code; the input holds whatever the user types.
  // If the user types without "+", the selected code is prepended on submit.
  // If the user types with "+", it is sent as-is (server-side passthrough).
  const [phone, setPhone] = useState(editingContact?.phone ?? "");
  const [selectedPrefixCc, setSelectedPrefixCc] = useState<string>(() =>
    detectPrefixCc(editingContact?.phone ?? "", countryCode?.toUpperCase() ?? "CO"),
  );
  const [email, setEmail] = useState(editingContact?.email ?? "");
  const [isPrimary, setIsPrimary] = useState(editingContact?.isPrimary ?? false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectedPrefix = CALLING_CODES[selectedPrefixCc] ? `+${CALLING_CODES[selectedPrefixCc]}` : "";

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true); setError(null);
    const rawPhone = phone
      ? phone.startsWith("+")
        ? phone
        : selectedPrefix + phone.replace(/\D/g, "")
      : undefined;
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
              <select
                aria-label={t("phonePrefixLabel")}
                value={selectedPrefixCc}
                onChange={(e) => setSelectedPrefixCc(e.target.value)}
                className="font-mono text-sm text-op-muted border border-op-border rounded-xl px-2 py-2.5 bg-op-bg whitespace-nowrap min-h-[44px] focus:outline-none focus:ring-1 focus:ring-terracotta"
              >
                {PHONE_PREFIX_OPTIONS.map((opt) => (
                  <option key={opt.cc} value={opt.cc}>{opt.label}</option>
                ))}
              </select>
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
  // unitNames textarea: one name per line
  const [unitNamesText, setUnitNamesText] = useState(
    (lead.unitNames ?? []).join("\n"),
  );
  // unitsCount is manually editable only when list is empty
  const [unitsCount, setUnitsCount] = useState(String(lead.unitsCount ?? ""));
  const [source, setSource] = useState(lead.source ?? "");
  const [notes, setNotes] = useState(lead.notes ?? "");
  const [saving, setSaving] = useState(false);

  // Parse the textarea into a trimmed, non-empty array
  const parsedUnitNames = unitNamesText
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  const hasUnitNames = parsedUnitNames.length > 0;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    const patch: Partial<LeadData> & { unitNames?: string[] } = {
      address: address || null,
      zone: zone || null,
      businessType: businessType || null,
      planProposed: planProposed || null,
      source: source || null,
      notes: notes || null,
      unitNames: parsedUnitNames,
      // auto-count from list; if list empty, use manual value
      unitsCount: hasUnitNames
        ? parsedUnitNames.length
        : (unitsCount ? parseInt(unitsCount, 10) : null),
    };
    const res = await fetch(`/api/crm/leads/${lead.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    });
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
          {/* Restaurantes del grupo */}
          <div>
            <FieldLabel>{t("fieldUnitNames")}</FieldLabel>
            <textarea
              value={unitNamesText}
              onChange={(e) => setUnitNamesText(e.target.value)}
              rows={4}
              placeholder={"Carmen\nX.O\nMoshi\nDon Diablo"}
              className="w-full px-3 py-2.5 rounded-xl border border-op-border bg-op-bg text-sm focus:outline-none focus:ring-1 focus:ring-terracotta resize-none font-mono"
            />
          </div>
          {/* Número de restaurantes — disabled/auto when list present */}
          <div>
            <FieldLabel>{t("fieldUnitsCount")}</FieldLabel>
            <input
              type="number"
              min="1"
              value={hasUnitNames ? String(parsedUnitNames.length) : unitsCount}
              disabled={hasUnitNames}
              onChange={(e) => { if (!hasUnitNames) setUnitsCount(e.target.value); }}
              className={
                "w-full px-3 py-2.5 rounded-xl border border-op-border bg-op-bg text-sm focus:outline-none focus:ring-1 focus:ring-terracotta min-h-[44px] " +
                (hasUnitNames ? "opacity-50 cursor-not-allowed" : "")
              }
            />
            {hasUnitNames && (
              <p className="text-[10px] text-op-muted mt-1">{t("unitNamesHint")}</p>
            )}
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
  // Default: hoy (fecha local del navegador), editable.
  const [nextDate, setNextDate] = useState(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  });
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
              onClick={openNativePicker}
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

// ── Appointment sheet ──────────────────────────────────────────────────────

function AppointmentSheet({
  leadId,
  onSaved,
  onClose,
}: {
  leadId: string;
  onSaved: (appt: AppointmentData) => void;
  onClose: () => void;
}) {
  const t = useTranslations("crm");
  const [title, setTitle] = useState("");
  const [dateVal, setDateVal] = useState(() => {
    const d = new Date();
    return d.toISOString().slice(0, 10);
  });
  const [timeVal, setTimeVal] = useState(() => {
    const d = new Date();
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes() >= 30 ? 30 : 0).padStart(2, "0");
    return `${hh}:${mm}`;
  });
  const [durationMins, setDurationMins] = useState(60);
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSave() {
    if (!title.trim() || !dateVal || !timeVal) return;
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
        body: JSON.stringify({ leadId, title: title.trim(), startsAt, endsAt, notes: notes.trim() || undefined }),
      });
      const json = await res.json();
      if (!res.ok) { setError(t("saveError")); setSaving(false); return; }
      onSaved({
        id: json.appointment.id,
        title: json.appointment.title,
        startsAt: json.appointment.startsAt,
        endsAt: json.appointment.endsAt,
        notes: json.appointment.notes ?? null,
        status: json.appointment.status,
      });
    } catch {
      setError(t("saveError")); setSaving(false);
    }
  }

  return (
    <Overlay onClose={onClose}>
      <SheetContent>
        <SheetHandle />
        <SheetHeader title={t("appointNewTitle")} onClose={onClose} />
        <div className="px-4 py-4 space-y-4 overflow-y-auto">
          <div>
            <FieldLabel required>{t("appointFieldTitle")}</FieldLabel>
            <input type="text" required value={title} onChange={(e) => setTitle(e.target.value)}
              className="w-full px-3 py-2.5 rounded-xl border border-op-border bg-op-bg text-sm focus:outline-none focus:ring-1 focus:ring-terracotta min-h-[44px]" />
          </div>
          <div className="flex gap-3">
            <div className="flex-1">
              <FieldLabel required>{t("appointFieldDate")}</FieldLabel>
              <input type="date" required value={dateVal} onChange={(e) => setDateVal(e.target.value)}
                onClick={openNativePicker}
                className="w-full px-3 py-2.5 rounded-xl border border-op-border bg-op-bg text-sm focus:outline-none focus:ring-1 focus:ring-terracotta min-h-[44px]" />
            </div>
            <div className="flex-1">
              <FieldLabel required>{t("appointFieldTime")}</FieldLabel>
              <input type="time" required value={timeVal} onChange={(e) => setTimeVal(e.target.value)}
                onClick={openNativePicker}
                className="w-full px-3 py-2.5 rounded-xl border border-op-border bg-op-bg text-sm focus:outline-none focus:ring-1 focus:ring-terracotta min-h-[44px]" />
            </div>
          </div>
          <div>
            <FieldLabel>{t("appointFieldDuration")}</FieldLabel>
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
          <div>
            <FieldLabel>{t("appointFieldNotes")}</FieldLabel>
            <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2}
              className="w-full px-3 py-2.5 rounded-xl border border-op-border bg-op-bg text-sm focus:outline-none focus:ring-1 focus:ring-terracotta resize-none" />
          </div>
          {error && <p className="text-sm text-terracotta">{error}</p>}
          <button onClick={handleSave} disabled={saving || !title.trim() || !dateVal || !timeVal}
            className="w-full py-3.5 rounded-xl bg-terracotta text-white font-medium disabled:opacity-50 min-h-[44px]">
            {saving ? <span className="flex justify-center"><Spinner /></span> : t("appointSubmitCreate")}
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
  onTemplate,
  t,
}: {
  contact: ContactData;
  leadId: string;
  onEdit: () => void;
  onTemplate: () => void;
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
    openWhatsApp(contact.phone);
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
          {(contact.phone || contact.email) && (
            <div className="mt-1 space-y-0.5">
              {contact.phone && (
                <div className="text-xs text-op-text font-mono tracking-tight">{contact.phone}</div>
              )}
              {contact.email && (
                <div className="text-xs text-op-text break-all">{contact.email}</div>
              )}
            </div>
          )}
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
          <button onClick={onTemplate}
            className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-[#25D366]/10 text-[#128C7E] text-xs font-medium min-h-[44px] hover:bg-[#25D366]/20 transition-colors">
            <svg viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
              <path fillRule="evenodd" d="M10 2c-4.31 0-8 3.033-8 7 0 2.024.978 3.825 2.499 5.085a3.478 3.478 0 01-.522 1.756.75.75 0 00.584 1.143 5.976 5.976 0 003.936-1.108c.487.082.99.124 1.503.124 4.31 0 8-3.033 8-7s-3.69-7-8-7zm-4 5.75A.75.75 0 016.75 7h6.5a.75.75 0 010 1.5h-6.5A.75.75 0 016 7.75zm.75 2.25a.75.75 0 000 1.5h3.5a.75.75 0 000-1.5h-3.5z" clipRule="evenodd" />
            </svg>
            {t("waTemplateBtn")}
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

// ── WhatsApp template sheet ────────────────────────────────────────────────

type WaTemplate = { id: string; name: string; body: string };

function WhatsappSheet({
  lead,
  contact,
  userId,
  comercialName,
  onSent,
  onClose,
}: {
  lead: LeadData;
  contact: ContactData;
  userId: string;
  comercialName: string;
  onSent: (activity: ActivityData) => void;
  onClose: () => void;
}) {
  const t = useTranslations("crm");
  const [templates, setTemplates] = useState<WaTemplate[]>([]);
  const [loadingTemplates, setLoadingTemplates] = useState(true);
  const [templateId, setTemplateId] = useState("");
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);
  const didLoad = useRef(false);

  useEffect(() => {
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = ""; };
  }, []);

  useEffect(() => {
    if (didLoad.current) return;
    didLoad.current = true;
    fetch("/api/crm/whatsapp-templates")
      .then((r) => r.json())
      .then((j) => setTemplates(j.templates ?? []))
      .catch(() => {})
      .finally(() => setLoadingTemplates(false));
  }, []);

  function handleTemplateChange(id: string) {
    setTemplateId(id);
    const tpl = templates.find((x) => x.id === id);
    if (tpl) {
      setMessage(
        renderTemplate(tpl.body, {
          nombre: contact.name,
          comercio: lead.name,
          ciudad: lead.city?.name ?? "",
          comercial: comercialName,
        }),
      );
    }
  }

  async function handleOpen() {
    if (!contact.phone || !message.trim()) return;
    setSending(true);
    const tplName = templates.find((x) => x.id === templateId)?.name;
    // Activity content is stored data (Spanish by convention), not UI copy.
    const content = tplName
      ? `WhatsApp a ${contact.name} — plantilla "${tplName}"`
      : `WhatsApp a ${contact.name}`;
    let activityId: string | null = null;
    try {
      const res = await fetch(`/api/crm/leads/${lead.id}/activities`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "whatsapp", content }),
      });
      const json = await res.json().catch(() => ({}));
      activityId = json.activity?.id ?? null;
    } catch {
      // Logging is best-effort — still open WhatsApp.
    }
    openWhatsApp(contact.phone, message.trim());
    onSent({
      id: activityId ?? crypto.randomUUID(),
      type: "whatsapp",
      content,
      createdAt: new Date().toISOString(),
      user: { id: userId, name: comercialName || null, email: "" },
    });
  }

  return (
    <Overlay onClose={onClose}>
      <SheetContent>
        <SheetHandle />
        <SheetHeader title={t("waSendTitle")} onClose={onClose} />
        <div className="overflow-y-auto flex-1 px-4 py-4 space-y-4">
          <div className="rounded-xl border border-op-border bg-op-bg px-3 py-2.5">
            <div className="text-sm font-medium">{contact.name}</div>
            {contact.phone && (
              <div className="text-xs text-op-muted font-mono tracking-tight">{contact.phone}</div>
            )}
          </div>

          <div>
            <FieldLabel>{t("waSendTemplate")}</FieldLabel>
            {loadingTemplates ? (
              <div className="py-2"><Spinner /></div>
            ) : templates.length === 0 ? (
              <div className="space-y-1">
                <p className="text-sm text-op-muted">{t("waSendNoTemplates")}</p>
                <Link href="/comercial/mas/plantillas"
                  className="text-sm text-terracotta hover:underline min-h-[44px] inline-flex items-center">
                  {t("waSendManageTemplates")}
                </Link>
              </div>
            ) : (
              <select value={templateId} onChange={(e) => handleTemplateChange(e.target.value)}
                className="w-full px-3 py-2.5 rounded-xl border border-op-border bg-op-bg text-sm focus:outline-none focus:ring-1 focus:ring-terracotta min-h-[44px]">
                <option value="">{t("waSendChooseTemplate")}</option>
                {templates.map((tpl) => (
                  <option key={tpl.id} value={tpl.id}>{tpl.name}</option>
                ))}
              </select>
            )}
          </div>

          <div>
            <FieldLabel>{t("waSendMessageLabel")}</FieldLabel>
            <textarea value={message} onChange={(e) => setMessage(e.target.value)} rows={8}
              placeholder={t("waSendMessagePlaceholder")}
              className="w-full px-3 py-2.5 rounded-xl border border-op-border bg-op-bg text-sm focus:outline-none focus:ring-1 focus:ring-terracotta resize-y" />
          </div>

          <button onClick={handleOpen} disabled={sending || !message.trim() || !contact.phone}
            className="w-full py-3.5 rounded-xl bg-[#128C7E] text-white font-medium disabled:opacity-50 min-h-[44px] flex items-center justify-center gap-2">
            <svg viewBox="0 0 24 24" fill="currentColor" className="w-4 h-4">
              <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413Z" />
            </svg>
            {t("waSendOpenBtn")}
          </button>
        </div>
      </SheetContent>
    </Overlay>
  );
}

// ── Email sheet ────────────────────────────────────────────────────────────

type EmailTemplate = {
  id: string;
  name: string;
  subject: string;
  bodyHtml: string;
  attachmentIds: string[];
};

function EmailSheet({
  lead,
  contacts,
  onSent,
  onClose,
  hasEmailAccount,
}: {
  lead: LeadData;
  contacts: ContactData[];
  onSent: () => void;
  onClose: () => void;
  hasEmailAccount: boolean;
}) {
  const t = useTranslations("crm");
  const [templates, setTemplates] = useState<EmailTemplate[]>([]);
  const [loadingTemplates, setLoadingTemplates] = useState(true);

  const [templateId, setTemplateId] = useState("");
  const [subject, setSubject] = useState("");
  const [bodyHtml, setBodyHtml] = useState("");
  // Preselecciona el contacto principal (o el primero con email).
  const [contactId, setContactId] = useState(() => {
    const withEmail = contacts.filter((c) => c.email);
    return (withEmail.find((c) => c.isPrimary) ?? withEmail[0])?.id ?? "";
  });
  const [extraNote, setExtraNote] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const didLoad = useRef(false);

  useEffect(() => {
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = ""; };
  }, []);

  useEffect(() => {
    if (didLoad.current) return;
    didLoad.current = true;
    fetch("/api/crm/templates")
      .then((r) => r.json())
      .then((j) => setTemplates(j.templates ?? []))
      .catch(() => {})
      .finally(() => setLoadingTemplates(false));
  }, []);

  function handleTemplateChange(id: string) {
    setTemplateId(id);
    const tpl = templates.find((x) => x.id === id);
    if (tpl) {
      setSubject(tpl.subject);
      setBodyHtml(tpl.bodyHtml);
    }
  }

  const contactsWithEmail = contacts.filter((c) => c.email);

  // Rendered preview of subject with lead vars
  const subjectPreview = subject
    ? renderTemplate(subject, {
        nombre: contacts.find((c) => c.id === contactId)?.name ?? "",
        comercio: lead.name,
        ciudad: lead.city?.name ?? lead.countryCode ?? "",
        comercial: "",
      })
    : "";

  async function handleSend(e: React.FormEvent) {
    e.preventDefault();
    if (!contactId) return;
    setSending(true);
    setError(null);

    try {
      const body: Record<string, unknown> = { contactId };
      if (templateId) {
        body.templateId = templateId;
      } else {
        body.subject = subject;
        body.bodyHtml = bodyHtml;
      }
      if (extraNote.trim()) body.extraNote = extraNote.trim();

      const res = await fetch(`/api/crm/leads/${lead.id}/send-email`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (!res.ok) {
        if (json.error === "no_email_account" || json.error === "account_not_verified") {
          setError(t(json.error === "no_email_account" ? "sendEmailErrorNoAccount" : "sendEmailErrorNotVerified"));
        } else if (json.error === "smtp_failed") {
          setError(t("sendEmailSmtpFailed", { detail: json.detail ?? "SMTP error" }));
        } else {
          setError(t("sendEmailError", { detail: json.detail ?? json.error ?? "error" }));
        }
        setSending(false);
        return;
      }
      setSuccess(true);
      onSent();
    } catch {
      setError(t("sendEmailError", { detail: "network error" }));
      setSending(false);
    }
  }

  return (
    <Overlay onClose={onClose}>
      <SheetContent>
        <SheetHandle />
        <SheetHeader title={t("sendEmailTitle")} onClose={onClose} />
        {!hasEmailAccount ? (
          <div className="px-4 py-6 space-y-4">
            <p className="text-sm text-op-muted">{t("sendEmailErrorNoAccount")}</p>
            <Link
              href="/comercial/mas/correo"
              className="block w-full py-3.5 rounded-xl bg-terracotta text-white text-sm font-medium text-center min-h-[44px]"
            >
              {t("sendEmailNoAccountCta")}
            </Link>
          </div>
        ) : success ? (
          <div className="px-4 py-6">
            <p className="text-sm text-green-600">{t("sendEmailSuccess")}</p>
          </div>
        ) : (
          <form onSubmit={handleSend} className="overflow-y-auto flex-1 px-4 py-4 space-y-4">
            {/* Contact selector */}
            <div>
              <FieldLabel required>{t("sendEmailContact")}</FieldLabel>
              {contactsWithEmail.length === 0 ? (
                <p className="text-sm text-op-muted">{t("sendEmailErrorNoContactEmail")}</p>
              ) : (
                <select
                  required
                  value={contactId}
                  onChange={(e) => setContactId(e.target.value)}
                  className="w-full px-3 py-2.5 rounded-xl border border-op-border bg-op-bg text-sm focus:outline-none focus:ring-1 focus:ring-terracotta min-h-[44px]"
                >
                  <option value={""}>{t("sendEmailChooseContact")}</option>
                  {contactsWithEmail.map((c) => (
                    <option key={c.id} value={c.id}>{c.name} — {c.email}</option>
                  ))}
                </select>
              )}
            </div>

            {/* Template selector */}
            {!loadingTemplates && (
              <div>
                <FieldLabel>{t("sendEmailSelectTemplate")}</FieldLabel>
                <select
                  value={templateId}
                  onChange={(e) => handleTemplateChange(e.target.value)}
                  className="w-full px-3 py-2.5 rounded-xl border border-op-border bg-op-bg text-sm focus:outline-none focus:ring-1 focus:ring-terracotta min-h-[44px]"
                >
                  <option value={""}>{t("sendEmailChooseTemplate")}</option>
                  {templates.map((tpl) => (
                    <option key={tpl.id} value={tpl.id}>{tpl.name}</option>
                  ))}
                </select>
              </div>
            )}

            {/* Manual compose (if no template) */}
            {!templateId && (
              <>
                <div>
                  <FieldLabel required>{t("templateFieldSubject")}</FieldLabel>
                  <input type="text" required value={subject} onChange={(e) => setSubject(e.target.value)}
                    className="w-full px-3 py-2.5 rounded-xl border border-op-border bg-op-bg text-sm focus:outline-none focus:ring-1 focus:ring-terracotta min-h-[44px]" />
                </div>
                <div>
                  <FieldLabel required>{t("templateFieldBody")}</FieldLabel>
                  <textarea required value={bodyHtml} onChange={(e) => setBodyHtml(e.target.value)} rows={5}
                    className="w-full px-3 py-2.5 rounded-xl border border-op-border bg-op-bg text-sm focus:outline-none focus:ring-1 focus:ring-terracotta resize-none font-mono" />
                </div>
              </>
            )}

            {/* Subject preview when template selected */}
            {templateId && subjectPreview && (
              <div className="px-3 py-2 rounded-xl bg-op-bg border border-op-border">
                <div className="font-mono text-[10px] tracking-wider uppercase text-op-muted mb-0.5">{t("sendEmailSubjectPreview")}</div>
                <div className="text-sm">{subjectPreview}</div>
              </div>
            )}

            {/* Extra note */}
            <div>
              <FieldLabel>{t("sendEmailExtraNote")}</FieldLabel>
              <textarea value={extraNote} onChange={(e) => setExtraNote(e.target.value)} rows={2}
                className="w-full px-3 py-2.5 rounded-xl border border-op-border bg-op-bg text-sm focus:outline-none focus:ring-1 focus:ring-terracotta resize-none" />
            </div>

            {error && <p className="text-sm text-terracotta">{error}</p>}

            <button
              type="submit"
              disabled={sending || !contactId || contactsWithEmail.length === 0}
              className="w-full py-3.5 rounded-xl bg-terracotta text-white font-medium disabled:opacity-50 min-h-[44px]"
            >
              {sending ? t("sendEmailSending") : t("sendEmailSubmit")}
            </button>
          </form>
        )}
      </SheetContent>
    </Overlay>
  );
}

// ── Convert sheet ──────────────────────────────────────────────────────────

function ConvertSheet({
  lead,
  role,
  onConverted,
  onClose,
}: {
  lead: LeadData;
  role: string;
  onConverted: (restaurantId: string) => void;
  onClose: () => void;
}) {
  const t = useTranslations("crm");

  // Suggest a slug from name.
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
        <SheetHeader title={t("convertTitle")} onClose={onClose} />
        {success ? (
          <div className="px-4 py-6 space-y-4">
            <p className="text-sm text-green-600 font-medium">{t("convertSuccess")}</p>
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

// ── Main component ─────────────────────────────────────────────────────────

export function CrmLeadDetailClient({
  lead: initialLead,
  contacts: initialContacts,
  activities: initialActivities,
  appointments: initialAppointments,
  teamMembers,
  role,
  userId,
  countryCode,
  currentUserName,
  stageLabels,
  hasEmailAccount,
}: {
  lead: LeadData;
  contacts: ContactData[];
  activities: ActivityData[];
  appointments: AppointmentData[];
  teamMembers: TeamMember[];
  role: string;
  userId: string;
  countryCode: string;
  currentUserName: string;
  stageLabels: Record<string, string>;
  hasEmailAccount: boolean;
}) {
  const t = useTranslations("crm");
  const fmt = useFormatter();
  const [, startTransition] = useTransition();
  const router = useRouter();

  const [lead, setLead] = useState<LeadData>(initialLead);
  const [contacts, setContacts] = useState<ContactData[]>(initialContacts);
  const [activities, setActivities] = useState<ActivityData[]>(initialActivities);
  const [appointments, setAppointments] = useState<AppointmentData[]>(initialAppointments);

  type SheetType = "stage" | "nextAction" | "addContact" | "editContact" | "editBiz" | "addActivity" | "reassign" | "addAppointment" | "email" | "whatsapp" | "convert" | null;
  const [sheet, setSheet] = useState<SheetType>(null);
  const [editingContact, setEditingContact] = useState<ContactData | null>(null);
  const [waContact, setWaContact] = useState<ContactData | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  function relTime(date: string | null): string {
    if (!date) return "";
    return fmt.relativeTime(new Date(date), new Date());
  }

  function isOverdue(date: string | null): boolean {
    if (!date) return false;
    return new Date(date) < new Date();
  }

  async function handleDelete() {
    const confirmed = window.confirm(t("deleteLeadConfirm", { name: lead.name }));
    if (!confirmed) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      const res = await fetch(`/api/crm/leads/${lead.id}`, { method: "DELETE" });
      if (res.ok) {
        router.push("/comercial/crm");
        return;
      }
      const json = await res.json().catch(() => ({}));
      if (res.status === 409 || json.error === "converted_lead") {
        setDeleteError(t("deleteLeadConverted"));
      } else {
        setDeleteError(t("deleteLeadError"));
      }
    } catch {
      setDeleteError(t("deleteLeadError"));
    } finally {
      setDeleting(false);
    }
  }

  // ── Shared section render helpers ─────────────────────────────────────────

  function renderContacts() {
    return (
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
                onEdit={() => { setEditingContact(c); setSheet("editContact"); }}
                onTemplate={() => { setWaContact(c); setSheet("whatsapp"); }} />
            ))}
          </div>
        )}
      </section>
    );
  }

  function renderTimeline() {
    return (
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
    );
  }

  function renderNextAction() {
    return (
      <section>
        <div className="font-mono text-[10px] tracking-wider uppercase text-op-muted mb-3">{t("nextAction")}</div>
        <button onClick={() => setSheet("nextAction")}
          className={"flex items-center gap-2 px-3 py-2 rounded-xl border text-sm min-h-[44px] hover:border-terracotta transition-colors w-full " + (lead.nextActionAt && isOverdue(lead.nextActionAt) ? "border-rose-300 bg-rose-50 text-rose-700" : "border-op-border text-op-muted")}>
          <svg viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4 shrink-0">
            <path fillRule="evenodd" d="M6 2a1 1 0 00-1 1v1H4a2 2 0 00-2 2v10a2 2 0 002 2h12a2 2 0 002-2V6a2 2 0 00-2-2h-1V3a1 1 0 10-2 0v1H7V3a1 1 0 00-1-1zm0 5a1 1 0 000 2h8a1 1 0 100-2H6z" clipRule="evenodd" />
          </svg>
          <span>{lead.nextActionAt ? `${new Date(lead.nextActionAt).toLocaleDateString()}` : t("setNextAction")}</span>
        </button>
      </section>
    );
  }

  function renderBizData() {
    return (
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
            { label: t("fieldSource"), value: lead.source },
            { label: t("fieldNotes"), value: lead.notes },
          ].map(({ label, value }) => value ? (
            <div key={label} className="flex gap-2">
              <span className="text-op-muted shrink-0 w-28">{label}</span>
              <span className="text-op-text break-words min-w-0">{value}</span>
            </div>
          ) : null)}
          {(lead.unitNames ?? []).length > 0 ? (
            <div className="flex gap-2">
              <span className="text-op-muted shrink-0 w-28">{t("unitNamesChipsLabel")}</span>
              <div className="flex flex-wrap gap-1 min-w-0">
                {(lead.unitNames ?? []).map((name) => (
                  <span
                    key={name}
                    className="font-mono text-[10px] bg-slate-100 text-slate-700 px-2 py-0.5 rounded-full whitespace-nowrap"
                  >
                    {name}
                  </span>
                ))}
              </div>
            </div>
          ) : lead.unitsCount ? (
            <div className="flex gap-2">
              <span className="text-op-muted shrink-0 w-28">{t("fieldUnitsCount")}</span>
              <span className="text-op-text">{lead.unitsCount}</span>
            </div>
          ) : null}
          {!lead.address && !lead.zone && !lead.businessType && !lead.planProposed && !lead.notes && (lead.unitNames ?? []).length === 0 && !lead.unitsCount && (
            <p className="text-op-muted">{t("noBizData")}</p>
          )}
          <div className="flex gap-2 pt-1">
            <span className="text-op-muted w-28">{t("assignedTo")}</span>
            <span>{lead.assignedTo?.name ?? lead.assignedTo?.email ?? "—"}</span>
          </div>
        </div>
      </section>
    );
  }

  function renderAppointments() {
    return (
      <section>
        <div className="flex items-center justify-between mb-3">
          <div className="font-mono text-[10px] tracking-wider uppercase text-op-muted">{t("appointSectionTitle")}</div>
          <button onClick={() => setSheet("addAppointment")}
            className="text-xs text-terracotta hover:underline min-h-[44px] px-2 flex items-center">
            {"+ " + t("appointNewTitle")}
          </button>
        </div>
        {appointments.length === 0 ? (
          <p className="text-sm text-op-muted">{t("appointNoUpcoming")}</p>
        ) : (
          <div className="space-y-2">
            {appointments.map((appt) => {
              const starts = new Date(appt.startsAt);
              const b = new Date(starts.getTime() - 5 * 60 * 60 * 1000);
              const hh = String(b.getUTCHours()).padStart(2, "0");
              const mm = String(b.getUTCMinutes()).padStart(2, "0");
              const timeStr = `${hh}:${mm}`;
              const dateStr = starts.toLocaleDateString();
              const statusColors: Record<string, string> = {
                scheduled: "bg-violet-100 text-violet-700",
                done: "bg-green-100 text-green-700",
                cancelled: "bg-rose-100 text-rose-600",
              };
              const statusLabels: Record<string, string> = {
                scheduled: t("appointStatusScheduled"),
                done: t("appointStatusDone"),
                cancelled: t("appointStatusCancelled"),
              };
              return (
                <div key={appt.id} className="rounded-xl border border-op-border bg-op-surface p-3 flex items-center gap-3">
                  <div className="font-mono text-xs text-op-muted shrink-0 text-center">
                    <div>{timeStr}</div>
                    <div className="text-[10px]">{dateStr}</div>
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium truncate">{appt.title}</div>
                    {appt.notes && <div className="text-xs text-op-muted truncate">{appt.notes}</div>}
                  </div>
                  <span className={"font-mono text-[9px] tracking-wide uppercase px-1.5 py-0.5 rounded shrink-0 " + (statusColors[appt.status] ?? "bg-op-bg text-op-muted")}>
                    {statusLabels[appt.status] ?? appt.status}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </section>
    );
  }

  function renderReassign() {
    if (!(role === "gerente_comercial" || role === "platform_admin") || teamMembers.length === 0) return null;
    return (
      <section>
        <button onClick={() => setSheet("reassign")}
          className="w-full flex items-center justify-between px-4 py-3 rounded-xl border border-op-border hover:border-terracotta text-sm min-h-[44px] transition-colors">
          <span className="text-op-muted">{t("reassignBtn")}</span>
          <svg viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4 text-op-muted">
            <path fillRule="evenodd" d="M7.293 14.707a1 1 0 010-1.414L10.586 10 7.293 6.707a1 1 0 011.414-1.414l4 4a1 1 0 010 1.414l-4 4a1 1 0 01-1.414 0z" clipRule="evenodd" />
          </svg>
        </button>
      </section>
    );
  }

  function renderDanger() {
    if (lead.restaurantId || lead.stage === "ganado") return null;
    return (
      <section className="pt-4 border-t border-op-border">
        {deleteError && (
          <p className="text-sm text-rose-600 mb-3">{deleteError}</p>
        )}
        <button
          onClick={handleDelete}
          disabled={deleting}
          className="w-full py-3.5 rounded-xl border border-rose-200 text-rose-600 text-sm font-medium min-h-[44px] hover:bg-rose-50 transition-colors disabled:opacity-50"
        >
          {deleting ? <span className="flex justify-center"><Spinner /></span> : t("deleteLeadBtn")}
        </button>
      </section>
    );
  }

  function renderActivityComposer() {
    return (
      <div className="flex gap-2">
        <button onClick={() => setSheet("addActivity")}
          className="flex-1 py-3 rounded-xl bg-op-surface border border-terracotta text-terracotta text-sm font-medium min-h-[44px] hover:bg-terracotta hover:text-white transition-colors shadow-lg lg:shadow-none">
          {"+ " + t("addActivityBtn")}
        </button>
        <button onClick={() => setSheet("email")}
          className="py-3 px-4 rounded-xl bg-op-surface border border-op-border text-op-muted text-sm font-medium min-h-[44px] hover:border-terracotta hover:text-terracotta transition-colors shadow-lg lg:shadow-none"
          title={t("sendEmailBtn")}
        >
          <svg viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
            <path d="M2.003 5.884L10 9.882l7.997-3.998A2 2 0 0016 4H4a2 2 0 00-1.997 1.884z" />
            <path d="M18 8.118l-8 4-8-4V14a2 2 0 002 2h12a2 2 0 002-2V8.118z" />
          </svg>
        </button>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col lg:max-w-6xl lg:mx-auto lg:w-full">
      {/* ── Header (shared mobile + desktop) ── */}
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
              <button onClick={() => lead.restaurantId ? undefined : setSheet("stage")}
                className={"font-mono text-[10px] tracking-wide uppercase px-2 py-0.5 rounded transition-opacity " + stageColor(lead.stage) + (lead.restaurantId ? " cursor-default" : " cursor-pointer hover:opacity-80")}>
                {lead.restaurantId ? t("convertBadge") : (stageLabels[lead.stage] ?? lead.stage)}
              </button>
              {lead.lostReason && <span className="text-xs text-rose-600">{"· " + lead.lostReason}</span>}
            </div>
          </div>
        </div>
        {/* Next action (mobile only — desktop sidebar has it) */}
        <div className="mt-3 lg:hidden">
          <button onClick={() => setSheet("nextAction")}
            className={"flex items-center gap-2 px-3 py-2 rounded-xl border text-sm min-h-[44px] hover:border-terracotta transition-colors " + (lead.nextActionAt && isOverdue(lead.nextActionAt) ? "border-rose-300 bg-rose-50 text-rose-700" : "border-op-border text-op-muted")}>
            <svg viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4 shrink-0">
              <path fillRule="evenodd" d="M6 2a1 1 0 00-1 1v1H4a2 2 0 00-2 2v10a2 2 0 002 2h12a2 2 0 002-2V6a2 2 0 00-2-2h-1V3a1 1 0 10-2 0v1H7V3a1 1 0 00-1-1zm0 5a1 1 0 000 2h8a1 1 0 100-2H6z" clipRule="evenodd" />
            </svg>
            <span>{lead.nextActionAt ? `${t("nextAction")}: ${new Date(lead.nextActionAt).toLocaleDateString()}` : t("setNextAction")}</span>
          </button>
        </div>
      </div>

      {/* ── MOBILE: single-column layout (<lg) ── */}
      <div className="lg:hidden flex-1 overflow-y-auto px-4 py-4 space-y-6 pb-24">
        {renderContacts()}
        {renderBizData()}
        {renderReassign()}
        {renderAppointments()}
        {renderTimeline()}
        {renderDanger()}
      </div>

      {/* ── DESKTOP: two-column layout (lg+) ── */}
      <div className="hidden lg:grid lg:grid-cols-3 lg:gap-6 lg:flex-1 px-6 py-6 pb-8">
        {/* Left col: col-span-2 — contacts + timeline + activity composer */}
        <div className="lg:col-span-2 space-y-6">
          {renderContacts()}
          {renderTimeline()}
          <div className="border-t border-op-border pt-4">
            {renderActivityComposer()}
          </div>
        </div>
        {/* Right col: col-span-1 — sticky sidebar */}
        <div className="lg:col-span-1 space-y-6 lg:sticky lg:top-20 lg:self-start">
          {renderNextAction()}
          {renderBizData()}
          {renderAppointments()}
          {renderReassign()}
          {renderDanger()}
        </div>
      </div>

      {/* ── Sticky add activity + send email (mobile only) ── */}
      <div className="fixed bottom-[calc(env(safe-area-inset-bottom,0px)+4.5rem)] left-0 right-0 px-4 z-20 flex gap-2 lg:hidden">
        <button onClick={() => setSheet("addActivity")}
          className="flex-1 py-3 rounded-xl bg-op-surface border border-terracotta text-terracotta text-sm font-medium min-h-[44px] hover:bg-terracotta hover:text-white transition-colors shadow-lg">
          {"+ " + t("addActivityBtn")}
        </button>
        <button onClick={() => setSheet("email")}
          className="py-3 px-4 rounded-xl bg-op-surface border border-op-border text-op-muted text-sm font-medium min-h-[44px] hover:border-terracotta hover:text-terracotta transition-colors shadow-lg"
          title={t("sendEmailBtn")}
        >
          <svg viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
            <path d="M2.003 5.884L10 9.882l7.997-3.998A2 2 0 0016 4H4a2 2 0 00-1.997 1.884z" />
            <path d="M18 8.118l-8 4-8-4V14a2 2 0 002 2h12a2 2 0 002-2V8.118z" />
          </svg>
        </button>
      </div>

      {/* ── Sheets ── */}
      {sheet === "stage" && (
        <StageSheet lead={lead} stageLabels={stageLabels}
          onClose={() => setSheet(null)}
          onSaved={(stage, lostReason) => {
            startTransition(() => {
              setLead((prev) => ({ ...prev, stage, lostReason: lostReason ?? prev.lostReason }));
              // When moving to "ganado", open the convert sheet.
              if (stage === "ganado" && !lead.restaurantId) {
                setSheet("convert");
              } else {
                setSheet(null);
              }
            });
            router.refresh();
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
            router.refresh();
          }} />
      )}
      {sheet === "addAppointment" && (
        <AppointmentSheet leadId={lead.id}
          onClose={() => setSheet(null)}
          onSaved={(appt) => {
            startTransition(() => {
              setAppointments((prev) => [appt, ...prev].sort(
                (a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime(),
              ));
              setSheet(null);
            });
          }} />
      )}
      {sheet === "email" && (
        <EmailSheet
          lead={lead}
          contacts={contacts}
          hasEmailAccount={hasEmailAccount}
          onClose={() => setSheet(null)}
          onSent={() => {
            startTransition(() => {
              setLead((prev) => ({ ...prev, lastActivityAt: new Date().toISOString() }));
              setSheet(null);
            });
          }}
        />
      )}
      {sheet === "whatsapp" && waContact && (
        <WhatsappSheet
          lead={lead}
          contact={waContact}
          userId={userId}
          comercialName={currentUserName}
          onClose={() => { setSheet(null); setWaContact(null); }}
          onSent={(activity) => {
            startTransition(() => {
              setActivities((prev) => [activity, ...prev]);
              setLead((prev) => ({ ...prev, lastActivityAt: new Date().toISOString() }));
              setSheet(null);
              setWaContact(null);
            });
          }}
        />
      )}
      {sheet === "convert" && (
        <ConvertSheet
          lead={lead}
          role={role}
          onClose={() => setSheet(null)}
          onConverted={(restaurantId) => {
            startTransition(() => {
              setLead((prev) => ({ ...prev, restaurantId, stage: "ganado" }));
              // Keep sheet open to show success + admin link — sheet closes itself.
            });
            router.refresh();
          }}
        />
      )}
    </div>
  );
}
