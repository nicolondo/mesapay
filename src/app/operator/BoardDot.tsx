"use client";

import { usePathname } from "next/navigation";
import { useEffect, useSyncExternalStore } from "react";

// Tableros con aviso de "algo nuevo entró": Cocina, Bar y Salón (servir).
export const BOARD_BY_HREF: Record<string, "kitchen" | "bar" | "floor"> = {
  "/operator/kitchen": "kitchen",
  "/operator/bar": "bar",
  "/operator/serve": "floor",
};

// Store mínimo sobre localStorage para "lo último visto" por tablero. Se lee
// con useSyncExternalStore (reactivo en la misma pestaña vía notify() y entre
// pestañas vía el evento `storage`), así no hace falta setState en un effect.
const listeners = new Set<() => void>();
function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  if (typeof window !== "undefined") window.addEventListener("storage", cb);
  return () => {
    listeners.delete(cb);
    if (typeof window !== "undefined") window.removeEventListener("storage", cb);
  };
}
function readSeen(key: string): number {
  if (typeof localStorage === "undefined") return 0;
  return Number(localStorage.getItem(key) || 0);
}
function markSeen(key: string, value: number): void {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(key, String(value));
  listeners.forEach((l) => l());
}

/**
 * Punto rojo en la nav cuando entró algo nuevo a un tablero mientras el
 * operador estaba en otra pantalla/pestaña. `activityMs` = timestamp del
 * último ítem que entró a ese tablero (lo calcula el layout en el server y
 * se refresca solo en cada evento SSE, vía LiveRefresh). Se compara contra
 * lo último que el operador VIO (localStorage, compartido entre pestañas):
 * si es más nuevo, se muestra el punto. Al abrir ese tablero se marca como
 * visto y desaparece.
 */
export function BoardDot({
  boardKey,
  path,
  activityMs,
}: {
  boardKey: string;
  path: string;
  activityMs: number;
}) {
  const pathname = usePathname();
  const storageKey = `mp-board-seen-${boardKey}`;
  const seen = useSyncExternalStore(
    subscribe,
    () => readSeen(storageKey),
    () => 0,
  );

  const onBoard =
    pathname === path || (pathname?.startsWith(path + "/") ?? false);

  // En el tablero → marcar la actividad actual como vista (limpia el punto).
  // Solo escribe en localStorage (sistema externo); el re-render lo hace
  // useSyncExternalStore, no un setState acá.
  useEffect(() => {
    if (onBoard && activityMs > 0 && readSeen(storageKey) < activityMs) {
      markSeen(storageKey, activityMs);
    }
  }, [onBoard, activityMs, storageKey]);

  if (onBoard || activityMs <= seen) return null;
  return (
    <span
      className="absolute -top-1 -right-1 w-2 h-2 rounded-full bg-danger ring-2 ring-op-surface"
      aria-hidden
    />
  );
}
