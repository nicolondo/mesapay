"use client";

import Link from "next/link";
import { useId, useState, type ReactNode } from "react";
import { useLocale, useTranslations } from "next-intl";
import { displayOrderCode } from "@/lib/orderCode";
import { formatDate, formatMoney } from "@/lib/format";
import type { Locale } from "@/i18n/config";
import type { InvoiceDianStatus } from "@/lib/dian/invoiceList";
import type { InvoiceCreditNoteInfo, InvoiceListRow } from "@/lib/dian/invoiceListQueries";
import { CREDIT_NOTES_PATH, creditNotePreselectHref } from "@/lib/dian/creditNoteLink";
import {
  adviceCauseKey,
  invoiceActionPlan,
  invoiceEmailStatus,
  invoiceStatusTone,
  parseDianReason,
  type InvoiceActionId,
  type InvoiceEmailStatus,
} from "@/lib/dian/invoiceRowView";
import { invoicePrintHref } from "@/lib/print/staffPrint";
import { StaffPrintNotice, useStaffPrint } from "@/components/print/StaffPrintButton";
import { useResendInvoiceEmail } from "../orders/InvoiceActions";
import { STATUS_TEXT, StatusBadge } from "../reportes/_components/StatusBadge";
import { DianCauseNotice, useDianRecovery } from "./DianRecovery";
import { blockReasonText } from "./EmissionBanner";
import { InvoiceRowActions, primaryActionClass, type RowActionSize, type RowMenuItem } from "./InvoiceRowActions";
import { useRetryEmission } from "./useRetryEmission";

/**
 * Una factura de la lista de /operator/facturas, en sus dos formas:
 *
 *   · <InvoiceTableRow> (escritorio): un renglón de dos líneas —número y
 *     pedido, fecha y hora, cliente y documento, total, estado DIAN con el
 *     motivo en UNA línea (o el chip de la nota crédito que la anula), el
 *     correo como ícono— y a la derecha UNA acción principal y el menú «⋯».
 *   · <InvoiceListItem> (celular y pantallas angostas): tres líneas y el
 *     menú; la acción principal se ve sólo cuando pide a alguien
 *     (reintentar, reenviar un correo fallido).
 *
 * Las dos despliegan el mismo DETALLE (la respuesta completa de la DIAN,
 * qué hacer, el correo, el cliente, el pedido y la nota crédito) desde el
 * motivo o desde «Ver detalle» del menú, y muestran debajo el resultado de
 * la acción (impresión, reenvío, reintento). Qué va a la vista y qué al
 * menú lo decide `invoiceActionPlan` (lib/dian/invoiceRowView.ts).
 *
 * Con una causa conocida de la DIAN (`row.dian.advice`, ver
 * `dianRecoveryAdvice`) el motivo de la fila es la causa en palabras claras
 * (`cause_<causa>`), la acción principal es la recomendada («Reenviar a la
 * DIAN» / «Consultar en la DIAN», `useDianRecovery`) y el detalle muestra
 * `DianCauseNotice` con el mensaje crudo desplegable. La ruta la cuida el
 * servidor: sólo operador, admin de grupo y admin de plataforma.
 */

const STATUS_LABEL: Record<InvoiceDianStatus, string> = {
  accepted: "statusAccepted",
  rejected: "statusRejected",
  error_retrying: "statusError",
  error_stuck: "statusError",
  in_process: "statusInProcess",
  not_sent: "statusNotSent",
};

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

type T = ReturnType<typeof useTranslations>;

/**
 * Fecha corta y del mismo ancho en los tres idiomas («4/11/2026»): el
 * «medium» de portugués («4 de nov. de 2026») no entraba en la columna.
 */
const NUMERIC_DATE = {
  dateStyle: undefined,
  timeStyle: undefined,
  day: "numeric",
  month: "numeric",
  year: "numeric",
} as const;

/**
 * El motivo, en una línea: texto, regla DIAN (si la hay) y lo que dice el
 * título al pasar el puntero (el texto crudo, o la explicación de una causa
 * conocida: lo claro primero).
 */
