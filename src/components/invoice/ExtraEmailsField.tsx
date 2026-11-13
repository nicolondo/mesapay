"use client";

import { useId } from "react";
import { useTranslations } from "next-intl";
import { MAX_EXTRA_INVOICE_EMAILS, MAX_INVOICE_EMAILS } from "@/lib/invoiceEmails";

/**
 * Correos ADICIONALES de una factura: una lista con "+ Agregar correo" y un
 * "✕" por fila. El principal va aparte (es el que viaja en el XML de la
 * DIAN); estos reciben la factura en copia. La validación y el tope de
 * verdad están en el servidor (src/lib/invoiceEmails.ts); acá sólo se
 * marca la fila que el servidor rechazó (`invalidIndex`).
 *
 * La usan la factura personalizada del personal (`InvoiceFormSheet`) y el
 * formulario de Clientes (`CustomerForm`).
 */
export function ExtraEmailsField({
  value,
  onChange,
  invalidIndex = null,
  disabled = false,
  inputClassName = "mt-1 w-full h-11 px-3 rounded-lg border border-hairline bg-ivory text-sm focus:outline-none focus:border-terracotta",
  labelClassName = "font-mono text-[10px] tracking-wider uppercase text-muted",
}: {
  value: string[];
  onChange: (next: string[]) => void;
  /** Fila que el servidor marcó como correo inválido. */
  invalidIndex?: number | null;
  disabled?: boolean;
  inputClassName?: string;
  labelClassName?: string;
}) {
  const t = useTranslations("invoiceEmails");
  const id = useId();
  const full = value.length >= MAX_EXTRA_INVOICE_EMAILS;
  return (
    <div role="group" aria-labelledby={`${id}-label`}>
      <span id={`${id}-label`} className={"block " + labelClassName}>
        {t("label")}
      </span>
      {value.length > 0 && (
        <ul className="space-y-2">
          {value.map((email, index) => (
            <li key={index} className="flex items-start gap-2">
              <input
                type="email"
                inputMode="email"
                autoComplete="off"
                value={email}
                disabled={disabled}
                aria-label={t("itemLabel", { n: index + 1 })}
                aria-invalid={invalidIndex === index}
                placeholder={t("placeholder")}
                maxLength={160}
                onChange={(e) => onChange(value.map((v, i) => (i === index ? e.target.value : v)))}
                className={inputClassName + " min-w-0 flex-1" + (invalidIndex === index ? " border-danger" : "")}
              />
              <button
                type="button"
                disabled={disabled}
                onClick={() => onChange(value.filter((_, i) => i !== index))}
                aria-label={t("remove", { n: index + 1 })}
                className="mt-1 h-11 w-11 shrink-0 rounded-lg border border-hairline text-muted hover:text-danger"
              >
                {"✕"}
              </button>
            </li>
          ))}
        </ul>
      )}
      <button
        type="button"
        disabled={disabled || full}
        onClick={() => onChange([...value, ""])}
        className="mt-2 text-sm text-terracotta hover:underline disabled:opacity-50 disabled:no-underline"
      >
        {t("add")}
      </button>
      <p className="text-[11px] text-muted mt-1">{t("hint", { max: MAX_INVOICE_EMAILS })}</p>
    </div>
  );
}
