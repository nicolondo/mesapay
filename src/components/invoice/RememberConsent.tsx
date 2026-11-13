"use client";

import { useId, useState, type ReactNode } from "react";
import { useTranslations } from "next-intl";

/**
 * La autorización de "Recordar mis datos" (Ley 1581) sin que ocupe la
 * pantalla. El dueño: «quiero que sea desplegable, no que aparezca todo
 * completo ocupando espacio, y que por defecto esté activo».
 *
 *  - UNA fila: la casilla, MARCADA por defecto, con su texto.
 *  - Debajo, un control discreto («¿Qué guardamos?» + chevron) que
 *    despliega el resumen: qué se guarda, para qué, que al volver sólo se
 *    ve enmascarado, que se puede desmarcar, y el enlace a la política de
 *    privacidad. CERRADO por defecto.
 *  - Accesible: es un <button> (Enter/Espacio), con `aria-expanded` y
 *    `aria-controls` hacia la región, que existe siempre y va `hidden`
 *    mientras está cerrada (no ocupa espacio).
 *
 * `SavedDataDisclosure` es el mismo desplegable sin casilla, para la
 * pantalla de los datos enmascarados ("¿Son estos tus datos?").
 *
 * Claves i18n en el namespace `done` (como el resto de la factura).
 */

function PolicyLink(chunks: ReactNode) {
  return (
    <a
      href="/privacidad"
      target="_blank"
      rel="noreferrer"
      className="underline underline-offset-2 hover:text-ink"
    >
      {chunks}
    </a>
  );
}

function Disclosure({
  label,
  children,
  defaultOpen,
  className = "",
}: {
  label: string;
  children: ReactNode;
  defaultOpen: boolean;
  className?: string;
}) {
  const regionId = useId();
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className={className}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={regionId}
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1 rounded text-[12px] text-muted underline-offset-2 hover:text-ink hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-terracotta/40"
      >
        {label}
        <svg
          aria-hidden="true"
          viewBox="0 0 16 16"
          className={"h-3 w-3 transition-transform " + (open ? "rotate-180" : "")}
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M4 6l4 4 4-4" />
        </svg>
      </button>
      <div id={regionId} hidden={!open} className="mt-1.5 text-[12px] leading-snug text-muted">
        {children}
      </div>
    </div>
  );
}

/** Casilla "Recordar mis datos" (marcada por defecto) + "¿Qué guardamos?" plegado. */
export function RememberConsent({
  checked,
  onCheckedChange,
  operatorMode = false,
  restaurantName = null,
  defaultOpen = false,
}: {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  /** El personal pide por el cliente: tercera persona. */
  operatorMode?: boolean;
  /** Nombre del comercio para el texto; sin él, "este comercio". */
  restaurantName?: string | null;
  /** Sólo para pruebas/capturas: el desplegable arranca abierto. */
  defaultOpen?: boolean;
}) {
  const t = useTranslations("done");
  const checkboxId = useId();
  return (
    <div>
      <div className="flex items-start gap-2.5">
        <input
          id={checkboxId}
          type="checkbox"
          checked={checked}
          onChange={(e) => onCheckedChange(e.target.checked)}
          className="mt-0.5 h-4 w-4 shrink-0 accent-terracotta"
        />
        <label htmlFor={checkboxId} className="text-[13px] leading-snug">
          {operatorMode
            ? t("invRememberOp")
            : restaurantName
              ? t("invRemember", { restaurant: restaurantName })
              : t("invRememberGeneric")}
        </label>
      </div>
      <Disclosure
        label={t(operatorMode ? "invWhatWeSaveOp" : "invWhatWeSave")}
        defaultOpen={defaultOpen}
        className="mt-1 pl-[26px]"
      >
        {t.rich(operatorMode ? "invRememberDetailsOp" : "invRememberDetails", { link: PolicyLink })}
      </Disclosure>
    </div>
  );
}

/** El mismo desplegable, sin casilla, debajo de los datos enmascarados. */
export function SavedDataDisclosure({ defaultOpen = false }: { defaultOpen?: boolean }) {
  const t = useTranslations("done");
  return (
    <Disclosure label={t("invWhatWeSave")} defaultOpen={defaultOpen} className="text-center">
      <p className="text-left">{t.rich("invSavedDetails", { link: PolicyLink })}</p>
    </Disclosure>
  );
}
