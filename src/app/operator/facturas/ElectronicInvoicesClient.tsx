"use client";

import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { displayOrderCode } from "@/lib/orderCode";
import { formatDate, formatMoney } from "@/lib/format";
import type { Locale } from "@/i18n/config";
import {
  INVOICE_STATE_FILTERS,
  invoiceListHref,
  type InvoiceDianStatus,
  type InvoiceListParams,
  type InvoiceStateFilter,
} from "@/lib/dian/invoiceList";
import type {
  InvoiceCreditNoteInfo,
  InvoiceListPage,
  InvoiceListRow,
  LateInvoiceRequest,
} from "@/lib/dian/invoiceListQueries";
import { CREDIT_NOTES_PATH, creditNotePreselectHref } from "@/lib/dian/creditNoteLink";
import { InvoiceActions } from "../orders/InvoiceActions";
import { EmissionBanner, blockReasonText, type EmissionInfo } from "./EmissionBanner";
import { RetryEmissionButton } from "./RetryEmissionButton";
import { ResolveLateRequestButton } from "./ResolveLateRequestButton";

/**
 * /operator/facturas con facturación electrónica: las facturas que MESAPAY
 * emitió a la DIAN, con su estado, el correo al cliente y la nota crédito.
 * Arriba, sólo lo que pide a alguien: la emisión frenada (EmissionBanner),
 * las rechazadas de los últimos 30 días y los clientes que pidieron factura
 * cuando la cuenta ya había salido a consumidor final.
 *
 * Los filtros viven en la URL (enlaces y un formulario GET): se pueden
 * compartir y el botón atrás funciona. Las acciones por fila son las de
 * siempre — ver / reimprimir / reenviar (InvoiceActions de Pedidos),
 * reintentar (la ruta de emisión) y anular (Notas crédito, preseleccionada).
 */
export function ElectronicInvoicesClient({
  params,
  cutoffHour,
  list,
  emission,
  rejected,
  late,
}: {
  params: InvoiceListParams;
  cutoffHour: number;
  list: InvoiceListPage;
  emission: EmissionInfo;
  rejected: { count: number; from: string; to: string };
  late: { items: LateInvoiceRequest[]; truncated: boolean };
}) {
  const t = useTranslations("opEInvoices");
  const tCredit = useTranslations("opCreditNotes");
  const filtered = params.state !== "all" || !!params.from || !!params.to || !!params.q;

  return (
    <div className="p-4 lg:p-6 max-w-6xl mx-auto w-full">
      <div className="flex flex-wrap items-start justify-between gap-3 mb-5">
        <div className="min-w-0">
          <h1 className="font-display text-2xl lg:text-3xl">{t("title")}</h1>
          <p className="text-sm text-op-muted mt-1 max-w-2xl">{t("intro")}</p>
        </div>
        <Link href={CREDIT_NOTES_PATH} className="mp-btn mp-btn--secondary mp-btn--sm">
          {tCredit("title")}
        </Link>
      </div>

      <EmissionBanner emission={emission} />

      {rejected.count > 0 && (
        <div className="rounded-2xl border border-danger/30 bg-danger/10 p-4 mb-4 text-sm text-danger flex flex-wrap items-center justify-between gap-2">
          <span className="font-medium">{t("rejectedNotice", { count: rejected.count })}</span>
          <Link
            href={invoiceListHref({ state: "rejected", from: rejected.from, to: rejected.to })}
            className="text-[12px] font-medium underline"
          >
            {t("rejectedNoticeCta")}
          </Link>
        </div>
      )}

      {late.items.length > 0 && <LateRequests late={late} />}

      <Filters params={params} cutoffHour={cutoffHour} filtered={filtered} />

      {list.rows.length === 0 ? (
        <div className="text-sm text-op-muted py-12 text-center border border-dashed border-op-border rounded-2xl">
          {filtered || list.total > 0 ? t("emptyFiltered") : t("empty")}
        </div>
      ) : (
        <>
          <InvoiceTable rows={list.rows} />
          <InvoiceCards rows={list.rows} />
        </>
      )}

      <Pagination params={params} list={list} />
    </div>
  );
}

// ── Avisos ────────────────────────────────────────────────────────────────

/** Cuántos casos "llegó después" se ven sin desplegar. */
const LATE_VISIBLE = 5;

