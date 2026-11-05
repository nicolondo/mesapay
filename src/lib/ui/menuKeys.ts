// Teclado de un menú de acciones (patrón «menu button» de WAI-ARIA), puro
// para poder probarlo sin DOM. Lo usa el menú «⋯» de las filas de
// Facturas (`RowActionMenu`).

/** Qué hacer con una tecla, según dónde esté el foco. */
export type MenuKeyResult =
  /** Mover el foco al ítem `index`. */
  | { kind: "focus"; index: number }
  /**
   * Cerrar y devolver el foco al botón que abrió el menú. Con Esc la tecla
   * se consume; con Tab sigue su camino desde el botón (al próximo control).
   */
  | { kind: "close"; via: "escape" | "tab" }
  /** La tecla no es del menú: que siga su camino. */
  | { kind: "none" };

/**
 * Tecla DENTRO del menú abierto.
 *
 *   · ↓ / ↑ recorren los ítems y dan la vuelta; Inicio / Fin van al primero
 *     y al último.
 *   · Esc cierra y vuelve al botón «⋯».
 *   · Tab cierra sin robar el foco: el navegador sigue al próximo control
 *     después del botón (el menú no es una trampa de foco).
 *   · Una letra salta al próximo ítem que empieza con ella (`labels`).
 *
 * `index` es el ítem enfocado (-1 si ninguno).
 */
export function menuKeyResult(
  key: string,
  index: number,
  count: number,
  labels: readonly string[] = [],
): MenuKeyResult {
  if (count <= 0) return key === "Escape" ? { kind: "close", via: "escape" } : { kind: "none" };
  switch (key) {
    case "ArrowDown":
      return { kind: "focus", index: index < 0 ? 0 : (index + 1) % count };
    case "ArrowUp":
      return { kind: "focus", index: index < 0 ? count - 1 : (index - 1 + count) % count };
    case "Home":
    case "PageUp":
      return { kind: "focus", index: 0 };
    case "End":
    case "PageDown":
      return { kind: "focus", index: count - 1 };
    case "Escape":
      return { kind: "close", via: "escape" };
    case "Tab":
      return { kind: "close", via: "tab" };
  }
  if (key.length === 1 && /\S/.test(key)) {
    const ch = normalize(key);
    for (let step = 1; step <= count; step += 1) {
      const i = (Math.max(index, -1) + step + count) % count;
      if (normalize(labels[i] ?? "").startsWith(ch)) return { kind: "focus", index: i };
    }
  }
  return { kind: "none" };
}

/**
 * Tecla sobre el BOTÓN «⋯» con el menú cerrado: ↓ (y Enter / Espacio, que
 * el navegador convierte en click) abren con el foco en el primer ítem; ↑
 * abre con el foco en el último. null = la tecla no abre nada.
 */
export function menuButtonKeyResult(key: string): "first" | "last" | null {
  if (key === "ArrowDown") return "first";
  if (key === "ArrowUp") return "last";
  return null;
}

/**
 * ¿El menú abre hacia ARRIBA? Sólo si abajo no entra y arriba hay más lugar
 * (el último renglón de la lista, o una fila pegada al borde de abajo).
 */
export function menuOpensUp(args: {
  /** Borde inferior del botón (px desde arriba de la ventana). */
  anchorBottom: number;
  /** Borde superior del botón. */
  anchorTop: number;
  menuHeight: number;
  viewportHeight: number;
  gap?: number;
}): boolean {
  const gap = args.gap ?? 6;
  const below = args.viewportHeight - args.anchorBottom - gap;
  const above = args.anchorTop - gap;
  return below < args.menuHeight && above > below;
}

function normalize(s: string): string {
  return s
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .trimStart();
}
