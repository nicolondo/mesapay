"use client";

import { useCallback, useEffect, useId, useState } from "react";
import { useTranslations } from "next-intl";
import {
  needsTerminalPicker,
  readRememberedTerminal,
  rememberTerminal,
  resolveTerminalChoice,
  terminalChoiceStorageKey,
  type TerminalChoiceDevice,
} from "@/lib/payments/terminalChoice";

/** localStorage del navegador, o null si no existe o no se deja leer. */
function browserStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

/**
 * A qué datáfono mandar el cobro (ver lib/payments/terminalChoice.ts): con
 * uno solo, ése; con varios, el último elegido en este aparato, o ninguno
 * hasta que se elija. El recuerdo se lee recién en el navegador, para no
 * desarmar la hidratación.
 */
export function useTerminalChoice<D extends TerminalChoiceDevice>(devices: readonly D[], tenantSlug: string) {
  const key = terminalChoiceStorageKey(tenantSlug);
  const [remembered, setRemembered] = useState<string | null>(null);

  useEffect(() => {
    const timer = setTimeout(() => setRemembered(readRememberedTerminal(browserStorage(), key)), 0);
    return () => clearTimeout(timer);
  }, [key]);

  const choose = useCallback(
    (deviceId: string) => {
      setRemembered(deviceId);
      rememberTerminal(browserStorage(), key, deviceId);
    },
    [key],
  );

  return {
    selected: resolveTerminalChoice(devices, remembered),
    choose,
    needsPicker: needsTerminalPicker(devices),
  };
}

/**
 * "¿A qué datáfono?": un botón por datáfono disponible, con el elegido
 * marcado. No se muestra con uno solo (ése es el único destino posible).
 */
export function TerminalPicker({
  devices,
  selectedId,
  onChoose,
  disabled = false,
  variant = "op",
}: {
  devices: readonly TerminalChoiceDevice[];
  selectedId: string | null;
  onChoose: (deviceId: string) => void;
  disabled?: boolean;
  /** `pay`: pantalla de cobro (colores del checkout); `op`: Salón y Mesas en vivo. */
  variant?: "pay" | "op";
}) {
  const t = useTranslations("terminalPicker");
  const labelId = useId();
  if (!needsTerminalPicker(devices)) return null;
  const idle =
    variant === "pay" ? "border-hairline bg-paper text-ink" : "border-op-border bg-op-bg text-ink";
  return (
    <div className="space-y-1.5">
      <div
        id={labelId}
        className={
          "font-mono text-[10px] tracking-wider uppercase " + (variant === "pay" ? "text-muted" : "text-op-muted")
        }
      >
        {t("question")}
      </div>
      <div role="radiogroup" aria-labelledby={labelId} className="flex flex-wrap gap-2">
        {devices.map((d) => {
          const checked = d.id === selectedId;
          return (
            <button
              key={d.id}
              type="button"
              role="radio"
              aria-checked={checked}
              disabled={disabled}
              onClick={() => onChoose(d.id)}
              className={
                "min-h-10 px-3 rounded-full border text-sm disabled:opacity-50 " +
                (checked ? "border-terracotta bg-terracotta text-bone font-medium" : idle)
              }
            >
              {d.label}
            </button>
          );
        })}
      </div>
      {!selectedId && (
        <p className={"text-[11px] leading-snug " + (variant === "pay" ? "text-muted-2" : "text-op-muted")}>
          {t("pickHint")}
        </p>
      )}
    </div>
  );
}
