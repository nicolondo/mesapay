"use client";

import Link from "next/link";
import { useState } from "react";
import { useTranslations } from "next-intl";
import { openWhatsApp } from "@/lib/crm/openWhatsApp";

// ── Types ──────────────────────────────────────────────────────────────────

export type HoyLead = {
  id: string;
  name: string;
  stage: string;
  priority: string;
  lastActivityAt: Date | string | null;
  nextActionAt: Date | string | null;
  createdAt: Date | string;
  city: { id: string; name: string } | null;
  contacts: { id: string; name: string; phone: string | null }[];
};

export type HoyAppointment = {
  id: string;
  title: string;
  startsAt: Date | string;
  endsAt: Date | string;
  status: string;
  lead: { id: string; name: string } | null;
  user: { id: string; name: string | null; email: string };
};

// ── Helpers ────────────────────────────────────────────────────────────────

function priorityDot(priority: string): string {
  return priority === "a"
    ? "bg-rose-500"
    : priority === "b"
      ? "bg-amber-400"
      : "bg-slate-300";
}

function daysSince(date: Date | string | null): number {
  if (!date) return 0;
  const d = typeof date === "string" ? new Date(date) : date;
  return Math.floor((Date.now() - d.getTime()) / (1000 * 60 * 60 * 24));
}

function daysUntil(date: Date | string | null): number {
  if (!date) return 0;
  const d = typeof date === "string" ? new Date(date) : date;
  return Math.floor((d.getTime() - Date.now()) / (1000 * 60 * 60 * 24));
}

