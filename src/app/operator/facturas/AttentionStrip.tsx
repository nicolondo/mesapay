"use client";

import Link from "next/link";
import { useId, useState, type ReactNode } from "react";
import { useLocale, useTranslations } from "next-intl";
import { displayOrderCode } from "@/lib/orderCode";
import { formatDate } from "@/lib/format";
import type { Locale } from "@/i18n/config";
import { invoiceListHref, type InvoiceListParams } from "@/lib/dian/invoiceList";
import type { LateInvoiceRequest } from "@/lib/dian/invoiceListQueries";
import { creditNotePreselectHref } from "@/lib/dian/creditNoteLink";
import { STATUS_TEXT, StatusIcon, type StatusTone } from "../reportes/_components/StatusBadge";
import { blockReasonText, emissionNotices, type EmissionInfo } from "./EmissionBanner";
import { CreditNoteChip } from "./InvoiceRow";
import { ResolveLateRequestButton } from "./ResolveLateRequestButton";

const DIAN_SETTINGS_HREF = "/operator/settings/facturacion-dian";

/** Cuántos casos "llegó después" se ven sin desplegar «Ver N más». */
const LATE_VISIBLE = 5;

type Item = {
  key: string;
  tone: StatusTone;
  text: ReactNode;
  hint?: string;
  action?: ReactNode;
  /** Panel que se despliega debajo del renglón. */
  panel?: ReactNode;
};

/**
 * «Por atender»: en una franja compacta, sólo lo que necesita que alguien
 * haga algo, de lo más grave a lo menos —la emisión frenada por la
 * configuración, el rango de numeración, las rechazadas de los últimos 30
 * días (el enlace aplica su filtro sin mover la página) y los clientes que
 * pidieron factura cuando la cuenta ya había salido a consumidor final (se
 * despliegan ahí mismo)—, y al final lo que sólo informa (la cola que se
 * reintenta sola). Sin nada de eso, no se muestra.
 */
export function AttentionStrip({
  emission,
  rejected,
  late,
  params,
}: {
  emission: EmissionInfo;
  rejected: { count: number; from: string; to: string };
  late: { items: LateInvoiceRequest[]; truncated: boolean };
  params: InvoiceListParams;
}) {
  const t = useTranslations("opEInvoices");
  const tf = useTranslations("opFacturas");
  const [lateOpen, setLateOpen] = useState(false);
  const latePanelId = useId();

  const items: Item[] = [];
  const info: Item[] = [];
  for (const n of emissionNotices(emission)) {
    if (n.kind === "blocked") {
      items.push({
        key: "blocked",
        tone: "critical",
        text: tf("emissionBlocked", { count: n.count, reason: blockReasonText(n.reason, tf) }),
        hint: tf("emissionBlockedHint"),
        action: <StripLink href={DIAN_SETTINGS_HREF}>{tf("emissionBlockedCta")}</StripLink>,
      });
    } else if (n.kind === "exhausted") {
      items.push({
        key: "numbers",
        tone: "critical",
        text: tf("numbersExhausted"),
        action: <StripLink href={DIAN_SETTINGS_HREF}>{tf("emissionBlockedCta")}</StripLink>,
      });
    } else if (n.kind === "lowNumbers") {
      items.push({
        key: "numbers",
        tone: "warning",
        text: tf("numbersLeftWarning", { count: n.count }),
        action: <StripLink href={DIAN_SETTINGS_HREF}>{tf("emissionBlockedCta")}</StripLink>,
      });
    } else {
      info.push({ key: "queued", tone: "info", text: tf("emissionWaiting", { count: n.count }) });
    }
  }

  if (rejected.count > 0) {
    const href = invoiceListHref({ state: "rejected", from: rejected.from, to: rejected.to });
    const active =
      params.state === "rejected" && params.from === rejected.from && params.to === rejected.to && !params.q;
    items.push({
      key: "rejected",
      tone: "critical",
      text: t("rejectedNotice", { count: rejected.count }),
      action: active ? (
        <span className="text-xs font-medium text-op-muted">{t("rejectedNoticeActive")}</span>
      ) : (
        // Aplica el filtro: la lista de abajo cambia y la página no se mueve.
        <StripLink href={href} scroll={false}>
          {t("rejectedNoticeCta")}
        </StripLink>
      ),
    });
  }

  if (late.items.length > 0) {
    items.push({
      key: "late",
      tone: "warning",
      text: t("lateTitle", { count: late.items.length }),
      action: (
        <button
          type="button"
          aria-expanded={lateOpen}
          aria-controls={latePanelId}
          onClick={() => setLateOpen((v) => !v)}
          className="mp-btn mp-btn--secondary mp-btn--xs"
        >
          <Chevron open={lateOpen} />
          {lateOpen ? t("lateHide") : t("lateReview")}
        </button>
      ),
      panel: <LatePanel id={latePanelId} open={lateOpen} late={late} />,
    });
  }

  const all = [...items, ...info];
  if (all.length === 0) return null;

  return (
    <section
      aria-labelledby="facturas-atender-title"
      className="mb-4 min-w-0 rounded-2xl border border-op-border bg-op-surface"
    >
      <h2
        id="facturas-atender-title"
        className="flex items-center gap-2 border-b border-op-border px-4 py-2 text-[13px] font-semibold"
      >
        {t("attnTitle")}
        {items.length > 0 && <span className="mp-count font-medium">{items.length}</span>}
      </h2>
      <ul className="divide-y divide-op-border/70">
        {all.map((it) => (
          <li key={it.key} className="min-w-0">
            <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-2.5">
              <span className={STATUS_TEXT[it.tone]}>
                <StatusIcon tone={it.tone} className="h-4 w-4" />
              </span>
              <div className="min-w-0 flex-1 basis-56">
                <p className={"text-sm leading-snug " + (it.tone === "info" ? "text-op-muted" : "font-medium")}>
                  {it.text}
                </p>
                {it.hint && <p className="mt-0.5 hidden text-xs leading-snug text-op-muted sm:block">{it.hint}</p>}
              </div>
              {it.action && <div className="ml-7 shrink-0 sm:ml-0">{it.action}</div>}
            </div>
            {it.panel}
          </li>
        ))}
      </ul>
    </section>
  );
}

