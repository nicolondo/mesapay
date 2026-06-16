"use client";

import { useEffect } from "react";

type Lockable = { lock?: (orientation: string) => Promise<unknown> };

/**
 * Fuerza orientación horizontal en los tableros KDS (cocina / bar).
 *
 * - **Android (Chrome) en PWA instalada (standalone):** la Screen Orientation
 *   API bloquea efectivamente a landscape. Esto es lo que de verdad lo "fija",
 *   más allá del `orientation` del manifest.
 * - **iOS / iPadOS:** Safari NO implementa `screen.orientation.lock()` y además
 *   ignora el `orientation` del manifest. No hay forma desde la web de forzar la
 *   orientación: ahí manda el bloqueo de rotación del dispositivo (o Guided
 *   Access / un wrapper kiosko nativo). El `.catch()` traga el rechazo.
 *
 * Reintenta al volver la pestaña a primer plano (algunos sistemas sueltan el
 * lock al minimizar / bloquear pantalla).
 */
export function LandscapeLock() {
  useEffect(() => {
    function lock() {
      const orientation = (screen as Screen & { orientation?: Lockable })
        .orientation;
      orientation?.lock?.("landscape").catch(() => {
        // No soportado (iOS) o no permitido (no-standalone) → ignorar.
      });
    }
    lock();
    document.addEventListener("visibilitychange", lock);
    return () => document.removeEventListener("visibilitychange", lock);
  }, []);

  return null;
}
