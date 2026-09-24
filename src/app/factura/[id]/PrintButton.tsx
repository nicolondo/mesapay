"use client";

import { useEffect } from "react";
import { useTranslations } from "next-intl";
import { isEmbeddedFrame } from "@/lib/printInBrowser";

/**
 * Botón cliente para disparar window.print() desde la tirilla
 * pública. Anteriormente usábamos un form con
 * `action="javascript:window.print()"` pero React/los navegadores
 * modernos lo bloquean por XSS — el onClick directo es la forma
 * idiomática.
 *
 * `autoPrint` (llegado como ?print=1): abre el diálogo de impresión solo
 * al cargar — para el "Imprimir factura" directo desde la genérica.
 * Sólo en pestaña propia: cuando la tirilla viene embebida en el iframe
 * oculto de `printUrlInHiddenFrame` (reimpresión sin abrir pestaña) es
 * ese helper el que imprime, y si la página también lo hiciera saldrían
 * dos diálogos.
 */
export function PrintButton({ autoPrint = false }: { autoPrint?: boolean }) {
  const t = useTranslations("emailInvoice");
  useEffect(() => {
    if (!autoPrint || isEmbeddedFrame()) return;
    // Un beat para que la tirilla termine de pintar antes del diálogo.
    const id = setTimeout(() => window.print(), 400);
    return () => clearTimeout(id);
  }, [autoPrint]);
  return (
    <button
      type="button"
      onClick={() => window.print()}
    >
      {t("print")}
    </button>
  );
}
