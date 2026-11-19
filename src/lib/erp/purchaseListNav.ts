// Navegación de la lista de Compras (/operator/compras): fila entera
// clicable y recorrido del detalle con el teclado (←/→ pasan de compra,
// Esc cierra). PURO —sin DOM real— para probarlo en node; los componentes
// le pasan objetos del navegador que cumplen estas formas.

/** Controles internos de una fila: un clic ahí NO abre el detalle. */
export const ROW_INTERACTIVE_SELECTOR =
  "a, button, input, select, textarea, label, [role='button'], [role='menu'], [role='menuitem']";

type ClosestTarget = { closest?: (selector: string) => unknown } | null | undefined;

/**
 * ¿Un clic en la fila debe abrir el detalle? No cuando cayó sobre un
 * control interno (botón, enlace, campo…) —ese control hace lo suyo— ni
 * cuando hay texto seleccionado: quien arrastró el mouse para copiar un
 * número no quiere abrir nada.
 */
export function rowClickOpensDetail(target: unknown, selectedText: string | null | undefined): boolean {
  if (selectedText) return false;
  const el = target as ClosestTarget;
  if (el && typeof el.closest === "function" && el.closest(ROW_INTERACTIVE_SELECTOR)) return false;
  return true;
}

export type DetailNavAction = "prev" | "next" | "close";

type KeyEventLike = {
  key: string;
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
  target?: unknown;
};

const EDITABLE_TAGS = new Set(["INPUT", "TEXTAREA", "SELECT"]);

/** ¿El foco está en un campo? Ahí las flechas y Esc le pertenecen al campo. */
export function isEditableTarget(target: unknown): boolean {
  const el = target as { tagName?: string; isContentEditable?: boolean } | null | undefined;
  if (!el) return false;
  return EDITABLE_TAGS.has(el.tagName ?? "") || el.isContentEditable === true;
}

/**
 * Qué hace una tecla con el detalle abierto. Solo ← y → recorren la lista
 * —↑/↓ quedan libres para el scroll del panel, que es alto— y Esc cierra.
 * Nada dispara con modificadores (Cmd+← es «atrás» del navegador), con el
 * foco en un input/textarea/select o editable (editar teclea flechas), ni
 * con otro sheet encima (`suspended`).
 */
export function detailNavAction(e: KeyEventLike, opts: { suspended?: boolean } = {}): DetailNavAction | null {
  if (opts.suspended) return null;
  if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return null;
  if (isEditableTarget(e.target)) return null;
  if (e.key === "Escape") return "close";
  if (e.key === "ArrowLeft") return "prev";
  if (e.key === "ArrowRight") return "next";
  return null;
}

export type DetailPosition = {
  /** Posición global 1-based entre TODO lo filtrado («3 de 28»). */
  pos: number;
  total: number;
  prevId: string | null;
  nextId: string | null;
};

/**
 * Posición de la compra abierta dentro de la lista visible: las mismas
 * filas (filtros, búsqueda y orden incluidos) que ve el usuario detrás del
 * sheet. `from`/`total` vienen de la paginación del servidor, así «3 de 28»
 * cuenta todo lo que cumple los filtros y no solo esta página. En los
 * extremos de la PÁGINA la flecha se deshabilita: no damos la vuelta ni
 * saltamos de página (cambiar de página navega y recargaría la lista bajo
 * el detalle; quien lo necesite pagina la lista y sigue). Null si la compra
 * abierta no está en la página visible (p. ej. entró por un enlace `?oc=`
 * de los reportes, o la lista cambió debajo).
 */
export function detailPosition(
  rows: readonly { id: string }[],
  id: string,
  page: { from: number; total: number },
): DetailPosition | null {
  const index = rows.findIndex((r) => r.id === id);
  if (index < 0) return null;
  return {
    pos: page.from + index,
    total: page.total,
    prevId: index > 0 ? rows[index - 1].id : null,
    nextId: index < rows.length - 1 ? rows[index + 1].id : null,
  };
}