type Cause = { text: string; rule: string | null; title: string; strong: boolean };

function causeOf(row: InvoiceListRow, t: T, tf: T): Cause | null {
  const { status, reason, errors, advice } = row.dian;
  const parsed = parseDianReason(reason);
  const raw = (errors.length ? errors : reason ? [reason] : []).join("\n");
  const reasonText =
    parsed?.kind === "config" ? blockReasonText(parsed.code, tf) : (parsed?.text ?? null);
  const rule = parsed?.kind === "rule" ? parsed.rule : null;
  const key = adviceCauseKey(advice, status);
  if (key) {
    // En la línea, la versión corta; al pasar el puntero, la explicación
    // entera de #585 y qué hacer (lo claro primero, el texto crudo en el
    // detalle).
    return {
      text: t(`causeShort_${key}`),
      rule,
      title: `${t(`cause_${key}`)} ${t(`causeDetail_${key}`)}`,
      strong: status !== "in_process",
    };
  }
  const cause = (text: string, strong: boolean): Cause => ({ text, rule, title: raw || text, strong });
  switch (status) {
    case "rejected":
      return reasonText ? cause(reasonText, true) : null;
    case "error_stuck":
      return cause(reasonText ? t("causeStuck", { reason: reasonText }) : t("errorStuck"), true);
    case "error_retrying":
      return cause(reasonText ? t("causeRetrying", { reason: reasonText }) : t("errorRetrying"), false);
    case "not_sent":
      return cause(reasonText ? tf("dianWaitingReason", { reason: reasonText }) : t("notSentQueued"), false);
    default:
      return null;
  }
}

function emailText(row: InvoiceListRow, status: InvoiceEmailStatus, t: T, locale: Locale): string {
  const { emailTo, emailedAt } = row.dian;
  switch (status) {
    case "sent": {
      const sent = emailTo ? t("emailSentTo", { email: emailTo }) : t("emailSent");
      return emailedAt ? `${sent} · ${formatDate(emailedAt, { locale })}` : sent;
    }
    case "no_recipient":
      return t("emailNoRecipient");
    case "failed":
      return t("emailFailed", { email: emailTo ?? "" });
    case "pending":
      return t("emailNotYet", { email: emailTo ?? "" });
    case "not_applicable":
      return t("emailAfterAccept");
  }
}

