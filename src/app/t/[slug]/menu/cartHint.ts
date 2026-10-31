import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Aviso «¡Agregado! Toca aquí abajo…» del carrito del comensal.
 *
 * Es una burbuja que apunta al botón del carrito y se va sola. Sale UNA vez
 * por carrito: cuando el carrito pasa de vacío a tener algo. No sale con el
 * segundo plato ni los siguientes, ni al recargar la página con un carrito ya
 * armado (eso no es "agregar"), ni al volver de la hoja del plato sin haber
 * agregado nada. Si el carrito se vacía (se mandó el pedido, o el comensal
 * quitó todo) y se vuelve a llenar, vuelve a salir.
 *
 * La lógica vive acá, sin React, para poder probarla con temporizadores
 * falsos; `useCartAddedHint` sólo la conecta al componente.
 */

/** Cuánto queda el aviso a la vista antes de empezar a desvanecerse. */
export const CART_HINT_VISIBLE_MS = 2000;
/** Duración del fundido de salida (tiene que coincidir con `.cart-hint-out`). */
export const CART_HINT_FADE_MS = 250;

/**
 * - `hidden`: no hay aviso.
 * - `armed`: el carrito acaba de recibir su primer plato pero el botón del
 *   carrito todavía no está a la vista (la hoja del plato sigue abierta).
 *   Apenas el dock aparece, pasa a `shown`.
 * - `shown`: burbuja visible y botón resaltado.
 * - `leaving`: fundido de salida.
 */
export type CartHintPhase = "hidden" | "armed" | "shown" | "leaving";

/** La burbuja se pinta en estas fases (en `leaving`, desvaneciéndose). */
export function isCartHintVisible(phase: CartHintPhase): boolean {
  return phase === "shown" || phase === "leaving";
}

/**
 * ¿Este cambio del carrito merece el aviso?
 *
 * `prevCount` es la cantidad de líneas que había antes, o `null` si todavía
 * no hay referencia: el primer valor que llega después de hidratar es el
 * carrito restaurado de localStorage, y recargar no es agregar.
 */
export function shouldShowCartHint(
  prevCount: number | null,
  nextCount: number,
): boolean {
  return prevCount === 0 && nextCount > 0;
}

export type CartHintController = {
  /** Cantidad de líneas del carrito. La primera llamada fija la referencia. */
  cartCountChanged(count: number): void;
  /** Si el botón del carrito está a la vista (falso con la hoja del plato abierta). */
  setDockVisible(visible: boolean): void;
  /** El comensal tocó el carrito: el aviso se va ya, sin fundido. */
  dismiss(): void;
  /** Limpia los temporizadores (al desmontar). Después no avisa nada más. */
  dispose(): void;
  readonly phase: CartHintPhase;
};

export function createCartHintController(
  onPhase: (phase: CartHintPhase) => void,
  {
    visibleMs = CART_HINT_VISIBLE_MS,
    fadeMs = CART_HINT_FADE_MS,
  }: { visibleMs?: number; fadeMs?: number } = {},
): CartHintController {
  let phase: CartHintPhase = "hidden";
  let prevCount: number | null = null;
  let dockVisible = false;
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  function clearTimer() {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }
  function set(next: CartHintPhase) {
    if (disposed || next === phase) return;
    phase = next;
    onPhase(next);
  }
  function startIfReady() {
    if (phase !== "armed" || !dockVisible) return;
    set("shown");
    timer = setTimeout(() => {
      set("leaving");
      timer = setTimeout(() => {
        timer = null;
        set("hidden");
      }, fadeMs);
    }, visibleMs);
  }

  return {
    cartCountChanged(count) {
      if (disposed) return;
      const show = shouldShowCartHint(prevCount, count);
      prevCount = count;
      if (show) {
        clearTimer();
        set("armed");
        startIfReady();
      } else if (count === 0) {
        clearTimer();
        set("hidden");
      }
    },
    setDockVisible(visible) {
      if (disposed) return;
      dockVisible = visible;
      if (visible) {
        startIfReady();
      } else if (isCartHintVisible(phase)) {
        // Se abrió la hoja de otro plato con el aviso en pantalla: ya lo vio.
        // Al volver no lo repetimos (no agregó nada nuevo al carrito vacío).
        clearTimer();
        set("hidden");
      }
    },
    dismiss() {
      clearTimer();
      set("hidden");
    },
    dispose() {
      clearTimer();
      disposed = true;
    },
    get phase() {
      return phase;
    },
  };
}

/**
 * Conecta el controlador al menú. `enabled` debe ser falso hasta que el
 * carrito se haya hidratado de localStorage: así el carrito restaurado queda
 * como referencia y no dispara el aviso.
 */
export function useCartAddedHint({
  enabled,
  count,
  dockVisible,
}: {
  enabled: boolean;
  count: number;
  dockVisible: boolean;
}): { phase: CartHintPhase; dismiss: () => void } {
  const [phase, setPhase] = useState<CartHintPhase>("hidden");
  const controllerRef = useRef<CartHintController | null>(null);
  // Orden de los efectos: crear el controlador va primero para que los de
  // abajo ya lo encuentren en el montaje.
  useEffect(() => {
    const controller = createCartHintController(setPhase);
    controllerRef.current = controller;
    return () => {
      controller.dispose();
      controllerRef.current = null;
    };
  }, []);
  useEffect(() => {
    if (enabled) controllerRef.current?.cartCountChanged(count);
  }, [enabled, count]);
  useEffect(() => {
    controllerRef.current?.setDockVisible(dockVisible);
  }, [dockVisible]);
  const dismiss = useCallback(() => controllerRef.current?.dismiss(), []);
  return { phase, dismiss };
}
