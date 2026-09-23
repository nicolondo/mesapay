"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  CHIME_STORAGE_PREFIX,
  NewOrderChimeController,
  chimeDefaultEnabled,
  observeRounds,
  readChimePref,
  writeChimePref,
  type ChimeBoard,
  type ChimeContext,
  type SeenRounds,
} from "./newOrderChime";

/*
 * Conecta el pitido de pedido nuevo con el tablero (ver newOrderChime.ts).
 *
 * Estado fuera de React (useSyncExternalStore) y no setState en efectos:
 *   - la preferencia vive en localStorage; el snapshot del servidor es el
 *     default del tablero, así que el HTML y la hidratación coinciden y el
 *     valor guardado se aplica justo después;
 *   - "falta desbloquear el audio" lo decide el controlador cuando entra un
 *     pedido, fuera del ciclo de render.
 */

// ── Preferencia (store de módulo) ────────────────────────────────────────

const prefCache = new Map<ChimeBoard, boolean>();
const prefListeners = new Set<() => void>();

function safeLocalStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    // Acceder a localStorage puede lanzar (storage bloqueado).
    return null;
  }
}

function getPref(board: ChimeBoard): boolean {
  let value = prefCache.get(board);
  if (value === undefined) {
    value = readChimePref(safeLocalStorage(), board);
    prefCache.set(board, value);
  }
  return value;
}

function setPref(board: ChimeBoard, enabled: boolean) {
  // En memoria primero: si el storage falla, el cambio vale igual mientras
  // la página siga abierta.
  prefCache.set(board, enabled);
  writeChimePref(safeLocalStorage(), board, enabled);
  for (const l of prefListeners) l();
}

function subscribePrefs(listener: () => void) {
  prefListeners.add(listener);
  // Otra pestaña del mismo dispositivo cambió la preferencia.
  const onStorage = (e: StorageEvent) => {
    if (e.key !== null && !e.key.startsWith(CHIME_STORAGE_PREFIX)) return;
    prefCache.clear();
    listener();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    prefListeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

// ── Web Audio ────────────────────────────────────────────────────────────

type AudioContextCtor = new () => AudioContext;

function audioContextCtor(): AudioContextCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as typeof window & { webkitAudioContext?: AudioContextCtor };
  return w.AudioContext ?? w.webkitAudioContext ?? null;
}

function createBrowserAudioContext(): ChimeContext | null {
  const Ctor = audioContextCtor();
  return Ctor ? new Ctor() : null;
}

const hasWebAudio = () => audioContextCtor() !== null;
const noopSubscribe = () => () => {};

/*
 * Eventos que cuentan como "gesto" para desbloquear el audio. En pantallas
 * táctiles `pointerdown` NO otorga activación (sí `pointerup`/`touchend`),
 * así que escuchamos todos; reanudar de más no cuesta nada.
 */
const GESTURE_EVENTS = [
  "pointerdown",
  "pointerup",
  "touchend",
  "click",
  "keydown",
] as const;

// ── Hook ─────────────────────────────────────────────────────────────────

export function useNewOrderChime({
  board,
  roundIds,
  scope = "",
}: {
  board: ChimeBoard;
  /** Ids de las rondas que muestra el tablero ahora. */
  roundIds: readonly string[];
  /** Vista actual (p. ej. sub-estación del bar); cambiarla no suena. */
  scope?: string;
}) {
  const enabled = useSyncExternalStore(
    subscribePrefs,
    () => getPref(board),
    () => chimeDefaultEnabled(board),
  );
  // El servidor asume que hay Web Audio; si el navegador no lo tiene, el
  // control se reemplaza por un aviso después de hidratar.
  const supported = useSyncExternalStore(noopSubscribe, hasWebAudio, () => true);

  // Un solo AudioContext por página, dentro del controlador.
  const [controller] = useState(
    () => new NewOrderChimeController(createBrowserAudioContext),
  );
  const needsUnlock = useSyncExternalStore(
    controller.subscribe,
    controller.getNeedsUnlock,
    () => false,
  );

  useEffect(() => () => controller.dispose(), [controller]);

  // Primer gesto (y los siguientes, por si el sistema lo vuelve a
  // suspender): reanudar el contexto. Con el sonido silenciado no creamos
  // contexto alguno.
  useEffect(() => {
    if (!enabled || !supported) return;
    const onGesture = () => controller.unlock();
    for (const type of GESTURE_EVENTS) {
      window.addEventListener(type, onGesture, { capture: true, passive: true });
    }
    return () => {
      for (const type of GESTURE_EVENTS) {
        window.removeEventListener(type, onGesture, { capture: true });
      }
    };
  }, [enabled, supported, controller]);

  // Detección: la primera pasada toma lo que ya estaba como visto (no suena
  // al abrir o recargar); después, sólo ids nunca vistos. Clave en string
  // para no re-ejecutar en cada render del reloj del tablero.
  const seenRef = useRef<SeenRounds | null>(null);
  const idsKey = roundIds.join("\n");
  useEffect(() => {
    const ids = idsKey === "" ? [] : idsKey.split("\n");
    const { seen, chime } = observeRounds(seenRef.current, scope, ids);
    seenRef.current = seen;
    if (chime && enabled) controller.announce();
  }, [idsKey, scope, enabled, controller]);

  const toggle = useCallback(() => {
    const next = !getPref(board);
    setPref(board, next);
    // El clic ya es un gesto: aprovechamos para desbloquear el audio.
    if (next) controller.unlock();
  }, [board, controller]);

  const test = useCallback(() => {
    void controller.test();
  }, [controller]);

  const unlock = useCallback(() => controller.unlock(), [controller]);

  return {
    supported,
    enabled,
    needsUnlock: supported && enabled && needsUnlock,
    toggle,
    test,
    unlock,
  };
}
