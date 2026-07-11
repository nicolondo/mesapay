"use client";

import { useEffect } from "react";
import { useTranslations } from "next-intl";

/**
 * Botón cliente para disparar window.print() desde la tirilla
 * pública. Anteriormente usábamos un form con
 * `action="javascript:window.print()"` pero React/los navegadores
 * modernos lo bloquean por XSS — el onClick directo es la forma
 * idiomática.
 *
 * `autoPrint` (llegado como ?print=1): abre el diálogo de impresión solo
 * al cargar — para el "Imprimir factura" directo desde la genérica.
 */
export function PrintButton({ autoPrint = false }: { autoPrint?: boolean }) {
  const t = useTranslations("emailInvoice");
  useEffect(() => {
    if (!autoPrint) return;
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
