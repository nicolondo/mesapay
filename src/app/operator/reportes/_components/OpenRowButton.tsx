"use client";

import type { ReactNode } from "react";
import { useDrillOpen } from "./useDrillOpen";

/**
 * Atajo desde un resumen (una tesela) a su renglón del despliegue: lo abre
 * en la URL y lo trae a la vista, sin recargar la página.
 */
export function OpenRowButton({
  ids,
  target,
  children,
  label,
}: {
  /** Renglones a abrir (p. ej. el impuesto). */
  ids: string[];
  /** Id del elemento al que se desplaza. */
  target: string;
  children: ReactNode;
  /** Nombre accesible (lo que hace el botón). */
  label: string;
}) {
  const drill = useDrillOpen();
  return (
    <button
      type="button"
      title={label}
      onClick={() => {
        drill.openMany(ids);
        requestAnimationFrame(() => document.getElementById(target)?.scrollIntoView({ behavior: "smooth", block: "start" }));
      }}
      className="inline-flex max-w-full cursor-pointer rounded-full text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-op-accent"
    >
      {children}
      <span className="sr-only">{label}</span>
    </button>
  );
}
