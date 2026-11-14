"use client";

import { useTranslations } from "next-intl";
import { StaffPrintButton } from "@/components/print/StaffPrintButton";
import { invoicePrintHref } from "@/lib/print/staffPrint";

/**
 * Imprimir desde el DATÁFONO: la precuenta de una cuenta abierta (para
 * llevarla a la mesa antes de cobrar) y la factura —o el comprobante— de
 * una cuenta ya facturada.
 *
 * Con «Imprimir en: Impresora de caja · Este dispositivo» encima. El
 * usuario Datáfono arranca en «Este dispositivo»: la tirilla sale en la
 * impresora integrada del Smart POS (Sunmi P3) por Kushki (ver
 * `lib/print/terminalPrint.ts`). La elección queda recordada en el equipo.
 */
export function TerminalPrintActions({
  orderId,
  invoiceId,
  canPrebill,
}: {
  orderId: string | null;
  invoiceId: string | null;
  /** Cuenta abierta con platos: hay precuenta que imprimir. */
  canPrebill: boolean;
}) {
  const tr = useTranslations("opTerminal");
  if (!orderId || (!invoiceId && !canPrebill)) return null;
  const buttonClass =
    "w-full h-11 rounded-full border border-ink bg-paper text-ink text-sm font-medium disabled:opacity-60";
  return (
    <section className="space-y-2 rounded-xl border border-hairline bg-paper p-3">
      {invoiceId ? (
        <StaffPrintButton
          doc={{ kind: "invoice", orderId, href: invoicePrintHref({ invoiceId }) }}
          label={tr("printInvoice")}
          className={buttonClass}
          statusClassName="block text-xs leading-snug"
          destinationVariant="pay"
        />
      ) : (
        <StaffPrintButton
          doc={{ kind: "prebill", orderId, href: `/terminal/precuenta/${orderId}` }}
          label={tr("printPrebill")}
          className={buttonClass}
          statusClassName="block text-xs leading-snug"
          destinationVariant="pay"
        />
      )}
    </section>
  );
}
