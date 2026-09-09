"use client";

import { useTranslations } from "next-intl";

/**
 * Las dos salidas de factura, siempre juntas y con la misma jerarquía:
 * genérica (sólo correo, consumidor final) o personalizada (con datos).
 *
 * Se usa en el checkout (donde ahora se pide la factura) y en el acceso
 * discreto de la pantalla de "listo", para el que cambió de opinión.
 */
export function InvoiceChoiceButtons({
  operatorMode = false,
  onPickSimple,
  onPickFormal,
}: {
  operatorMode?: boolean;
  onPickSimple: () => void;
  onPickFormal: () => void;
}) {
  const t = useTranslations("done");
  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={onPickSimple}
        className="w-full h-12 rounded-full bg-ink text-bone font-medium"
      >
        {t(operatorMode ? "invSendEmailOp" : "invSendEmail")}
      </button>
      <button
        type="button"
        onClick={onPickFormal}
        className="w-full h-11 rounded-full border border-hairline bg-paper text-ink text-sm font-medium"
      >
        {t(operatorMode ? "invToNameOp" : "invToName")}
      </button>
    </div>
  );
}
