"use client";

import { useEffect, useEffectEvent, useRef } from "react";
import { useTranslations } from "next-intl";
import { CustomerForm } from "./CustomerForm";
import type { BillingCustomerRecord } from "./types";

/**
 * Alta / edición de un cliente en una hoja: abajo en el celular, centrada
 * en el escritorio. Antes el formulario se abría arriba de la lista, lejos
 * de la fila que se estaba editando; con la lista paginada la hoja aparece
 * donde uno está. Escape o tocar afuera cierra; al cerrar el foco vuelve al
 * botón que la abrió.
 */
export function CustomerFormSheet({
  initial,
  onClose,
  onSaved,
}: {
  initial: BillingCustomerRecord | null;
  onClose: () => void;
  onSaved: (customer: BillingCustomerRecord) => void;
}) {
  const t = useTranslations("billingCustomers");
  const panel = useRef<HTMLDivElement>(null);
  const close = useEffectEvent(() => onClose());
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    panel.current?.querySelector<HTMLElement>("input, select")?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("keydown", onKey);
    const { overflow } = document.body.style;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = overflow;
      opener?.focus?.();
    };
  }, []);
  return (
    <div className="fixed inset-0 z-50 bg-ink/40 flex items-end md:items-center justify-center p-0 md:p-6" onClick={onClose}>
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label={t(initial ? "editTitle" : "createTitle")}
        onClick={(e) => e.stopPropagation()}
        className="relative w-full md:max-w-2xl max-h-[92dvh] overflow-y-auto rounded-t-3xl md:rounded-3xl border border-hairline bg-paper shadow-[var(--shadow-3)]"
      >
        <button
          type="button"
          onClick={onClose}
          aria-label={t("close")}
          className="mp-icobtn absolute right-3 top-3 z-10 border-transparent! bg-transparent!"
        >
          <svg aria-hidden viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M6 6l12 12M18 6 6 18" />
          </svg>
        </button>
        <CustomerForm
          key={initial?.id ?? "new"}
          initial={initial}
          onCancel={onClose}
          onSaved={onSaved}
          className="p-5 sm:p-6"
        />
      </div>
    </div>
  );
}
