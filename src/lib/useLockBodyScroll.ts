"use client";

import { useEffect } from "react";

/**
 * Bloquea el scroll del fondo mientras un overlay (cajón de menú, sheet,
 * diálogo) está abierto.
 *
 * `overflow: hidden` en el body NO frena el scroll táctil en iOS Safari ni
 * en la PWA: el dedo sobre el cajón (si su contenido no llena la pantalla,
 * o al llegar a su tope) termina desplazando la página de atrás. La única
 * forma confiable es `position: fixed` en el body, guardando la posición
 * para restaurarla al cerrar. Compartido por la carta del comensal, los
 * menús móviles del operador y del admin, AppDialog y los paneles del CRM.
 *
 * El bloqueo se CUENTA, no se apila: con varios overlays abiertos a la vez
 * (la hoja de conversaciones de Pulso y la confirmación de borrar encima)
 * el body se fija al abrir el primero y se suelta al cerrar el último. La
 * versión anterior guardaba y restauraba el estilo previo por overlay; si
 * dos se cerraban en el mismo commit, React corre las limpiezas de padre a
 * hijo y la del hijo volvía a dejar el body en `fixed`: el scroll quedaba
 * «pegado» en todas las pantallas hasta recargar (reporte del dueño en el
 * Salón). El núcleo es puro sobre una `BodySurface` para poder testearlo
 * sin DOM.
 */

export type BodySurface = {
  style: { position: string; top: string; left: string; right: string; width: string };
  scrollY: number;
  scrollTo: (x: number, y: number) => void;
};

type Saved = BodySurface["style"] & { scrollY: number };

let locks = 0;
let saved: Saved | null = null;

/** Toma el bloqueo; sólo el primero fija el body. */
export function lockBody(surface: BodySurface): void {
  locks += 1;
  if (locks > 1) return;
  const { style } = surface;
  saved = {
    position: style.position,
    top: style.top,
    left: style.left,
    right: style.right,
    width: style.width,
    scrollY: surface.scrollY,
  };
  style.position = "fixed";
  style.top = `-${saved.scrollY}px`;
  style.left = "0";
  style.right = "0";
  style.width = "100%";
}

/** Suelta el bloqueo; sólo el último restaura el body y su scroll. */
export function unlockBody(surface: BodySurface): void {
  locks = Math.max(0, locks - 1);
  if (locks > 0 || !saved) return;
  const { style } = surface;
  style.position = saved.position;
  style.top = saved.top;
  style.left = saved.left;
  style.right = saved.right;
  style.width = saved.width;
  surface.scrollTo(0, saved.scrollY);
  saved = null;
}

/** Estado interno (tests). */
export function bodyLockCount(): number {
  return locks;
}

/** Sólo tests: vuelve al estado inicial entre casos. */
export function resetBodyLockForTests(): void {
  locks = 0;
  saved = null;
}

function domSurface(): BodySurface {
  return {
    style: document.body.style,
    get scrollY() {
      return window.scrollY;
    },
    scrollTo: (x, y) => window.scrollTo(x, y),
  };
}

export function useLockBodyScroll(locked: boolean) {
  useEffect(() => {
    if (!locked || typeof document === "undefined") return;
    const surface = domSurface();
    lockBody(surface);
    return () => unlockBody(surface);
  }, [locked]);
}