function StripLink({ href, scroll, children }: { href: string; scroll?: boolean; children: ReactNode }) {
  return (
    <Link
      href={href}
      prefetch={false}
      scroll={scroll}
      className="inline-flex min-h-8 items-center gap-1 text-[13px] font-medium text-op-accent underline-offset-4 hover:underline"
    >
      {children}
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M5 12h14m-5-5 5 5-5 5" />
      </svg>
    </Link>
  );
}

function LatePanel({
  id,
  open,
  late,
}: {
  id: string;
  open: boolean;
  late: { items: LateInvoiceRequest[]; truncated: boolean };
}) {
  const t = useTranslations("opEInvoices");
  const visible = late.items.slice(0, LATE_VISIBLE);
  const rest = late.items.slice(LATE_VISIBLE);
  return (
    <div id={id} hidden={!open} className="border-t border-op-border/70 bg-op-bg/60 px-4 py-3">
      <p className="max-w-3xl text-xs leading-relaxed text-op-muted">{t("lateHint")}</p>
      {late.truncated && <p className="mt-1 text-[11px] text-op-muted">{t("lateTruncated")}</p>}
      <ul className="mt-2 divide-y divide-op-border/70 overflow-hidden rounded-xl border border-op-border bg-op-surface">
        {visible.map((r) => (
          <LateRequestRow key={r.id} item={r} />
        ))}
      </ul>
      {rest.length > 0 && (
        <details className="mt-2">
          <summary className="cursor-pointer text-xs font-medium text-op-muted">
            {t("lateShowMore", { count: rest.length })}
          </summary>
          <ul className="mt-2 divide-y divide-op-border/70 overflow-hidden rounded-xl border border-op-border bg-op-surface">
            {rest.map((r) => (
              <LateRequestRow key={r.id} item={r} />
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

function LateRequestRow({ item }: { item: LateInvoiceRequest }) {
  const t = useTranslations("opEInvoices");
  const locale = useLocale() as Locale;
  return (
    <li className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1.5 px-3 py-2.5">
      <div className="min-w-0 flex-1 basis-60">
        <div className="text-sm">
          <span className="font-medium break-words">{item.customerName}</span>{" "}
          <span className="text-op-muted">
            {item.docType} <span className="font-mono tabular">{item.docNumber}</span>
          </span>
        </div>
        <div className="truncate text-xs text-op-muted" title={item.email}>
          {item.email}
        </div>
      </div>
      <div className="min-w-0 flex-1 basis-72 text-xs leading-snug">
        <div>
          {t("lateInvoice", {
            number: item.invoiceNumber,
            code: displayOrderCode(item.shortCode),
            date: formatDate(item.issuedAt, { locale }),
          })}
        </div>
        <div className="text-op-muted">
          {t("lateRequestedAt", { date: formatDate(item.requestedAt, { locale }) })}
          {item.creditNote && (
            <>
              {" · "}
              <CreditNoteChip note={item.creditNote} />
            </>
          )}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
        <Link href={creditNotePreselectHref(item.invoiceId)} prefetch={false} className="mp-btn mp-btn--secondary mp-btn--xs">
          {t("lateCreditNote")}
        </Link>
        <ResolveLateRequestButton requestId={item.id} />
      </div>
    </li>
  );
}

export function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className={"shrink-0 transition-transform duration-200 motion-reduce:transition-none " + (open ? "rotate-90" : "")}
    >
      <path d="m9 6 6 6-6 6" />
    </svg>
  );
}
