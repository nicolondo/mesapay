import type { KeyboardEvent } from "react";

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
 * `onKeyDown` del contenedor del diálogo: el Tab circula entre su primer y
 * su último control. Sin controles, el foco se queda en el contenedor (que
 * debe llevar `tabIndex={-1}`).
 *
 * Si el evento viene de un `<dialog open>` anidado (un formulario encima
 * de la ficha), no hace nada: ese diálogo es modal y el navegador ya le
 * contiene el foco; meternos acá lo sacaría de él.
 */
export function trapTabWithin(e: KeyboardEvent<HTMLElement>): void {
  if (e.key !== "Tab") return;
  if (e.target instanceof Element && e.target.closest("dialog[open]")) return;
  const container = e.currentTarget;
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
