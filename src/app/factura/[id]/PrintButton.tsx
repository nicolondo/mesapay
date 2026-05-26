"use client";

/**
 * Botón cliente para disparar window.print() desde la tirilla
 * pública. Anteriormente usábamos un form con
 * `action="javascript:window.print()"` pero React/los navegadores
 * modernos lo bloquean por XSS — el onClick directo es la forma
 * idiomática.
 */
export function PrintButton() {
  return (
    <button
      type="button"
      onClick={() => window.print()}
    >
      Imprimir
    </button>
  );
}
