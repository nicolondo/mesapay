"use client";

import { useEffect, useRef } from "react";

/**
 * EventSource consciente de la visibilidad de la pestaña.
 *
 * Por qué: mesapay.co corre sobre HTTP/1.1, donde el browser limita a
 * ~6 conexiones por dominio y cada SSE mantiene UNA abierta de forma
 * indefinida. Con varias pestañas abiertas (admin + operator + cocina +
 * preview del diner) las 6 conexiones se agotan y toda navegación nueva
 * queda colgada esperando un socket libre. Cerrando el EventSource
 * cuando la pestaña pasa a segundo plano liberamos el socket; al volver
 * a la pestaña reconectamos y corremos `onResume` para recuperar
 * cualquier cambio ocurrido mientras estábamos desconectados.
 *
 * Uso:
 *   useVisibleEventSource(
 *     `/api/tenant/${slug}/events`,
 *     (es) => es.addEventListener("message", onMsg),
 *     () => router.refresh(),          // opcional: al reconectar
 *   );
 *
 * `setup(es)` se invoca cada vez que se (re)abre la conexión, sobre un
 * EventSource nuevo. No hace falta limpiar listeners: al cerrar
 * descartamos el EventSource entero (se recolecta con sus listeners).
 *
 * `setup` y `onResume` se leen siempre por ref, así que podés pasar
 * closures nuevas en cada render sin provocar reconexiones — las únicas
 * dependencias que reabren la conexión son `url` y `enabled`.
 *
 * `opts.enabled` (default true): cuando es false no se abre conexión
 * alguna — útil para gates como "esta estación no imprime acá".
 */
export function useVisibleEventSource(
  url: string,
  setup: (es: EventSource) => void,
  onResume?: () => void,
  opts?: { enabled?: boolean },
) {
  const enabled = opts?.enabled ?? true;
  const esRef = useRef<EventSource | null>(null);
  const setupRef = useRef(setup);
  const resumeRef = useRef(onResume);

  // Mantener las closures frescas sin reabrir la conexión. Se actualizan
  // en un effect (no durante el render) para no violar las reglas de
  // refs; corre antes que el effect de conexión de abajo, así que cuando
  // éste reabre (cambio de url/enabled) ya lee la última versión.
  useEffect(() => {
    setupRef.current = setup;
    resumeRef.current = onResume;
  });

  useEffect(() => {
    if (!enabled) return;

    function open() {
      if (esRef.current) return;
      const es = new EventSource(url);
      setupRef.current(es);
      esRef.current = es;
    }
    function close() {
      if (!esRef.current) return;
      esRef.current.close();
      esRef.current = null;
    }
    function onVisibility() {
      if (document.visibilityState === "visible") {
        open();
        resumeRef.current?.();
      } else {
        close();
      }
    }

    if (document.visibilityState === "visible") open();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      close();
    };
  }, [url, enabled]);
}
