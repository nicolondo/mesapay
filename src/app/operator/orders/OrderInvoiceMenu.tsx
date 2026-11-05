"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { InvoiceActions } from "./InvoiceActions";

/**
 * Menú «⋯» de la factura en cada fila de la lista de Órdenes: ver,
 * reimprimir y —con la DIAN aceptada— reenviar por correo (las mismas
 * acciones de `InvoiceActions`, que también usa el detalle). En la fila
 * queda sólo el número; las acciones aparecen al tocar el botón.
 *
 * Es un botón que despliega un panel (no un `role="menu"`): se cierra con
 * Escape, tocando afuera o con el mismo botón, y el aviso de la impresión
 * («Enviada a Caja ✓») se ve dentro del panel mientras sigue abierto.
 * Vive por encima del enlace que cubre la fila (`relative z-10`).
 */
export function OrderInvoiceMenu({
  orderId,
  invoiceId,
  dianDocumentId,
  number,
}: {
  orderId: string;
  invoiceId: string;
  dianDocumentId: string | null;
  /** «FECT1202», para el rótulo del botón y el título del panel. */
  number: string;
}) {
  const t = useTranslations("opOrders");
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const panelId = useId();

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const label = t("invoiceActionsFor", { number });
  return (
    // Abierto sube por encima de los botones de las filas siguientes.
    <div ref={box} className={"relative " + (open ? "z-30" : "z-10")}>
      <button
        type="button"
        aria-label={label}
        title={label}
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((v) => !v)}
        className="mp-icobtn lg:!h-8 lg:!w-8"
      >
        <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden fill="currentColor">
          <circle cx="3" cy="8" r="1.5" />
          <circle cx="8" cy="8" r="1.5" />
          <circle cx="13" cy="8" r="1.5" />
        </svg>
      </button>
      {open && (
        <div
          id={panelId}
          className="absolute right-0 top-full z-30 mt-1 w-64 rounded-xl border border-op-border bg-op-surface p-2 text-left shadow-lg [&_.mp-btn]:w-full [&_.mp-btn]:!justify-start"
        >
          <div className="px-2 pb-2 pt-1 font-mono text-[10px] uppercase tracking-[0.14em] text-op-muted">
            {t("invoiceMenuTitle", { number })}
          </div>
          <InvoiceActions orderId={orderId} invoiceId={invoiceId} dianDocumentId={dianDocumentId} />
        </div>
      )}
    </div>
  );
}
