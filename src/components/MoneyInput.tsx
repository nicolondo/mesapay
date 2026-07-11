"use client";

import { useLocale } from "next-intl";
import { groupThousands } from "@/lib/format";
import type { Locale } from "@/i18n/config";

/**
 * Input de dinero con separadores de miles. Drop-in del `<input type="number">`
 * de plata: el padre guarda `value` como dígitos crudos (pesos ENTEROS) y
 * recibe en `onChange` los dígitos limpios (sin separadores), así el
 * `pesosToCents` del padre sigue funcionando sin cambios. Muestra el valor
 * agrupado según el locale ("2.000.000"). Solo enteros — los inputs de
 * COP/MXN no manejan centavos.
 */
export function MoneyInput({
  value,
  onChange,
  className,
  placeholder,
  id,
  name,
  disabled,
  required,
  autoFocus,
  onBlur,
  ariaLabel,
}: {
  /** Dígitos crudos del monto en pesos (sin separadores). */
  value: string;
  /** Recibe los dígitos limpios (sin separadores de miles). */
  onChange: (digits: string) => void;
  className?: string;
  placeholder?: string;
  id?: string;
  name?: string;
  disabled?: boolean;
  required?: boolean;
  autoFocus?: boolean;
  onBlur?: () => void;
  ariaLabel?: string;
}) {
  const locale = useLocale() as Locale;
  return (
    <input
      type="text"
      inputMode="numeric"
      value={groupThousands(value, locale)}
      onChange={(e) => onChange(e.target.value.replace(/\D/g, "").slice(0, 12))}
      className={className}
      placeholder={placeholder}
      id={id}
      name={name}
      disabled={disabled}
      required={required}
      autoFocus={autoFocus}
      onBlur={onBlur}
      aria-label={ariaLabel}
    />
  );
}