/** Estado, acciones y resultado de UNA factura (lo comparten fila y tarjeta). */
function useInvoiceRow(row: InvoiceListRow) {
  const t = useTranslations("opEInvoices");
  const tf = useTranslations("opFacturas");
  const tOrders = useTranslations("opOrders");
  const tPrint = useTranslations("staffPrint");
  const locale = useLocale() as Locale;
  const [open, setOpen] = useState(false);
  const detailId = useId();

  const { status, documentId, reason, emailError, advice } = row.dian;
  const accepted = status === "accepted";
  // La acción que recomienda la causa (FAW01, regla 90, falla de la DIAN).
  const recoveryAction = !accepted && advice && advice.action !== "none" ? advice.action : null;
  const print = useStaffPrint({ kind: "invoice", orderId: row.orderId, href: invoicePrintHref({ invoiceId: row.id }) });
  const resend = useResendInvoiceEmail(accepted ? documentId : null);
  const retry = useRetryEmission(row.id, status);
  const recover = useDianRecovery(documentId, recoveryAction, row.number);

  const plan = invoiceActionPlan({ status, reason, emailError, recovery: recoveryAction });
  const emailStatus = invoiceEmailStatus(row.dian);
  const cause = causeOf(row, t, tf);
  const tone = invoiceStatusTone(status, reason);

  const viewHref = `/factura/${row.id}`;
  const icons: Record<InvoiceActionId, ReactNode> = {
    view: <Glyph d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />,
    reprint: <Glyph d="M7 9V4h10v5M7 17H5a1 1 0 0 1-1-1v-5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v5a1 1 0 0 1-1 1h-2M7 14h10v6H7z" />,
    resend: <Glyph d="M4 6h16v12H4zM4 7l8 6 8-6" />,
    retry: <Glyph d="M20 11a8 8 0 1 0-2.3 5.7M20 5v6h-6" />,
    recover:
      recoveryAction === "check_status" ? (
        <Glyph d="M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM20 20l-4-4" />
      ) : (
        <Glyph d="M21 3 10 14M21 3l-7 18-4-7-7-4z" />
      ),
    order: <Glyph d="M6 3h12v18l-3-2-3 2-3-2-3 2zM9 8h6M9 12h6" />,
    creditNote: <Glyph d="M9 14 4 9l5-5M4 9h11a5 5 0 0 1 0 10h-3" />,
  };

  const label: Record<InvoiceActionId, string> = {
    view: tOrders("viewInvoice"),
    reprint: print.busy ? tPrint("sending") : tOrders("reprintInvoice"),
    resend: resend.busy ? tOrders("resending") : tOrders("resendEmail"),
    retry: retry.busy ? t("retrying") : t("retry"),
    recover: recover.label,
    order: t("actionViewOrder"),
    creditNote: t("actionCreditNote"),
  };

  function menuItem(id: InvoiceActionId): RowMenuItem {
    switch (id) {
      case "view":
        return { id, label: label.view, href: viewHref, external: true, icon: icons.view };
      case "order":
        return { id, label: label.order, href: `/operator/orders/${row.orderId}`, icon: icons.order };
      case "creditNote":
        return { id, label: label.creditNote, href: creditNotePreselectHref(row.id), tone: "danger", icon: icons.creditNote };
      case "reprint":
        return { id, label: label.reprint, onSelect: print.run, busy: print.busy, icon: icons.reprint };
      case "resend":
        return { id, label: label.resend, onSelect: resend.run, busy: resend.busy, icon: icons.resend };
      case "retry":
        return { id, label: label.retry, onSelect: retry.run, busy: retry.busy, icon: icons.retry };
      case "recover":
        return { id, label: label.recover, onSelect: recover.run, busy: recover.busy, icon: icons.recover };
    }
  }

  // La principal lleva el verbo corto («Reimprimir»): la fila ya dice de
  // qué factura se trata; el nombre completo queda como nombre accesible.
  const shortLabel: Partial<Record<InvoiceActionId, string>> = {
    reprint: print.busy ? tPrint("sending") : t("actionReprintShort"),
    resend: resend.busy ? tOrders("resending") : t("actionResendShort"),
    retry: retry.busy ? t("retrying") : t("actionRetryShort"),
  };

  function primaryControl(size: RowActionSize): ReactNode {
    const id = plan.primary;
    if (id === "view") {
      return (
        <a href={viewHref} target="_blank" rel="noreferrer" className={primaryActionClass(size)}>
          {label.view}
        </a>
      );
    }
    const run =
      id === "retry" ? retry : id === "resend" ? resend : id === "reprint" ? print : id === "recover" ? recover : null;
    if (!run) return null;
    return (
      <button
        type="button"
        onClick={run.run}
        disabled={run.busy}
        aria-label={run.busy ? undefined : `${label[id]} · ${row.number}`}
        title={label[id]}
        className={primaryActionClass(size)}
      >
        {shortLabel[id] ?? label[id]}
      </button>
    );
  }

  const detailItem: RowMenuItem = {
    id: "detail",
    label: open ? t("actionHideDetail") : t("actionShowDetail"),
    onSelect: () => setOpen((v) => !v),
    icon: <Glyph d="M12 11v5M12 8h.01M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z" />,
  };
  const menu = [detailItem, ...plan.menu.map(menuItem)];
  // En el celular la principal se ve sólo si pide a alguien; si no, va al
  // menú (primera, después del detalle).
  const attention = plan.primary === "retry" || plan.primary === "resend" || plan.primary === "recover";
  const compactMenu = attention ? menu : [detailItem, menuItem(plan.primary), ...plan.menu.map(menuItem)];

  const feedback: ReactNode[] = [];
  if (print.notice) {
    feedback.push(
      <StaffPrintNotice key="print" print={print} className="block text-xs" canConfigurePrinters />,
    );
  }
  for (const [key, msg] of [
    ["resend", resend.msg],
    ["retry", retry.msg],
    ["recover", recover.msg],
  ] as const) {
    if (msg) {
      feedback.push(
        <span key={key} role="status" className={"block text-xs " + (msg.ok ? "text-[#1E5339]" : "text-danger")}>
          {msg.text}
        </span>,
      );
    }
  }

  return {
    t,
    locale,
    open,
    setOpen,
    detailId,
    plan,
    tone,
    statusLabel: t(STATUS_LABEL[status]),
    cause,
    emailStatus,
    emailText: emailText(row, emailStatus, t, locale),
    retryWarning: plan.primary === "retry" || plan.menu.includes("retry") ? retry.warning : null,
    causeKey: adviceCauseKey(advice, status),
    primaryControl,
    menu,
    compactMenu,
    attention,
    feedback,
    menuLabel: t("moreActions", { number: row.number }),
  };
}

