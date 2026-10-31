"use client";
import { useState } from "react";

/**
 * Copia un bloque de comandos al portapapeles. Pensado para quien instala el
 * programa de impresión: copiar y pegar en el Símbolo del sistema evita
 * errores de tipeo en rutas con espacios.
 */
export function CopyCodeButton({
  text,
  label,
  doneLabel,
}: {
  text: string;
  label: string;
  doneLabel: string;
}) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setDone(true);
          window.setTimeout(() => setDone(false), 2000);
        } catch {
          // Sin permiso de portapapeles: el texto sigue ahí para copiarlo a mano.
        }
      }}
      className="absolute right-2 top-2 min-h-[32px] rounded-lg border border-op-border bg-op-surface px-2.5 text-xs font-medium text-op-muted hover:text-op-text"
    >
      {done ? doneLabel : label}
    </button>
  );
}
