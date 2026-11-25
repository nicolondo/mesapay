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
 * `localStorage` y no en la base. Mismo patrón que la preferencia
 * Tarjetas/Mapa (`useSalonView`, en SalonMap.tsx).
 *
 * Por defecto, desplegada: quien no la toque ve lo de siempre.
 */

const EVENT = "mesapay:active-section";
const COLLAPSED = "collapsed";

/** Clave de este comercio en el almacenamiento del navegador. */
export function activeSectionKey(tenantSlug: string): string {
  return `mesapay.activeSection.${tenantSlug || "anon"}`;
}

/** Lo guardado → plegada o no. Cualquier otra cosa, desplegada. */
export function parseCollapsed(raw: string | null): boolean {
  return raw === COLLAPSED;
}

/**
 * Estado plegado y cómo cambiarlo. Si el almacenamiento no está
 * disponible (navegación privada), el cambio igual vale mientras la
 * pantalla esté abierta — para eso está el `override`.
 */
export function useActiveSectionCollapsed(
  tenantSlug: string,
): [boolean, (collapsed: boolean) => void] {
  const key = activeSectionKey(tenantSlug);
  const [override, setOverride] = useState<boolean | null>(null);
  const subscribe = useCallback(
    (cb: () => void) => {
      const onStorage = (e: StorageEvent) => {
        if (!e.key || e.key === key) cb();
      };
      window.addEventListener("storage", onStorage);
      window.addEventListener(EVENT, cb);
      return () => {
        window.removeEventListener("storage", onStorage);
        window.removeEventListener(EVENT, cb);
      };
    },
    [key],
  );
  const stored = useSyncExternalStore<boolean>(
    subscribe,
    () => {
      try {
        return parseCollapsed(window.localStorage.getItem(key));
      } catch {
        return false;
      }
    },
    // En el servidor y en la hidratación: desplegada, como el valor por
    // defecto. Si el equipo la tenía plegada, se pliega al hidratar.
    () => false,
  );
  const set = useCallback(
    (collapsed: boolean) => {
      setOverride(collapsed);
      try {
        if (collapsed) window.localStorage.setItem(key, COLLAPSED);
        else window.localStorage.removeItem(key);
      } catch {
        /* sin almacenamiento: queda solo en esta pantalla */
      }
      window.dispatchEvent(new Event(EVENT));
    },
    [key],
  );
  return [override ?? stored, set];
}