type RowModel = ReturnType<typeof useInvoiceRow>;

// ── Escritorio ───────────────────────────────────────────────────────────

/** Columnas de la tabla (el detalle desplegado las ocupa todas). */
export const INVOICE_TABLE_COLUMNS = 7;

export function InvoiceTableRow({ row }: { row: InvoiceListRow }) {
  const m = useInvoiceRow(row);
  const { t, locale } = m;
  const showExtra = m.open || m.feedback.length > 0;
  return (
    <tbody data-invoice-row className="border-t border-op-border first:border-t-0">
      <tr className="align-middle transition-colors hover:bg-op-bg/60">
        <td className="py-2 pl-4 pr-3">
          <div className="font-mono text-[13px] font-semibold whitespace-nowrap">{row.number}</div>
          <div
            className="font-mono text-[11px] text-op-muted whitespace-nowrap"
            title={t("orderCode", { code: row.shortCode })}
          >
            {displayOrderCode(row.shortCode)}
          </div>
        </td>
        <td className="px-3 py-2 whitespace-nowrap">
          <div className="truncate text-[13px]">{formatDate(row.createdAt, { locale, ...NUMERIC_DATE })}</div>
          <div className="truncate text-[11px] text-op-muted">
            {formatDate(row.createdAt, { locale, dateStyle: undefined, timeStyle: "short" })}
          </div>
        </td>
        <td className="max-w-0 px-3 py-2">
          <CustomerCell row={row} />
        </td>
        <td className="px-3 py-2 text-right font-mono text-[13px] font-medium tabular whitespace-nowrap">
          <Money cents={row.totalCents} />
        </td>
        <td className="max-w-0 px-3 py-2">
          <StatusCell m={m} creditNote={row.creditNote} />
        </td>
        <td className="px-2 py-2 text-center">
          <EmailIcon status={m.emailStatus} text={m.emailText} />
        </td>
        <td className="py-2 pl-3 pr-4">
          <InvoiceRowActions primary={m.primaryControl("xs")} items={m.menu} menuLabel={m.menuLabel} size="xs" />
        </td>
      </tr>
      <tr hidden={!showExtra}>
        <td colSpan={INVOICE_TABLE_COLUMNS} className="px-4 pb-3 pt-0">
          <Extra row={row} m={m} />
        </td>
      </tr>
    </tbody>
  );
}

// ── Celular / pantallas angostas ─────────────────────────────────────────

