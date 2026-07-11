"use client";

import { usePathname } from "next/navigation";
import { useEffect, useSyncExternalStore } from "react";
import type { BoardActivity } from "./boardActivity";

// Tableros con aviso de "algo nuevo entró": Cocina, Bar y Salón (servir).
export const BOARD_BY_HREF: Record<string, "kitchen" | "bar" | "floor"> = {
  "/operator/kitchen": "kitchen",
  "/operator/bar": "bar",
  "/operator/serve": "floor",
};

// Store mínimo sobre localStorage para "lo último visto" por tablero. Un
// contador de versión avanza en cada cambio (esta pestaña vía markSeen; otras
// pestañas vía el evento `storage`), y los componentes releen localStorage en
// el render — así el aviso es reactivo sin setState dentro de un effect.
let seenVersion = 0;
const listeners = new Set<() => void>();
function emit() {
  seenVersion++;
  for (const l of listeners) l();
}
if (typeof window !== "undefined") {
  window.addEventListener("storage", emit);
}
function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
function getVersion(): number {
  return seenVersion;
}
function useSeenVersion(): number {
  return useSyncExternalStore(
    subscribe,
    getVersion,
    () => 0,
  );
}
function seenKey(boardKey: string): string {
  return `mp-board-seen-${boardKey}`;
}
function readSeen(key: string): number {
  if (typeof localStorage === "undefined") return 0;
  return Number(localStorage.getItem(key) || 0);
}
function markSeen(key: string, value: number): void {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(key, String(value));
  emit();
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
  useSeenVersion(); // re-render cuando cambia lo visto
  const storageKey = seenKey(boardKey);
  const seen = readSeen(storageKey);
  const onBoard =
    pathname === path || (pathname?.startsWith(path + "/") ?? false);

  // En el tablero → marcar la actividad actual como vista (limpia el punto).
  // Solo escribe en localStorage (sistema externo) y notifica; el re-render
  // lo maneja useSeenVersion, no un setState acá.
  useEffect(() => {
    if (onBoard && activityMs > 0 && readSeen(storageKey) < activityMs) {
      markSeen(storageKey, activityMs);
    }
  }, [onBoard, activityMs, storageKey]);

  if (onBoard || activityMs <= seen) return null;
  return (
    <span
      className="absolute -top-1 -right-1 w-2.5 h-2.5 rounded-full bg-danger ring-2 ring-op-surface"
      aria-hidden
    />
  );
}

/**
 * ¿Hay algún tablero con novedad sin ver? Para el punto en el botón del menú
 * hamburguesa (móvil) — donde la nav de escritorio (con los puntos por ítem)
 * está oculta. Se excluye el tablero en el que estás parado.
 */
export function useAnyBoardAlert(
  boardActivity: BoardActivity | undefined,
  currentPath: string | null,
): boolean {
  useSeenVersion();
  if (!boardActivity) return false;
  return (
    Object.entries(BOARD_BY_HREF) as [string, "kitchen" | "bar" | "floor"][]
  ).some(([href, board]) => {
    const onThis =
      currentPath === href || (currentPath?.startsWith(href + "/") ?? false);
    if (onThis) return false;
    return (boardActivity[board] ?? 0) > readSeen(seenKey(board));
  });
}
