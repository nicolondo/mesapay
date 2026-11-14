"use client";

import { useTranslations } from "next-intl";
import type { PayStatus, PoStatus } from "@/lib/erp/purchaseList";

/** Consecutivo legible "0007" — el prefijo (OC/PO) vive en i18n. */
export function padNumber(n: number): string {
  return String(n).padStart(4, "0");
}

export const STATUS_KEYS: Record<PoStatus, string> = {
  draft: "statusDraft",
  sent: "statusSent",
  partially_received: "statusPartial",
  received: "statusReceived",
  canceled: "statusCanceled",
};

// Colores por estado: neutro (borrador), tinta (enviada), ámbar (parcial),
// ok (recibida), danger (anulada) — mismos tokens del design system.
const STATUS_CHIP_CLS: Record<PoStatus, string> = {
  draft: "bg-paper text-op-muted",
  sent: "bg-ink text-bone",
  partially_received: "bg-[#C98A2E]/15 text-[#7F5A1F]",
  received: "bg-ok/10 text-ok",
  canceled: "bg-danger/10 text-danger",
};

export function StatusChip({ status }: { status: PoStatus }) {
  const t = useTranslations("opErp");
  return (
    <span
      className={
        "px-2 h-5 inline-flex items-center rounded-full text-[10px] font-medium shrink-0 " +
        STATUS_CHIP_CLS[status]
      }
    >
      {t(STATUS_KEYS[status])}
    </span>
  );
}

export const PAY_STATUS_KEYS: Record<PayStatus, string> = {
  paid: "payStatusPaid",
  partial: "payStatusPartial",
  overdue: "payStatusOverdue",
  pending: "payStatusPending",
};

// Colores por estado de pago — mismos tokens: ok (pagada), ámbar (parcial),
// danger (vencida), neutro (pendiente).
const PAY_STATUS_CLS: Record<PayStatus, string> = {
  paid: "bg-ok/10 text-ok",
  partial: "bg-[#C98A2E]/15 text-[#7F5A1F]",
  overdue: "bg-danger/10 text-danger",
  pending: "bg-paper text-op-muted",
};

export function PayStatusChip({ status }: { status: PayStatus }) {
  const t = useTranslations("opErp");
  return (
    <span
      className={
        "px-2 h-5 inline-flex items-center rounded-full text-[10px] font-medium shrink-0 " +
        PAY_STATUS_CLS[status]
      }
    >
      {t(PAY_STATUS_KEYS[status])}
    </span>
  );
}