export function InvoiceListItem({ row }: { row: InvoiceListRow }) {
  const m = useInvoiceRow(row);
  const { t, locale } = m;
  return (
    <li data-invoice-row className="min-w-0 px-4 py-3">
      <div className="flex min-w-0 gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-baseline gap-2">
            <span className="shrink-0 font-mono text-[13px] font-semibold">{row.number}</span>
            <span
              className={"min-w-0 truncate text-sm " + (row.customer ? "" : "text-op-muted")}
              title={row.customer ? row.customer.name : undefined}
            >
              {row.customer ? row.customer.name : t("finalConsumer")}
            </span>
          </div>
          <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-op-muted">
            <span className="min-w-0 truncate">
              {formatDate(row.createdAt, { locale, ...NUMERIC_DATE, hour: "numeric", minute: "2-digit" })}
              {" · "}
              <span className="font-mono" title={row.shortCode}>
                {displayOrderCode(row.shortCode)}
              </span>
            </span>
            <EmailIcon status={m.emailStatus} text={m.emailText} />
          </div>
          {!m.attention && <CardStatus m={m} creditNote={row.creditNote} />}
        </div>
        <div className="flex shrink-0 flex-col items-end justify-between gap-1.5">
          <span className="font-mono text-sm font-semibold tabular">
            <Money cents={row.totalCents} />
          </span>
          {!m.attention && <InvoiceRowActions items={m.compactMenu} menuLabel={m.menuLabel} size="sm" />}
        </div>
      </div>
      {m.attention && (
        // Lo que pide a alguien: estado y motivo a todo el ancho, y abajo la
        // acción recomendada a la vista con el menú.
        <>
          <CardStatus m={m} creditNote={row.creditNote} />
          <div className="mt-2 flex justify-end">
            <InvoiceRowActions
              primary={m.primaryControl("sm")}
              items={m.compactMenu}
              menuLabel={m.menuLabel}
              size="sm"
            />
          </div>
        </>
      )}
      <div hidden={!m.open && m.feedback.length === 0} className="mt-2">
        <Extra row={row} m={m} />
      </div>
    </li>
  );
}

/** Estado de la tarjeta: semáforo, nota crédito y el motivo en la misma línea. */
function CardStatus({ m, creditNote }: { m: RowModel; creditNote: InvoiceCreditNoteInfo | null }) {
  return (
    <div className="mt-1.5 flex min-w-0 items-center gap-1.5">
      <StatusBadge tone={m.tone} className="shrink-0 whitespace-nowrap px-2 py-0.5 text-[11px]">
        {m.statusLabel}
      </StatusBadge>
      {creditNote && <CreditNoteChip note={creditNote} />}
      {m.cause && <CauseButton m={m} />}
    </div>
  );
}

// ── Piezas ───────────────────────────────────────────────────────────────

/**
 * Estado DIAN: el semáforo y, debajo, el motivo en una línea (lo que no
 * salió) o la nota crédito que la anula (sólo una aceptada tiene nota).
 */
function StatusCell({ m, creditNote }: { m: RowModel; creditNote: InvoiceCreditNoteInfo | null }) {
  return (
    <div className="min-w-0">
      <div className="flex min-w-0 items-center gap-1.5">
        <StatusBadge tone={m.tone} className="shrink-0 whitespace-nowrap px-2 py-0.5 text-[11px]">
          {m.statusLabel}
        </StatusBadge>
        {creditNote && <CreditNoteChip note={creditNote} compact />}
      </div>
      {m.cause && <CauseButton m={m} className="mt-1" />}
    </div>
  );
}

/** El motivo en una línea; abre el detalle con la respuesta completa. */
function CauseButton({ m, className = "" }: { m: RowModel; className?: string }) {
  const cause = m.cause!;
  return (
    <button
      type="button"
      aria-expanded={m.open}
      aria-controls={m.detailId}
      onClick={() => m.setOpen((v) => !v)}
      title={cause.title}
      className={
        "flex w-full min-w-0 max-w-full items-center gap-1.5 rounded text-left text-xs leading-tight hover:underline " +
        (cause.strong ? STATUS_TEXT.critical : "text-op-muted") +
        " " +
        className
      }
    >
      {cause.rule && (
        <span className="shrink-0 rounded border border-current/25 px-1 font-mono text-[10px] leading-4">
          {cause.rule}
        </span>
      )}
      <span className="min-w-0 truncate">{cause.text}</span>
      <svg
        width="12"
        height="12"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
        className={"shrink-0 transition-transform motion-reduce:transition-none " + (m.open ? "rotate-90" : "")}
      >
        <path d="m9 6 6 6-6 6" />
      </svg>
      <span className="sr-only">{m.open ? m.t("actionHideDetail") : m.t("actionShowDetail")}</span>
    </button>
  );
}

