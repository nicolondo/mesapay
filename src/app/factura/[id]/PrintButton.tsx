"use client";

import { useTranslations } from "next-intl";

/**
 * Botón cliente para disparar window.print() desde la tirilla
 * pública. Anteriormente usábamos un form con
 * `action="javascript:window.print()"` pero React/los navegadores
 * modernos lo bloquean por XSS — el onClick directo es la forma
 * idiomática.
 */
export function PrintButton() {
  const t = useTranslations("emailInvoice");
  return (
    <button
      type="button"
      onClick={() => window.print()}
    >
      {t("print")}
    </button>
  );
}
