"use client";

import { useTranslations } from "next-intl";
import { sanitizeDecimalInput } from "@/lib/decimalInput";

/**
 * Control de descuento de la orden de compra (#393): valor + botón que
 * alterna entre % y valor fijo en la moneda. El mismo en la orden, la
 * revisión de la factura y la recepción. `inline` = solo el control (para
 * ir dentro de una fila); si no, con su etiqueta a la izquierda. También lo
 * usa el impuesto al consumo de la línea (% de la base o valor fijo), con
 * su propio `placeholder`.
 */
export function DiscountControl({
  id,
  label,
  raw,
  isPct,
  currency,
  onChange,
  inline = false,
  hint,
  className,
  placeholder,
}: {
  id?: string;
  label: string;
  raw: string;
  isPct: boolean;
  currency: string;
  onChange: (raw: string, isPct: boolean) => void;
  inline?: boolean;
  hint?: string;
  className?: string;
  placeholder?: string;
}) {
  const t = useTranslations("opErp");
  const control = (
    <div className="flex items-center gap-1 shrink-0">
      <input
        id={id}
        type="text"
        inputMode="decimal"
        value={raw}
        onChange={(e) => onChange(sanitizeDecimalInput(e.target.value), isPct)}
        placeholder={placeholder ?? t("discountPlaceholder")}
        aria-label={label}
        className={(inline ? "w-16" : "w-20") + " min-h-[36px] px-2 rounded-lg border border-op-border bg-op-bg text-xs text-right tabular"}
      />
      <button
        type="button"
        onClick={() => onChange(raw, !isPct)}
        aria-label={t("discountToggleUnit")}
        className="min-h-[36px] w-8 rounded-lg border border-op-border bg-op-bg text-xs font-mono"
      >
        {isPct ? "%" : currency}
      </button>
    </div>
  );
  if (inline) return control;
  return (
    <div className={className}>
      <div className="flex items-center justify-between gap-2">
        <label htmlFor={id} className="text-[11px] text-op-muted">{label}</label>
        {control}
      </div>
      {hint && <p className="mt-1 text-[10px] text-op-muted">{hint}</p>}
    </div>
  );
}
