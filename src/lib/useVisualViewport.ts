"use client";

import { useEffect, useState } from "react";
import type { VisualViewportRect } from "./visualViewport";

/**
 * Rectángulo del VIEWPORT VISUAL (`window.visualViewport`): lo que el
 * usuario ve de verdad, descontando el teclado en pantalla y el zoom.
 *
 * Por qué: en iOS Safari, al abrirse el teclado NO cambia el viewport de
 * layout (`100vh`, `position: fixed` e `inset: 0` siguen midiendo la
 * pantalla completa), sólo se achica el visual. Un diálogo centrado con
 * `margin: auto` queda debajo del teclado. Con este rectángulo se puede
 * reubicar y achicar (ver `centerInVisualViewport` y AppDialog
 * `placement="center"`).
 *
 * Se suscribe a `resize` y `scroll` del visualViewport (el teclado
 * dispara ambos: achica y, si Safari desplaza para mostrar el input,
 * mueve `offsetTop`) y a `window.resize` como fallback cuando la API no
 * existe. Devuelve null en SSR y antes del primer efecto; con
 * `enabled=false` no se suscribe a nada.
 */
export function useVisualViewport(enabled = true): VisualViewportRect | null {
  const [rect, setRect] = useState<VisualViewportRect | null>(null);

  useEffect(() => {
    if (!enabled) return;
    const vv = window.visualViewport;
    const update = () => {
      const next = readVisualViewport();
      // Misma geometría → mismo objeto, para no re-renderizar en cada
      // evento de scroll que no cambió nada.
      setRect((prev) =>
        prev &&
        prev.offsetTop === next.offsetTop &&
        prev.height === next.height &&
        prev.width === next.width
          ? prev
          : next,
      );
    };
    update();
    vv?.addEventListener("resize", update);
    vv?.addEventListener("scroll", update);
    window.addEventListener("resize", update);
    return () => {
      vv?.removeEventListener("resize", update);
      vv?.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  }, [enabled]);

  return enabled ? rect : null;
}

function readVisualViewport(): VisualViewportRect {
  const vv = window.visualViewport;
  if (vv) return { offsetTop: vv.offsetTop, height: vv.height, width: vv.width };
  return { offsetTop: 0, height: window.innerHeight, width: window.innerWidth };
}