/** Resultado de la última acción y, desplegado, el detalle de la factura. */
function Extra({ row, m }: { row: InvoiceListRow; m: RowModel }) {
  const { t, locale } = m;
  const tCredit = useTranslations("opCreditNotes");
  const errors = row.dian.errors.length ? row.dian.errors : row.dian.reason ? [row.dian.reason] : [];
  const showErrors =
    row.dian.status === "rejected" ||
    row.dian.status === "error_stuck" ||
    row.dian.status === "error_retrying" ||
    (row.dian.status === "not_sent" && !!row.dian.reason);
  const advice = m.causeKey ? row.dian.advice : null;
  return (
    <>
      {m.feedback.length > 0 && <div className="space-y-0.5 pb-2 text-right">{m.feedback}</div>}
      <div
        id={m.detailId}
        hidden={!m.open}
        className="rounded-xl border border-op-border bg-op-bg/70 px-4 py-3 text-left"
      >
        <dl className="grid gap-x-6 gap-y-3 text-[13px] sm:grid-cols-2 @4xl:grid-cols-3">
          <DetailItem label={t("colDian")} wide={!!advice || (showErrors && errors.length > 0)}>
            <span>{t(`statusHelp_${row.dian.status}`)}</span>
            {advice ? (
              // Causa conocida: en palabras claras, qué hacer y el mensaje
              // crudo de la DIAN desplegable (DianCauseNotice de #585).
              <DianCauseNotice
                advice={advice}
                errors={row.dian.errors}
                waiting={row.dian.status === "in_process"}
                fallback={null}
              />
            ) : (
              showErrors &&
              errors.length > 0 && (
              <>
                <span className="mt-2 block font-mono text-[9px] uppercase tracking-[0.12em] text-op-muted">
                  {t("detailDianResponse")}
                </span>
                <ul className="mt-1 space-y-1">
                  {errors.map((e, i) => (
                    <li key={i} className="break-words font-mono text-[11px] leading-snug text-op-text">
                      {e}
                    </li>
                  ))}
                </ul>
              </>
              )
            )}
          </DetailItem>
          {m.retryWarning && <DetailItem label={t("detailWhatToDo")}>{m.retryWarning}</DetailItem>}
          <DetailItem label={t("colEmail")}>
            <span className="break-words">{m.emailText}</span>
          </DetailItem>
          <DetailItem label={t("colCustomer")}>
            {row.customer ? (
              <span className="break-words">
                {row.customer.name}{" "}
                <span className="text-op-muted">
                  {row.customer.docType} <span className="font-mono tabular">{row.customer.docNumber}</span>
                </span>
              </span>
            ) : (
              <span className="text-op-muted">{t("finalConsumer")}</span>
            )}
          </DetailItem>
          <DetailItem label={t("detailOrder")}>
            <Link href={`/operator/orders/${row.orderId}`} prefetch={false} className="font-mono text-op-accent hover:underline">
              {displayOrderCode(row.shortCode)}
            </Link>
            <span className="text-op-muted">{" · "}{formatDate(row.createdAt, { locale })}</span>
          </DetailItem>
          {row.creditNote && (
            <DetailItem label={t("colCreditNote")}>
              <CreditNoteChip note={row.creditNote} />{" "}
              <Link href={CREDIT_NOTES_PATH} prefetch={false} className="text-op-accent hover:underline">
                {tCredit("title")}
              </Link>
            </DetailItem>
          )}
        </dl>
      </div>
    </>
  );
}

function DetailItem({ label, wide, children }: { label: string; wide?: boolean; children: ReactNode }) {
  return (
    <div className={"min-w-0 " + (wide ? "sm:col-span-2" : "")}>
      <dt className="font-mono text-[9px] uppercase tracking-[0.12em] text-op-muted">{label}</dt>
      <dd className="mt-0.5 leading-snug">{children}</dd>
    </div>
  );
}

