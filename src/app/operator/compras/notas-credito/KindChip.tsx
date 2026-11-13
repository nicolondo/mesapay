"use client";

import { useTranslations } from "next-intl";
import { KIND_LABEL_KEY, type SupplierCreditNoteKind } from "@/lib/erp/supplierCreditNotes";

const TONE: Record<SupplierCreditNoteKind, string> = {
  agreement: "bg-[#2F6B4F]/10 text-[#2F6B4F]",
  discount: "bg-[#C98A2E]/12 text-[#7F5A1F]",
  conditional_discount: "bg-[#3B5B8C]/10 text-[#3B5B8C]",
  return: "bg-op-bg text-op-muted border border-op-border",
};

/** Tipo de nota crédito como chip (acuerdo, descuento, pronto pago, devolución). */
export function KindChip({ kind }: { kind: SupplierCreditNoteKind }) {
  const t = useTranslations("opSupplierCredit");
  return (
    <span className={"inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium whitespace-nowrap " + TONE[kind]}>
      {t(KIND_LABEL_KEY[kind])}
    </span>
  );
}
