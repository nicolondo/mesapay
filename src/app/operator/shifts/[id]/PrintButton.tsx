"use client";

import { useTranslations } from "next-intl";
import { StaffPrintButton } from "@/components/print/StaffPrintButton";

/**
 * Imprimir el cierre del turno.
 *
 *   - «Imprimir cierre»: la TIRILLA (resumen, arqueo, por método y por
 *     mesero), con «Imprimir en: Impresora de caja · Este dispositivo»
 *     encima —recordado en el equipo—. Por la caja sale por el agente,
 *     como la factura; en «Este dispositivo», al papel del equipo (el
 *     datáfono, un celular con impresora). Ver `shiftCloseQueue.ts`.
 *   - «Imprimir reporte completo»: esta misma página en hoja (con la lista
 *     de pagos uno por uno), por el diálogo del navegador, como antes.
 */
export function PrintButton({ shiftId }: { shiftId: string }) {
  const t = useTranslations("opShifts");
  return (
    <div className="flex flex-wrap items-center justify-end gap-2">
      <StaffPrintButton
        doc={{ kind: "shift", shiftId, href: `/operator/shifts/${shiftId}/tirilla` }}
        label={t("printTicket")}
        className="mp-btn mp-btn--primary mp-btn--sm"
        statusClassName="basis-full order-last text-right text-[11px]"
        destinationClassName="basis-full order-first"
        canConfigurePrinters
      />
      <button
        type="button"
        onClick={() => window.print()}
        className="mp-btn mp-btn--secondary mp-btn--sm"
      >
        {t("printFullReport")}
      </button>
    </div>
  );
}
