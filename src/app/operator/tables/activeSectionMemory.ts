"use client";

import { useCallback, useState, useSyncExternalStore } from "react";

/**
 * ¿La sección «Activas (N)» de Mesas está plegada?
 *
 * Pedido del dueño: "que las mesas activas en la página de mesas se puedan
 * ocultar y desplegar". Plegada, el encabezado con el contador sigue a la
 * vista — se ve de un vistazo cuántas hay sin que ocupen pantalla.
 *
 * Se recuerda POR APARATO Y COMERCIO: es una preferencia de cómo se mira
 * esta pantalla en este equipo (la tablet de la caja la quiere plegada, el
 * celular del mesero quizá no), y la misma persona puede atender varios
 * restaurantes. Por eso la clave lleva el slug y no el usuario, y vive en
 * `localStorage` y no en la base.
 *
 * Por defecto, desplegada: quien no la toque ve lo de siempre.
 *
 * LA FUENTE DE VERDAD ES LO PERSISTIDO. El estado de React no guarda una
 * copia del valor: se lee siempre del almacenamiento, y lo único que vive
 * en memoria es el respaldo para cuando el almacenamiento FALLA
 * (navegación privada). Si el respaldo tapara lo persistido:
 *   - dos pestañas se irían de sincronía — una pliega y la otra no se
 *     entera, aunque el evento `storage` sí llegue;
 *   - al cambiar de comercio sin remontar, el nuevo —que no tiene nada
 *     guardado— heredaría el plegado del anterior.
 * Por eso el respaldo guarda también SU clave y sólo vale para ella.
 */

const EVENT = "mesapay:active-section";
const COLLAPSED = "collapsed";

/** Respaldo en memoria: sólo cuando el almacenamiento no está. */
export type CollapsedFallback = { key: string; collapsed: boolean };

/** Clave de este comercio en el almacenamiento del navegador. */
export function activeSectionKey(tenantSlug: string): string {
  return `mesapay.activeSection.${tenantSlug || "anon"}`;
}

/** Lo guardado → plegada o no. Cualquier otra cosa, desplegada. */
export function parseCollapsed(raw: string | null): boolean {
  return raw === COLLAPSED;
}

/** Lee del navegador. Sin almacenamiento, desplegada. */
export function readCollapsed(key: string): boolean {
  try {
    return parseCollapsed(window.localStorage.getItem(key));
  } catch {
    return false;
  }
}

/**
 * Guarda. Devuelve `false` si el almacenamiento no está disponible: ahí es
 * donde entra el respaldo en memoria. Desplegada no escribe "expanded",
 * borra la clave — es el valor por defecto.
 */
export function writeCollapsed(key: string, collapsed: boolean): boolean {
  try {
    if (collapsed) window.localStorage.setItem(key, COLLAPSED);
    else window.localStorage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}

/**
 * Lo persistido manda; el respaldo sólo vale para la clave con la que se
 * guardó. Así otro comercio no hereda el plegado del anterior ni se come
 * lo que acaba de cambiar otra pestaña.
 */
export function resolveCollapsed(
  stored: boolean,
  fallback: CollapsedFallback | null,
  key: string,
): boolean {
  if (fallback && fallback.key === key) return fallback.collapsed;
  return stored;
}

/**
 * Avisa cuando cambia el plegado de ESTA clave: `storage` lo manda el
 * navegador desde las OTRAS pestañas, y el evento propio cubre la actual
 * (donde `storage` no dispara).
 */
export function subscribeToActiveSection(
  key: string,
  onChange: () => void,
): () => void {
  const onStorage = (e: StorageEvent) => {
    if (!e.key || e.key === key) onChange();
  };
  window.addEventListener("storage", onStorage);
  window.addEventListener(EVENT, onChange);
  return () => {
    window.removeEventListener("storage", onStorage);
    window.removeEventListener(EVENT, onChange);
  };
}

/** Estado plegado y cómo cambiarlo. */
export function useActiveSectionCollapsed(
  tenantSlug: string,
): [boolean, (collapsed: boolean) => void] {
  const key = activeSectionKey(tenantSlug);
  const [fallback, setFallback] = useState<CollapsedFallback | null>(null);
  const subscribe = useCallback(
    (cb: () => void) => subscribeToActiveSection(key, cb),
    [key],
  );
  const stored = useSyncExternalStore<boolean>(
    subscribe,
    () => readCollapsed(key),
    // En el servidor y en la hidratación: desplegada, como el valor por
    // defecto. Si el equipo la tenía plegada, se pliega al hidratar.
    () => false,
  );
  const set = useCallback(
    (collapsed: boolean) => {
      // Si se persistió, lo persistido manda y no queda copia en memoria
      // que pueda taparlo después.
      setFallback(writeCollapsed(key, collapsed) ? null : { key, collapsed });
      window.dispatchEvent(new Event(EVENT));
    },
    [key],
  );
  return [resolveCollapsed(stored, fallback, key), set];
}
