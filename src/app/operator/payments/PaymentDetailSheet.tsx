"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { fmtCOP } from "@/lib/format";

export type PaymentCardInfo = {
  brand: string | null;
  last4: string | null;
  type: string | null; // CREDIT / DEBIT (crudo de Kushki)
  bin: string | null;
  holder: string | null;
  approvalCode: string | null;
  processor: string | null;
  reference: string | null; // transactionReference / kushkiTxId
};

export type PaymentDetail = {
  shortCode: string;
  methodLabel: string; // ya traducido en el server
  statusLabel: string; // ya traducido en el server
  statusKind: string; // approved | declined | ...
  amountCents: number;
  tipCents: number;
  createdAtISO: string;
  card: PaymentCardInfo;
};

/** "Visa ···· 0063" — resumen compacto para la celda de la tabla. */
export function cardSummary(card: PaymentCardInfo): string | null {
  if (!card.brand && !card.last4) return null;
  const parts: string[] = [];
  if (card.brand) parts.push(card.brand);
  if (card.last4) parts.push("···· " + card.last4);
  return parts.join(" ");
}

/**
 * Chip clickeable con la tarjeta que abre un drawer con TODO el detalle rico
 * del cobro (marca, tipo, titular, código de aprobación, procesador,
 * referencia Kushki...). Sólo se renderiza para pagos que tienen esos datos.
 */
export function PaymentDetailSheet({ detail }: { detail: PaymentDetail }) {
  const t = useTranslations("opPayments");
  const [open, setOpen] = useState(false);
  const summary = cardSummary(detail.card);
  const typeLabel =
    detail.card.type === "CREDIT"
      ? t("cardCredit")
      : detail.card.type === "DEBIT"
        ? t("cardDebit")
        : detail.card.type;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1.5 rounded-full border border-op-border bg-op-bg px-2.5 py-1 text-xs font-medium text-op-text hover:border-op-text/30 transition-colors"
        aria-label={t("viewDetail")}
      >
        <span aria-hidden className="text-op-muted">
          {"◧"}
        </span>
        <span className="tabular">{summary}</span>
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center bg-ink/40 p-0 md:items-center md:p-6"
          onClick={() => setOpen(false)}
        >
          <div
            className="max-h-[90dvh] w-full overflow-y-auto rounded-t-3xl border border-op-border bg-op-surface p-5 md:max-w-md md:rounded-3xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="font-mono text-[10px] uppercase tracking-[0.15em] text-op-muted">
                  {detail.shortCode}
                </div>
                <h2 className="mt-1 font-display text-2xl">{t("detailTitle")}</h2>
              </div>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="shrink-0 text-op-muted"
                aria-label={t("close")}
              >
                {"✕"}
              </button>
            </div>

            <div className="mt-4 flex items-baseline justify-between border-b border-op-border pb-3">
              <span className="font-mono text-[10px] uppercase tracking-wider text-op-muted">
                {t("fPaid")}
              </span>
              <span className="font-display text-2xl tabular">
                {fmtCOP(detail.amountCents)}
              </span>
            </div>

            <dl className="mt-3 space-y-2.5 text-sm">
              {detail.tipCents > 0 && (
                <DRow label={t("fTip")} value={fmtCOP(detail.tipCents)} />
              )}
              <DRow label={t("fMethod")} value={detail.methodLabel} />
              <DRow
                label={t("fStatus")}
                value={detail.statusLabel}
                valueClass={statusTint(detail.statusKind)}
              />
              {summary && (
                <DRow
                  label={t("fCard")}
                  value={typeLabel ? summary + " · " + typeLabel : summary}
                />
              )}
              {detail.card.holder && (
                <DRow label={t("fHolder")} value={detail.card.holder} />
              )}
              {detail.card.approvalCode && (
                <DRow
                  label={t("fApproval")}
                  value={detail.card.approvalCode}
                  mono
                />
              )}
              {detail.card.processor && (
                <DRow label={t("fProcessor")} value={detail.card.processor} />
              )}
              {detail.card.bin && (
                <DRow label={t("fBin")} value={detail.card.bin} mono />
              )}
              {detail.card.reference && (
                <DRow
                  label={t("fReference")}
                  value={detail.card.reference}
                  mono
                />
              )}
              <DRow
                label={t("fDate")}
                value={new Date(detail.createdAtISO).toLocaleString("es-CO")}
              />
            </dl>

            <button
              type="button"
              onClick={() => setOpen(false)}
              className="mp-btn mp-btn--secondary mp-btn--block mt-5"
            >
              {t("close")}
            </button>
          </div>
        </div>
      )}
    </>
  );
}

function DRow({
  label,
  value,
  valueClass = "",
  mono = false,
}: {
  label: string;
  value: string;
  valueClass?: string;
  mono?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="shrink-0 font-mono text-[10px] uppercase tracking-wider text-op-muted">
        {label}
      </dt>
      <dd className={"text-right " + (mono ? "font-mono tabular " : "") + valueClass}>
        {value}
      </dd>
    </div>
  );
}

function statusTint(s: string) {
  switch (s) {
    case "approved":
      return "text-ok";
    case "declined":
      return "text-danger";
    case "refunded":
      return "text-op-muted";
    default:
      return "text-[#C98A2E]";
  }
}