function LateRequests({ late }: { late: { items: LateInvoiceRequest[]; truncated: boolean } }) {
  const t = useTranslations("opEInvoices");
  const visible = late.items.slice(0, LATE_VISIBLE);
  const rest = late.items.slice(LATE_VISIBLE);
  return (
    <section
      aria-labelledby="late-requests-title"
      className="rounded-2xl border border-[#C98A2E]/40 bg-[#C98A2E]/10 p-4 mb-6"
    >
      <h2 id="late-requests-title" className="font-medium text-sm text-[#7F5A1F]">
        {t("lateTitle", { count: late.items.length })}
      </h2>
      <p className="text-[12px] text-[#7F5A1F] mt-1">{t("lateHint")}</p>
      {late.truncated && (
        <p className="text-[11px] text-op-muted mt-1">{t("lateTruncated")}</p>
      )}
      <ul className="mt-3 space-y-2">
        {visible.map((r) => (
          <LateRequestItem key={r.id} item={r} />
        ))}
      </ul>
      {rest.length > 0 && (
        <details className="mt-2">
          <summary className="text-[12px] text-[#7F5A1F] cursor-pointer">
            {t("lateShowMore", { count: rest.length })}
          </summary>
          <ul className="mt-2 space-y-2">
            {rest.map((r) => (
              <LateRequestItem key={r.id} item={r} />
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

function LateRequestItem({ item }: { item: LateInvoiceRequest }) {
  const t = useTranslations("opEInvoices");
  const locale = useLocale() as Locale;
  return (
    <li className="rounded-xl border border-op-border bg-op-surface p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <div className="min-w-0">
          <span className="font-medium break-words">{item.customerName}</span>{" "}
          <span className="text-sm text-op-muted">
            {item.docType} <span className="font-mono tabular">{item.docNumber}</span>
          </span>
          <div className="text-[12px] text-op-muted break-all">{item.email}</div>
        </div>
        <div className="text-[11px] text-op-muted text-right">
          {t("lateRequestedAt", { date: formatDate(item.requestedAt, { locale }) })}
        </div>
      </div>
      <p className="mt-1 text-[12px]">
        {t("lateInvoice", {
          number: item.invoiceNumber,
          code: displayOrderCode(item.shortCode),
          date: formatDate(item.issuedAt, { locale }),
        })}
      </p>
      {item.creditNote && (
        <p className="mt-1 text-[12px] text-op-muted">
          <CreditNoteLabel note={item.creditNote} />
        </p>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1">
        <Link href={creditNotePreselectHref(item.invoiceId)} className="mp-btn mp-btn--secondary mp-btn--sm">
          {t("lateCreditNote")}
        </Link>
        <ResolveLateRequestButton requestId={item.id} />
      </div>
    </li>
  );
}

// ── Filtros ───────────────────────────────────────────────────────────────

const STATE_LABEL: Record<InvoiceStateFilter, string> = {
  all: "stateAll",
  rejected: "stateRejected",
  in_process: "stateInProcess",
  accepted: "stateAccepted",
};

function Filters({
  params,
  cutoffHour,
  filtered,
}: {
  params: InvoiceListParams;
  cutoffHour: number;
  filtered: boolean;
}) {
  const t = useTranslations("opEInvoices");
  return (
    <div className="flex flex-wrap items-end gap-3 mb-4">
      <div>
        <div className="font-mono text-[9px] tracking-[0.14em] uppercase text-op-muted mb-1">
          {t("filterState")}
        </div>
        <div className="inline-flex flex-wrap border border-op-border rounded-full bg-op-surface p-0.5">
          {INVOICE_STATE_FILTERS.map((state) => {
            const active = params.state === state;
            return (
              <Link
                key={state}
                href={invoiceListHref({ ...params, state, page: 1 })}
                prefetch={false}
                aria-current={active ? "page" : undefined}
                className={
                  "px-3 h-7 rounded-full text-xs inline-flex items-center " +
                  (active ? "bg-ink text-bone" : "text-op-text/80")
                }
              >
                {t(STATE_LABEL[state])}
              </Link>
            );
          })}
        </div>
      </div>

      <form action="/operator/facturas" className="flex flex-wrap items-end gap-2 w-full lg:w-auto lg:ml-auto">
        {params.state !== "all" && <input type="hidden" name="state" value={params.state} />}
        <label className="text-[11px] text-op-muted">
          <span className="block mb-1">{t("filterFrom")}</span>
          <input
            type="date"
            name="from"
            defaultValue={params.from ?? ""}
            className="h-9 px-2 rounded-full border border-op-border bg-op-surface text-sm text-op-text"
          />
        </label>
        <label className="text-[11px] text-op-muted">
          <span className="block mb-1">{t("filterTo")}</span>
          <input
            type="date"
            name="to"
            defaultValue={params.to ?? ""}
            className="h-9 px-2 rounded-full border border-op-border bg-op-surface text-sm text-op-text"
          />
        </label>
        <label className="text-[11px] text-op-muted flex-1 min-w-[12rem]">
          <span className="block mb-1">{t("searchLabel")}</span>
          <input
            type="search"
            name="q"
            defaultValue={params.q}
            maxLength={100}
            placeholder={t("searchPlaceholder")}
            className="h-9 w-full px-3 rounded-full border border-op-border bg-op-surface text-sm text-op-text"
          />
        </label>
        <button type="submit" className="h-9 px-4 rounded-full bg-ink text-bone text-sm">
          {t("filterApply")}
        </button>
        {filtered && (
          <Link href="/operator/facturas" prefetch={false} className="h-9 px-3 inline-flex items-center text-sm text-op-muted underline">
            {t("filterClear")}
          </Link>
        )}
        <p className="basis-full text-[11px] text-op-muted">
          {t("businessDayHint", { hour: String(cutoffHour).padStart(2, "0") })}
        </p>
      </form>
    </div>
  );
}

// ── Lista ─────────────────────────────────────────────────────────────────

function InvoiceTable({ rows }: { rows: InvoiceListRow[] }) {
  const t = useTranslations("opEInvoices");
  return (
    <div className="hidden lg:block bg-op-surface border border-op-border rounded-2xl overflow-hidden">
      <table className="w-full text-sm">
        <thead className="bg-op-bg">
          <tr className="text-left">
            <Th>{t("colNumber")}</Th>
            <Th>{t("colDate")}</Th>
            <Th>{t("colCustomer")}</Th>
            <Th align="right">{t("colTotal")}</Th>
            <Th>{t("colDian")}</Th>
            <Th>{t("colEmail")}</Th>
            <Th>{t("colCreditNote")}</Th>
            <Th>{t("colActions")}</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className="border-t border-op-border align-top">
              <Td>
                <div className="font-mono font-medium">{r.number}</div>
                <div className="font-mono text-[10px] text-op-muted" title={r.shortCode}>
                  {t("orderCode", { code: displayOrderCode(r.shortCode) })}
                </div>
              </Td>
              <Td>
                <DateCell iso={r.createdAt} />
              </Td>
              <Td>
                <CustomerCell row={r} />
              </Td>
              <Td align="right" className="font-mono tabular whitespace-nowrap">
                <Money cents={r.totalCents} />
              </Td>
              <Td>
                <DianCell row={r} />
              </Td>
              <Td>
                <EmailCell row={r} />
              </Td>
              <Td>
                {r.creditNote ? <CreditNoteLabel note={r.creditNote} /> : <span className="text-op-muted">{"—"}</span>}
              </Td>
              <Td>
                <RowActions row={r} />
              </Td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function InvoiceCards({ rows }: { rows: InvoiceListRow[] }) {
  const t = useTranslations("opEInvoices");
  return (
    <ul className="lg:hidden space-y-2">
      {rows.map((r) => (
        <li key={r.id} className="bg-op-surface border border-op-border rounded-2xl p-4">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <div className="font-mono font-medium">{r.number}</div>
              <div className="text-[11px] text-op-muted">
                <DateCell iso={r.createdAt} inline /> · {t("orderCode", { code: displayOrderCode(r.shortCode) })}
              </div>
            </div>
            <div className="font-mono tabular text-sm shrink-0">
              <Money cents={r.totalCents} />
            </div>
          </div>
          <div className="mt-2 text-sm">
            <CustomerCell row={r} />
          </div>
          <div className="mt-3 grid grid-cols-1 sm:grid-cols-3 gap-3 border-t border-op-border pt-3 text-sm">
            <Labeled label={t("colDian")}>
              <DianCell row={r} />
            </Labeled>
            <Labeled label={t("colEmail")}>
              <EmailCell row={r} />
            </Labeled>
            <Labeled label={t("colCreditNote")}>
              {r.creditNote ? <CreditNoteLabel note={r.creditNote} /> : <span className="text-op-muted">{"—"}</span>}
            </Labeled>
          </div>
          <div className="mt-3">
            <RowActions row={r} />
          </div>
        </li>
      ))}
    </ul>
  );
}

function DateCell({ iso, inline = false }: { iso: string; inline?: boolean }) {
  const locale = useLocale() as Locale;
  const date = formatDate(iso, { locale, dateStyle: "medium", timeStyle: undefined });
  const time = formatDate(iso, { locale, dateStyle: undefined, timeStyle: "short" });
  if (inline) return <>{`${date} ${time}`}</>;
  return (
    <>
      <div className="whitespace-nowrap">{date}</div>
      <div className="text-[10px] text-op-muted">{time}</div>
    </>
  );
}

function Money({ cents }: { cents: number }) {
  const locale = useLocale() as Locale;
  // Facturación electrónica DIAN: siempre pesos colombianos.
  return <>{formatMoney(cents, { currency: "COP", locale })}</>;
}

function CustomerCell({ row }: { row: InvoiceListRow }) {
  const t = useTranslations("opEInvoices");
  if (!row.customer) return <span className="text-op-muted">{t("finalConsumer")}</span>;
  return (
    <div className="min-w-0">
      <div className="break-words">{row.customer.name}</div>
      <div className="text-[11px] text-op-muted">
        {row.customer.docType} <span className="font-mono tabular">{row.customer.docNumber}</span>
      </div>
    </div>
  );
}

const STATUS_LABEL: Record<InvoiceDianStatus, string> = {
  accepted: "statusAccepted",
  rejected: "statusRejected",
  error_retrying: "statusError",
  error_stuck: "statusError",
  in_process: "statusInProcess",
  not_sent: "statusNotSent",
};

const STATUS_TONE: Record<InvoiceDianStatus, string> = {
  accepted: "bg-ok/15 text-ok",
  rejected: "bg-danger/15 text-danger",
  error_stuck: "bg-danger/15 text-danger",
  error_retrying: "bg-[#C98A2E]/20 text-[#7F5A1F]",
  in_process: "bg-[#C98A2E]/20 text-[#7F5A1F]",
  not_sent: "bg-op-bg text-op-muted",
};

function DianCell({ row }: { row: InvoiceListRow }) {
  const t = useTranslations("opEInvoices");
  const tf = useTranslations("opFacturas");
  const { status, reason, errors } = row.dian;
  const reasonText = reason ? blockReasonText(reason, tf) : null;
  let detail: string | null = null;
  if (status === "rejected" || status === "error_stuck" || status === "error_retrying") {
    detail = reasonText;
  } else if (status === "not_sent") {
    detail = reasonText ? tf("dianWaitingReason", { reason: reasonText }) : t("notSentQueued");
  }
  return (
    <div className="min-w-0 max-w-[16rem]">
      <span
        className={
          "px-2 h-6 inline-flex items-center rounded-full text-[10px] font-medium " + STATUS_TONE[status]
        }
      >
        {t(STATUS_LABEL[status])}
      </span>
      {detail && (
        <p
          className={
            "mt-1 text-[11px] break-words " +
            (status === "rejected" || status === "error_stuck" ? "text-danger" : "text-op-muted")
          }
        >
          {detail}
        </p>
      )}
      {status === "error_retrying" && <p className="mt-1 text-[11px] text-op-muted">{t("errorRetrying")}</p>}
      {status === "error_stuck" && <p className="mt-1 text-[11px] text-op-muted">{t("errorStuck")}</p>}
      {(status === "rejected" || status === "error_stuck") && errors.length > 1 && (
        <details className="mt-1">
          <summary className="text-[11px] text-danger cursor-pointer">{tf("dianErrorsTitle")}</summary>
          <ul className="mt-1 space-y-0.5">
            {errors.map((e, i) => (
              <li key={i} className="font-mono text-[10px] text-danger break-all">
                {e}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

function EmailCell({ row }: { row: InvoiceListRow }) {
  const t = useTranslations("opEInvoices");
  const locale = useLocale() as Locale;
  const { status, emailedAt, emailError, emailTo } = row.dian;
  if (status !== "accepted") return <span className="text-op-muted">{"—"}</span>;
  if (emailedAt) {
    return (
      <div className="min-w-0 max-w-[14rem]">
        <div className="text-ok">{emailTo ? t("emailSentTo", { email: emailTo }) : t("emailSent")}</div>
        <div className="text-[10px] text-op-muted">{formatDate(emailedAt, { locale })}</div>
      </div>
    );
  }
  let text: string;
  if (!emailTo || emailError === "no_recipient") text = t("emailNoRecipient");
  else if (emailError === "send_failed") text = t("emailFailed", { email: emailTo });
  else text = t("emailNotYet", { email: emailTo });
  return <div className="min-w-0 max-w-[14rem] text-[12px] text-op-muted break-words">{text}</div>;
}

const CREDIT_NOTE_STATES = new Set([
  "draft",
  "to_send",
  "pending",
  "signed",
  "sent",
  "accepted",
  "rejected",
  "error",
]);

function CreditNoteLabel({ note }: { note: InvoiceCreditNoteInfo }) {
  const t = useTranslations("opEInvoices");
  const tCredit = useTranslations("opCreditNotes");
  return (
    <span className="text-[12px]">
      {t("creditNote", {
        number: note.documentNumber,
        state: tCredit(`state_${CREDIT_NOTE_STATES.has(note.state) ? note.state : "pending"}`),
      })}
    </span>
  );
}

function RowActions({ row }: { row: InvoiceListRow }) {
  const t = useTranslations("opEInvoices");
  const { status, documentId, reason } = row.dian;
  const accepted = status === "accepted";
  // El reintento que ya existe ("Reintentar emisión"): lo que la DIAN
  // rechazó, lo que falló al enviarse y lo frenado por configuración. Lo
  // que está en cola sin motivo o en manos de la DIAN no se toca.
  const canRetry =
    status === "rejected" ||
    status === "error_retrying" ||
    status === "error_stuck" ||
    (status === "not_sent" && !!reason);
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
      <InvoiceActions orderId={row.orderId} invoiceId={row.id} dianDocumentId={accepted ? documentId : null} />
      {accepted && (
        <Link href={creditNotePreselectHref(row.id)} className="mp-btn mp-btn--ghost mp-btn--sm">
          {t("actionCreditNote")}
        </Link>
      )}
      {canRetry && <RetryEmissionButton simpleInvoiceId={row.id} status={status} />}
    </div>
  );
}

function Pagination({ params, list }: { params: InvoiceListParams; list: InvoiceListPage }) {
  const t = useTranslations("opEInvoices");
  if (list.total === 0) return null;
  const prev = list.page > 1 ? invoiceListHref({ ...params, page: list.page - 1 }) : null;
  const next = list.page < list.pageCount ? invoiceListHref({ ...params, page: list.page + 1 }) : null;
  return (
    <nav aria-label={t("paginationLabel")} className="mt-4 flex flex-wrap items-center justify-between gap-3 text-sm">
      <span className="text-op-muted">
        {t("pageInfo", { page: list.page, pages: list.pageCount, total: list.total })}
      </span>
      <span className="flex gap-2">
        {prev ? (
          <Link href={prev} prefetch={false} className="mp-btn mp-btn--secondary mp-btn--sm">
            {t("pagePrev")}
          </Link>
        ) : null}
        {next ? (
          <Link href={next} prefetch={false} className="mp-btn mp-btn--secondary mp-btn--sm">
            {t("pageNext")}
          </Link>
        ) : null}
      </span>
    </nav>
  );
}

function Labeled({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="font-mono text-[9px] tracking-[0.12em] uppercase text-op-muted mb-1">{label}</div>
      {children}
    </div>
  );
}

function Th({ children, align }: { children?: React.ReactNode; align?: "right" }) {
  return (
    <th
      className={
        "px-3 py-2 font-mono text-[9px] tracking-[0.14em] uppercase text-op-muted font-normal " +
        (align === "right" ? "text-right" : "")
      }
    >
      {children}
    </th>
  );
}

function Td({
  children,
  align,
  className = "",
}: {
  children?: React.ReactNode;
  align?: "right";
  className?: string;
}) {
  return (
    <td className={"px-3 py-3 " + (align === "right" ? "text-right " : "") + className}>{children}</td>
  );
}
