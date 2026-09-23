/**
 * Geometría del VIEWPORT VISUAL (lo que el usuario ve de verdad: la
 * pantalla menos el teclado en pantalla, y con zoom). Sin DOM, para poder
 * testearlo; el hook `useVisualViewport` es quien lee `window.visualViewport`.
 */
export type VisualViewportRect = {
  /** Desplazamiento del viewport visual respecto del layout (px). */
  offsetTop: number;
  height: number;
  width: number;
};

/**
 * Dónde va un popup centrado en el viewport visual, en coordenadas de
 * `position: fixed` (que se miden contra el viewport de LAYOUT, de ahí que
 * se sume `offsetTop`).
 *
 * - Si el diálogo cabe, queda centrado verticalmente.
 * - Si no cabe (teclado abierto en iOS), se pega al margen superior y
 *   `maxHeight` lo achica para que haga scroll interno y siga visible.
 */
export function centerInVisualViewport({
  offsetTop,
  height,
  dialogHeight,
  margin,
}: {
  offsetTop: number;
  height: number;
  dialogHeight: number;
  margin: number;
}): { top: number; maxHeight: number } {
  const maxHeight = Math.max(0, height - margin * 2);
  const top = offsetTop + Math.max(margin, (height - dialogHeight) / 2);
  return { top: Math.round(top), maxHeight: Math.round(maxHeight) };
}
