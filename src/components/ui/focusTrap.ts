"use client";

import { useEffect, useRef, type KeyboardEvent, type RefObject } from "react";

/**
 * Contención del foco dentro de un diálogo abierto.
 *
 * Lo usa `AppDialog` (un `<dialog>` modal) y la ficha de mesa
 * (`TableDetailSheet`, un velo propio que no es `<dialog>`): en los dos
 * casos, mientras el diálogo está abierto el Tab tiene que dar la vuelta
 * dentro de él y no irse a la página de atrás.
 *
 * En la ficha de mesa hace falta de verdad desde que el sheet se monta una
 * sola vez al final de la grilla (ver MesasGrid.tsx): antes caía justo
 * después del botón de su tarjeta y el Tab seguía más o menos cerca; ahora
 * el siguiente nodo es la última tarjeta del salón, así que sin contención
 * el foco se va al fondo de la lista y la página salta con él.
 */

const FOCUSABLE =
  'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

/** Los controles del diálogo que de verdad pueden recibir el foco. */
function focusableWithin(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => el.tabIndex >= 0 && el.getClientRects().length > 0,
  );
}

/**
 * ¿El evento nace dentro de un `<dialog open>` ANIDADO, es decir otro que
 * NO es el contenedor del trap?
 *
 * La distinción es la que importa: cuando el contenedor del trap ES el
 * `<dialog>` (todo AppDialog), `closest("dialog[open]")` desde cualquiera
 * de sus controles devuelve ese mismo diálogo. Si bastara con que
 * existiera, el trap de AppDialog no correría NUNCA y el Tab del último
 * botón se iría al `body`.
 */
export function isInsideNestedDialog(
  target: unknown,
  container: unknown,
): boolean {
  const el = target as { closest?: (selector: string) => unknown } | null;
  if (!el || typeof el.closest !== "function") return false;
  const nested = el.closest("dialog[open]");
  return !!nested && nested !== container;
}

/**
 * `onKeyDown` del contenedor del diálogo: el Tab circula entre su primer y
 * su último control. Sin controles, el foco se queda en el contenedor (que
 * debe llevar `tabIndex={-1}`).
 *
 * Si el evento viene de un `<dialog open>` anidado (un formulario encima
 * de la ficha), no hace nada: ese diálogo es modal y el navegador ya le
 * contiene el foco; meternos acá lo sacaría de él. Ver
 * `isInsideNestedDialog`.
 */
export function trapTabWithin(e: KeyboardEvent<HTMLElement>): void {
  if (e.key !== "Tab") return;
  const container = e.currentTarget;
  if (isInsideNestedDialog(e.target, container)) return;
  const controls = focusableWithin(container);
  const first = controls[0];
  const last = controls.at(-1);
  if (!first || !last) {
    e.preventDefault();
    container.focus();
    return;
  }
  const active = document.activeElement;
  if (e.shiftKey && (active === first || active === container)) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && (active === last || active === container)) {
    e.preventDefault();
    first.focus();
  }
}

/**
 * El resto del patrón de diálogo para un overlay que NO es `<dialog>`: al
 * abrirlo el foco entra en él, y al cerrarlo vuelve a quien lo disparó.
 * `preventScroll` en las dos puntas: ni al entrar ni al volver se mueve el
 * scroll de la página de atrás.
 *
 * Va junto al `trapTabWithin` del mismo contenedor, que además debe llevar
 * `tabIndex={-1}` para poder recibir el foco. Pensado para componentes que
 * sólo se montan mientras están abiertos (el caso de todas las hojas de la
 * ficha de mesa); si el tuyo vive montado, pásale `open`.
 *
 * `fallback` es para cuando el disparador YA NO ESTÁ al cerrar: la lista
 * de atrás se refrescó, o se plegó desde otra pestaña, y el botón que
 * abrió el diálogo se desmontó. Sin él, el foco cae al `body` y quien usa
 * teclado tiene que recorrer la página entera de nuevo. Devuelve el
 * elemento al que pasarle el foco, o `null` si tampoco hay.
 */
export function useDialogFocus<T extends HTMLElement>(
  open: boolean = true,
  fallback?: () => HTMLElement | null,
): RefObject<T | null> {
  const ref = useRef<T>(null);
  // El `fallback` se lee al cerrar, no al abrir: así el efecto no se
  // rehace (ni se roba el foco de nuevo) cada vez que el padre cambia la
  // función de lugar.
  const fallbackRef = useRef(fallback);
  useEffect(() => {
    fallbackRef.current = fallback;
  }, [fallback]);
  useEffect(() => {
    if (!open) return;
    const trigger = document.activeElement as HTMLElement | null;
    ref.current?.focus({ preventScroll: true });
    return () => {
      const target = trigger?.isConnected ? trigger : fallbackRef.current?.();
      target?.focus({ preventScroll: true });
    };
  }, [open]);
  return ref;
}
