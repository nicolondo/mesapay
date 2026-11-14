"use client";

import { useEffect, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import type { Locale } from "@/i18n/config";
import { formatDate, formatMoney } from "@/lib/format";
import {
  normalizeDocumentNumber,
  type DuplicateConflictCode,
  type ExistingSupplierDocument,
} from "@/lib/erp/documentNumber";

/**
 * Aviso de factura de proveedor repetida, para cualquier formulario de alta
 * (compras con IA, compra manual, número de factura de una orden, gastos).
 *
 *  · `duplicate_document` (o el aviso temprano `early`): esa factura del
 *    proveedor ya está registrada — se dice cuál (compra o gasto, número,
 *    fecha, total) con un enlace para abrirla en otra pestaña (lo que se
 *    está digitando no se pierde). Al guardar, el servidor la bloquea.
 *  · `possible_duplicate`: sin número de factura, otro documento del mismo
 *    proveedor, día y total. Se puede guardar igual (`onConfirm`).
 */
export function DuplicateDocumentAlert({
  code,
  existing,
  currency,
  onConfirm,
  busy = false,
}: {
  code: DuplicateConflictCode | "early";
  existing: ExistingSupplierDocument;
  currency: string;
  /** Sólo con `possible_duplicate`: «Guardar de todas formas». */
  onConfirm?: () => void;
  busy?: boolean;
}) {
  const t = useTranslations("supplierDocuments");
  const tErp = useTranslations("opErp");
  const locale = useLocale() as Locale;
  const soft = code === "possible_duplicate";

  const doc =
    existing.kind === "purchase" && existing.purchaseNumber != null
      ? t("refPurchase", { number: tErp("poNumber", { number: String(existing.purchaseNumber).padStart(4, "0") }) })
      : t("refExpense");
  const facts = [
    existing.number ? t("refInvoice", { number: existing.number }) : t("refNoNumber"),
    existing.supplierName,
    existing.date ? formatDate(existing.date, { locale, timeStyle: undefined }) : null,
    formatMoney(existing.totalCents, { currency, locale }),
  ].filter(Boolean);

  return (
    <div
      role={soft ? "status" : "alert"}
      className={
        "rounded-2xl border p-3.5 text-sm " +
        (soft ? "border-[#C98A2E]/35 bg-[#C98A2E]/10" : "border-danger/25 bg-danger/5")
      }
    >
      <p className={"font-medium " + (soft ? "text-[#7F5A1F]" : "text-danger")}>
        {t(code === "possible_duplicate" ? "possibleTitle" : code === "early" ? "earlyTitle" : "dupTitle")}
      </p>
      <p className="mt-1 text-op-text">
        <span className="font-medium">{doc}</span>
        {" · "}
        {facts.join(" · ")}
      </p>
      <p className="mt-1 text-xs text-op-muted">
        {t(code === "possible_duplicate" ? "possibleBody" : code === "early" ? "earlyBody" : "dupBody")}
      </p>
      <div className="mt-2.5 flex flex-wrap items-center gap-2">
        <a
          href={existing.href}
          target="_blank"
          rel="noopener noreferrer"
          className="mp-btn mp-btn--secondary mp-btn--sm"
        >
          {t(existing.kind === "purchase" ? "openPurchase" : "openExpense")}
          <span className="sr-only">{` (${t("opensNewTab")})`}</span>
        </a>
        {soft && onConfirm && (
          <button type="button" onClick={onConfirm} disabled={busy} className="mp-btn mp-btn--primary mp-btn--sm">
            {t("saveAnyway")}
          </button>
        )}
      </div>
    </div>
  );
}

const CHECK_DEBOUNCE_MS = 450;

/**
 * Aviso temprano: mientras se digita (o al abrir la revisión de una factura
 * leída con IA), pregunta si esa factura del proveedor ya está registrada.
 * Devuelve el documento existente o null. Sólo avisa: el bloqueo de verdad
 * lo hace el servidor al guardar, bajo candado.
 */
export function useDuplicateDocumentCheck(input: {
  supplierId: string | null;
  /** NIT de un proveedor que aún no existe. */
  taxId?: string | null;
  number: string | null | undefined;
  excludePurchaseId?: string | null;
  excludeExpenseId?: string | null;
}): ExistingSupplierDocument | null {
  const numberKey = normalizeDocumentNumber(input.number);
  const qs = new URLSearchParams();
  if (numberKey && (input.supplierId || input.taxId?.trim())) {
    qs.set("number", (input.number ?? "").trim());
    if (input.supplierId) qs.set("supplierId", input.supplierId);
    else if (input.taxId) qs.set("taxId", input.taxId.trim());
    if (input.excludePurchaseId) qs.set("excludePurchaseId", input.excludePurchaseId);
    if (input.excludeExpenseId) qs.set("excludeExpenseId", input.excludeExpenseId);
  }
  const key = qs.has("number") ? qs.toString() : "";
  // El resultado viaja con la consulta que lo produjo: si lo digitado cambia,
  // el aviso viejo deja de valer sin resetear estado dentro del efecto.
  const [result, setResult] = useState<{ key: string; doc: ExistingSupplierDocument | null } | null>(null);

  useEffect(() => {
    if (!key) return;
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const r = await fetch(`/api/operator/supplier-documents/duplicates?${key}`);
        if (!r.ok) return;
        const j = (await r.json()) as { duplicate?: ExistingSupplierDocument | null };
        if (!cancelled) setResult({ key, doc: j.duplicate ?? null });
      } catch {
        // Sin red: el servidor igual bloquea al guardar.
      }
    }, CHECK_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [key]);

  return key && result?.key === key ? result.doc : null;
}
