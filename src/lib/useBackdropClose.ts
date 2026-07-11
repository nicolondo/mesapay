"use client";

import { useRef, type MouseEvent } from "react";

/**
 * Props para el backdrop de un modal que cierra al hacer click AFUERA, pero
 * NO cuando el gesto empezó adentro. Caso típico: seleccionar texto en un
 * campo y soltar el mouse sobre el backdrop — el `click` se dispara en el
 * ancestro común (el backdrop) y cerraría el popup, perdiendo la edición.
 *
 * La solución: solo cerrar si el botón se PRESIONÓ sobre el backdrop mismo
 * (no si la presión empezó en el contenido y terminó afuera al arrastrar).
 *
 * Uso:
 *   <div className="fixed inset-0 …" {...useBackdropClose(onClose)}>
 *     <div onClick={(e) => e.stopPropagation()}>…contenido…</div>
 *   </div>
 */
export function useBackdropClose(onClose: () => void): {
  onMouseDown: (e: MouseEvent) => void;
  onClick: (e: MouseEvent) => void;
} {
  // ¿La última presión empezó sobre el backdrop (y no sobre el contenido)?
  const pressedOnBackdrop = useRef(false);
  return {
    onMouseDown: (e) => {
      pressedOnBackdrop.current = e.target === e.currentTarget;
    },
    onClick: (e) => {
      if (e.target === e.currentTarget && pressedOnBackdrop.current) onClose();
    },
  };
}
