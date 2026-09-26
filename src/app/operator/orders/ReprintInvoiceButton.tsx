"use client";

import { useTranslations } from "next-intl";
import { StaffPrintButton } from "@/components/print/StaffPrintButton";
import { invoicePrintHref } from "@/lib/print/staffPrint";

/**
 * "Reimprimir factura" en la lista y el detalle de pedidos: la tirilla
 * sale por el AGENTE, como las comandas (POST
 * /api/operator/orders/[id]/reprint-invoice, a la impresora de facturas
 * elegida en Configuración), y el aviso dice por cuál ("Enviada a Caja ✓",
 * que se va solo) y si salió la factura electrónica o —con la DIAN todavía
 * sin aceptarla— el comprobante (ese aviso se queda: nadie tiene que
 * entregar ese papel como la electrónica).
 *
 * Si el local no tiene impresora de facturas (o su agente no responde), la
 * imprime desde el navegador SIN salir de acá: `/factura/[id]` se carga en
 * un iframe oculto, en una sola página del alto de la factura, y el
 * diálogo sale sobre esta misma pantalla. El aviso lleva a Configuración
 * para elegir una impresora del agente — el driver de Windows es el que
 * cortaba las facturas largas en dos tiras.
 *
 * Toda la lógica vive en `StaffPrintButton` / `staffPrint.ts`, la misma de
 * los demás botones "Imprimir factura" del staff. Va pensado para vivir
 * dentro de un contenedor `flex flex-wrap`: el aviso ocupa la fila entera
 * (`basis-full`) debajo de los botones. Pedidos es del panel del operador,
 * así que quien mira puede entrar a Configuración.
 */
export function ReprintInvoiceButton({
  orderId,
  invoiceId,
}: {
  orderId: string;
  invoiceId: string;
}) {
  const t = useTranslations("opOrders");
  return (
    <StaffPrintButton
      doc={{ kind: "invoice", orderId, href: invoicePrintHref({ invoiceId }) }}
      label={t("reprintInvoice")}
      className="mp-btn mp-btn--secondary mp-btn--sm"
      statusClassName="basis-full text-[11px]"
      canConfigurePrinters
    />
  );
}
