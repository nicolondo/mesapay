"use client";

import { useEffect } from "react";

/**
 * Bloquea el scroll del fondo mientras un overlay (cajón de menú, sheet)
 * está abierto.
 *
 * `overflow: hidden` en el body NO frena el scroll táctil en iOS Safari ni
 * en la PWA: el dedo sobre el cajón (si su contenido no llena la pantalla,
 * o al llegar a su tope) termina desplazando la página de atrás. La única
 * forma confiable es `position: fixed` en el body, guardando la posición
 * para restaurarla al cerrar. Compartido por la carta del comensal y los
 * menús móviles del operador y del admin.
 */
export function useLockBodyScroll(locked: boolean) {
  useEffect(() => {
    if (!locked || typeof document === "undefined") return;
    const scrollY = window.scrollY;
    const body = document.body;
    const prev = {
      position: body.style.position,
      top: body.style.top,
      left: body.style.left,
      right: body.style.right,
      width: body.style.width,
    };
    body.style.position = "fixed";
    body.style.top = `-${scrollY}px`;
    body.style.left = "0";
    body.style.right = "0";
    body.style.width = "100%";
    return () => {
      body.style.position = prev.position;
      body.style.top = prev.top;
      body.style.left = prev.left;
      body.style.right = prev.right;
      body.style.width = prev.width;
      window.scrollTo(0, scrollY);
    };
  }, [locked]);
}