function CustomerCell({ row }: { row: InvoiceListRow }) {
  const t = useTranslations("opEInvoices");
  if (!row.customer) return <span className="text-[13px] text-op-muted">{t("finalConsumer")}</span>;
  return (
    <div className="min-w-0">
      <div className="truncate text-[13px]" title={row.customer.name}>
        {row.customer.name}
      </div>
      <div className="truncate text-[11px] text-op-muted">
        {row.customer.docType} <span className="font-mono tabular">{row.customer.docNumber}</span>
      </div>
    </div>
  );
}

function Money({ cents }: { cents: number }) {
  const locale = useLocale() as Locale;
  // Facturación electrónica DIAN: siempre pesos colombianos.
  return <>{formatMoney(cents, { currency: "COP", locale })}</>;
}

/** Chip «NC12 · Aceptada» de la nota crédito vigente. */
/**
 * Chip «NC12 · Aceptada» de la nota crédito vigente. En la tabla de una
 * pantalla mediana (`compact`) se ve «NC12» con el ícono de su estado y el
 * estado queda para el lector de pantalla y el puntero; desde 72rem de
 * lista, o en el celular, el chip va entero.
 */
export function CreditNoteChip({ note, compact = false }: { note: InvoiceCreditNoteInfo; compact?: boolean }) {
  const t = useTranslations("opEInvoices");
  const tCredit = useTranslations("opCreditNotes");
  const state = tCredit(`state_${CREDIT_NOTE_STATES.has(note.state) ? note.state : "pending"}`);
  const text = t("creditNote", { number: note.documentNumber, state });
  const bad = note.state === "rejected" || note.state === "error";
  return (
    <span
      title={text}
      className={
        "inline-flex min-w-0 max-w-[11rem] shrink items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] leading-tight " +
        (note.state === "accepted"
          ? "border-op-border-2 bg-op-bg text-op-text"
          : bad
            ? `border-danger/25 bg-danger/10 ${STATUS_TEXT.critical}`
            : "border-op-border bg-op-surface text-op-muted")
      }
    >
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="shrink-0">
        {note.state === "accepted" ? (
          <path d="m5 12.5 4.5 4.5L19 7.5" />
        ) : bad ? (
          <path d="m7 7 10 10M17 7 7 17" />
        ) : (
          <>
            <circle cx="12" cy="12" r="8.5" />
            <path d="M12 7.5V12l3 2" />
          </>
        )}
      </svg>
      {compact ? (
        <span className="min-w-0 truncate">
          {note.documentNumber}
          <span className="sr-only @6xl:not-sr-only">{` · ${state}`}</span>
        </span>
      ) : (
        <span className="min-w-0 truncate">{text}</span>
      )}
    </span>
  );
}

const EMAIL_TONE: Record<InvoiceEmailStatus, string> = {
  sent: STATUS_TEXT.ok,
  failed: STATUS_TEXT.critical,
  pending: STATUS_TEXT.warning,
  no_recipient: "text-op-muted",
  not_applicable: "text-op-muted/60",
};

/** El correo como ícono (✓ enviado, ✕ falló, reloj pendiente, — sin correo). */
function EmailIcon({ status, text }: { status: InvoiceEmailStatus; text: string }) {
  return (
    <span title={text} className={"inline-flex h-6 w-6 items-center justify-center " + EMAIL_TONE[status]}>
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M13 18H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h15a1 1 0 0 1 1 1v6" />
        <path d="m3.5 6 8 6 8-6" />
        {status === "sent" && <path d="m15.5 18 2 2 4-4" />}
        {status === "failed" && <path d="m16 15 5 5m0-5-5 5" />}
        {status === "pending" && <path d="M18.5 14.5v3l2 1.2" />}
        {(status === "no_recipient" || status === "not_applicable") && <path d="M15.5 18h6" />}
      </svg>
      <span className="sr-only">{text}</span>
    </span>
  );
}

function Glyph({ d }: { d: string }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={d} />
    </svg>
  );
}
