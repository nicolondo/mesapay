// Teclado del menú de acciones de cada fila (patrón WAI-ARIA "menu button").
// Puro para poder probarlo sin DOM: recibe qué ítems están habilitados y
// devuelve a cuál mover el foco, o la acción a tomar.

export type MenuKeyResult =
  | { type: "focus"; index: number }
  | { type: "close"; restoreFocus: boolean }
  | { type: "none" };

/** Siguiente ítem habilitado en la dirección dada, dando la vuelta. */
export function nextEnabledIndex(enabled: readonly boolean[], from: number, step: 1 | -1): number {
  const n = enabled.length;
  if (n === 0 || !enabled.some(Boolean)) return -1;
  let i = from;
  for (let tries = 0; tries < n; tries++) {
    i = (i + step + n) % n;
    if (enabled[i]) return i;
  }
  return -1;
}

export function firstEnabledIndex(enabled: readonly boolean[]): number {
  return nextEnabledIndex(enabled, -1, 1);
}

export function lastEnabledIndex(enabled: readonly boolean[]): number {
  return nextEnabledIndex(enabled, enabled.length, -1);
}

/**
 * Flechas recorren (con vuelta), Home/End van a los extremos, Esc cierra y
 * devuelve el foco al botón, Tab cierra dejando que el foco siga su curso.
 */
export function menuKeyAction(key: string, current: number, enabled: readonly boolean[]): MenuKeyResult {
  switch (key) {
    case "ArrowDown": {
      const index = nextEnabledIndex(enabled, current, 1);
      return index < 0 ? { type: "none" } : { type: "focus", index };
    }
    case "ArrowUp": {
      const index = nextEnabledIndex(enabled, current < 0 ? enabled.length : current, -1);
      return index < 0 ? { type: "none" } : { type: "focus", index };
    }
    case "Home": {
      const index = firstEnabledIndex(enabled);
      return index < 0 ? { type: "none" } : { type: "focus", index };
    }
    case "End": {
      const index = lastEnabledIndex(enabled);
      return index < 0 ? { type: "none" } : { type: "focus", index };
    }
    case "Escape":
      return { type: "close", restoreFocus: true };
    case "Tab":
      return { type: "close", restoreFocus: false };
    default:
      return { type: "none" };
  }
}

/**
 * Posición del menú (fixed, en px del viewport) junto a su botón: alineado
 * al borde derecho del botón, abajo si cabe; si no, arriba. Nunca se sale
 * del viewport (margen de 8px).
 */
export function placeMenu(
  anchor: { top: number; bottom: number; right: number; left: number },
  menu: { width: number; height: number },
  viewport: { width: number; height: number },
  gap = 4,
  margin = 8,
): { top: number; left: number } {
  const below = anchor.bottom + gap;
  const fitsBelow = below + menu.height <= viewport.height - margin;
  const above = anchor.top - gap - menu.height;
  const top = fitsBelow || above < margin
    ? Math.max(margin, Math.min(below, viewport.height - margin - menu.height))
    : above;
  const left = Math.min(
    Math.max(margin, anchor.right - menu.width),
    Math.max(margin, viewport.width - margin - menu.width),
  );
  return { top: Math.round(top), left: Math.round(left) };
}