function formatHhmm(date: Date | string): string {
  const d = typeof date === "string" ? new Date(date) : date;
  // Bogota is UTC-5
  const bogota = new Date(d.getTime() - 5 * 60 * 60 * 1000);
  const hh = String(bogota.getUTCHours()).padStart(2, "0");
  const mm = String(bogota.getUTCMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

// ── Collapsible section ────────────────────────────────────────────────────

const SHOW_INITIAL = 5;

function BandejaSection({
  titleKey,
  count,
  children,
  defaultOpen = true,
}: {
  titleKey: string;
  count: number;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const t = useTranslations("crm");
  const [open, setOpen] = useState(defaultOpen);
  const [showAll, setShowAll] = useState(false);

  const hasMore = count > SHOW_INITIAL;

  return (
    <div className="rounded-2xl border border-op-border bg-op-surface overflow-hidden">
      {/* Header */}
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between px-4 py-3 min-h-[44px] hover:bg-op-bg transition-colors"
      >
        <div className="flex items-center gap-2">
          <span className="font-mono text-[10px] tracking-wider uppercase text-op-text font-semibold">
            {t(titleKey as Parameters<typeof t>[0])}
          </span>
          {count > 0 && (
            <span className="font-mono text-xs bg-terracotta text-white rounded-full px-1.5 py-0.5 min-w-[20px] text-center leading-none">
              {count}
            </span>
          )}
        </div>
        <svg
          viewBox="0 0 20 20"
          fill="currentColor"
          className={
            "w-4 h-4 text-op-muted transition-transform " +
            (open ? "rotate-180" : "")
          }
        >
          <path
            fillRule="evenodd"
            d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z"
            clipRule="evenodd"
          />
        </svg>
      </button>

      {open && (
        <div className="divide-y divide-op-border">
          {children}

          {hasMore && !showAll && (
            <button
              onClick={() => setShowAll(true)}
              className="w-full py-3 text-xs text-op-muted hover:text-op-text min-h-[44px] flex items-center justify-center"
            >
              {t("hoyShowAll", { count })}
            </button>
          )}
          {showAll && hasMore && (
            <button
              onClick={() => setShowAll(false)}
              className="w-full py-3 text-xs text-op-muted hover:text-op-text min-h-[44px] flex items-center justify-center"
            >
              {t("hoyShowLess")}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ── Lead card (compact) ────────────────────────────────────────────────────

function LeadCard({
  lead,
  subtext,
  subtextVariant = "normal",
}: {
  lead: HoyLead;
  subtext: string;
  subtextVariant?: "normal" | "warning" | "danger";
}) {
  const primaryContact = lead.contacts[0] ?? null;

  const subColors = {
    normal: "text-op-muted",
    warning: "text-amber-600",
    danger: "text-rose-600",
  };

  function handleWhatsApp(e: React.MouseEvent) {
    e.preventDefault();
    if (!primaryContact?.phone) return;
    fetch(`/api/crm/leads/${lead.id}/activities`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "whatsapp", content: "WhatsApp tap" }),
    }).catch(() => {});
    openWhatsApp(primaryContact.phone);
  }

  return (
    <div className="px-4 py-3 flex items-center gap-3">
      {/* Priority dot */}
      <span
        className={"w-2 h-2 rounded-full shrink-0 mt-0.5 " + priorityDot(lead.priority)}
        aria-hidden
      />
      <div className="flex-1 min-w-0">
        <Link
          href={`/comercial/crm/${lead.id}`}
          className="font-medium text-sm hover:text-terracotta truncate block"
        >
          {lead.name}
        </Link>
        <div className="flex items-center gap-2 mt-0.5">
          {lead.city && (
            <span className="text-xs text-op-muted">{lead.city.name}</span>
          )}
          <span className={"text-xs " + subColors[subtextVariant]}>
            {subtext}
          </span>
        </div>
      </div>
      {/* Actions */}
      <div className="flex gap-1.5 shrink-0">
        {primaryContact?.phone && (
          <button
            onClick={handleWhatsApp}
            aria-label="WhatsApp"
            className="w-9 h-9 rounded-xl bg-[#25D366]/10 text-[#128C7E] flex items-center justify-center hover:bg-[#25D366]/20 transition-colors min-w-[44px] min-h-[44px]"
          >
            <svg viewBox="0 0 24 24" fill="currentColor" className="w-4 h-4">
              <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413Z" />
            </svg>
          </button>
        )}
        {primaryContact?.phone && (
          <a
            href={`tel:${primaryContact.phone}`}
            aria-label="Call"
            className="w-9 h-9 rounded-xl bg-op-bg border border-op-border flex items-center justify-center hover:bg-op-surface transition-colors min-w-[44px] min-h-[44px]"
          >
            <svg viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
              <path d="M2 3a1 1 0 011-1h2.153a1 1 0 01.986.836l.74 4.435a1 1 0 01-.54 1.06l-1.548.773a11.037 11.037 0 006.105 6.105l.774-1.548a1 1 0 011.059-.54l4.435.74a1 1 0 01.836.986V17a1 1 0 01-1 1h-2C7.82 18 2 12.18 2 5V3z" />
            </svg>
          </a>
        )}
      </div>
    </div>
  );
}

// ── Appointment card ───────────────────────────────────────────────────────

function AppointmentCard({ appt }: { appt: HoyAppointment }) {
  const timeStr = formatHhmm(appt.startsAt);

  return (
    <div className="px-4 py-3 flex items-center gap-3">
      <div className="w-10 h-10 rounded-xl bg-violet-100 text-violet-700 flex items-center justify-center shrink-0 font-mono text-xs font-semibold">
        {timeStr}
      </div>
      <div className="flex-1 min-w-0">
        <div className="font-medium text-sm truncate">{appt.title}</div>
        {appt.lead && (
          <Link
            href={`/comercial/crm/${appt.lead.id}`}
            className="text-xs text-op-muted hover:text-terracotta"
          >
            {appt.lead.name}
          </Link>
        )}
      </div>
      {appt.lead && (
        <Link
          href={`/comercial/crm/${appt.lead.id}`}
          aria-label="Open lead"
          className="text-xs text-terracotta hover:underline shrink-0 min-h-[44px] flex items-center px-2"
        >
          <svg viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
            <path
              fillRule="evenodd"
              d="M7.293 14.707a1 1 0 010-1.414L10.586 10 7.293 6.707a1 1 0 011.414-1.414l4 4a1 1 0 010 1.414l-4 4a1 1 0 01-1.414 0z"
              clipRule="evenodd"
            />
          </svg>
        </Link>
      )}
    </div>
  );
}

// ── Main component ─────────────────────────────────────────────────────────

export function CrmHoyClient({
  sinContactar,
  sinContactarCount,
  esperando,
  esperandoCount,
  vencidos,
  vencidosCount,
  citas,
  citasCount,
  totalLeads,
}: {
  sinContactar: HoyLead[];
  sinContactarCount: number;
  esperando: HoyLead[];
  esperandoCount: number;
  vencidos: HoyLead[];
  vencidosCount: number;
  citas: HoyAppointment[];
  citasCount: number;
  totalLeads: number;
}) {
  const t = useTranslations("crm");

  const totalPending =
    sinContactarCount + esperandoCount + vencidosCount + citasCount;

  // No leads at all → CTA
  if (totalLeads === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center px-8 py-16 text-center">
        <div className="font-display text-2xl mb-2">{t("hoyTitle")}</div>
        <p className="text-sm text-op-muted mb-6">{t("hoyNoLeads")}</p>
        <Link
          href="/comercial/crm"
          className="px-5 py-3 rounded-xl bg-terracotta text-white text-sm font-medium min-h-[44px] flex items-center hover:opacity-90 transition-opacity"
        >
          {t("hoyCtaFirstLead")}
        </Link>
      </div>
    );
  }

  // All good
  if (totalPending === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center px-8 py-16 text-center">
        <div className="text-4xl mb-3">{"✓"}</div>
        <div className="font-display text-2xl mb-2">{t("hoyTitle")}</div>
        <p className="text-sm text-op-muted">{t("hoyEmptyAll")}</p>
      </div>
    );
  }

  const SHOW = 5;

  return (
    <div className="flex-1 flex flex-col">
      {/* Header */}
      <div className="px-4 pt-4 pb-3">
        <div className="font-display text-xl">{t("hoyTitle")}</div>
      </div>

      {/* Bandejas */}
      <div className="px-4 pb-6 space-y-3">
        {/* 1. Citas de hoy */}
        {citasCount > 0 && (
          <BandejaSection
            titleKey="hoyBandejaCitas"
            count={citasCount}
            defaultOpen
          >
            {citas.slice(0, SHOW).map((appt) => (
              <AppointmentCard key={appt.id} appt={appt} />
            ))}
          </BandejaSection>
        )}

        {/* 2. Seguimientos vencidos */}
        {vencidosCount > 0 && (
          <BandejaSection
            titleKey="hoyBandejaVencidos"
            count={vencidosCount}
            defaultOpen
          >
            {vencidos.slice(0, SHOW).map((lead) => {
              const days = lead.nextActionAt
                ? -daysUntil(lead.nextActionAt)
                : 0;
              const subtext =
                days === 0
                  ? t("hoyVencidoHoy")
                  : t("hoyVencidoHace", { count: days });
              return (
                <LeadCard
                  key={lead.id}
                  lead={lead}
                  subtext={subtext}
                  subtextVariant={days === 0 ? "warning" : "danger"}
                />
              );
            })}
          </BandejaSection>
        )}

        {/* 3. Esperando respuesta */}
        {esperandoCount > 0 && (
          <BandejaSection
            titleKey="hoyBandejaEsperando"
            count={esperandoCount}
            defaultOpen
          >
            {esperando.slice(0, SHOW).map((lead) => {
              const days = daysSince(lead.lastActivityAt);
              return (
                <LeadCard
                  key={lead.id}
                  lead={lead}
                  subtext={t("hoyDiasSinContacto", { count: days })}
                  subtextVariant="warning"
                />
              );
            })}
          </BandejaSection>
        )}

        {/* 4. Sin contactar */}
        {sinContactarCount > 0 && (
          <BandejaSection
            titleKey="hoyBandejaSinContactar"
            count={sinContactarCount}
            defaultOpen={false}
          >
            {sinContactar.slice(0, SHOW).map((lead) => {
              const days = daysSince(lead.createdAt);
              return (
                <LeadCard
                  key={lead.id}
                  lead={lead}
                  subtext={t("hoyDiasSinContacto", { count: days })}
                  subtextVariant="normal"
                />
              );
            })}
          </BandejaSection>
        )}
      </div>
    </div>
  );
}
