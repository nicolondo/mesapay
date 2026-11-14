"use client";

import { useTranslations } from "next-intl";

/** Imprime la representación gráfica con el diálogo del navegador. */
export function PrintButton() {
  const t = useTranslations("opSupportDoc");
  return (
    <button type="button" onClick={() => window.print()} className="mp-btn mp-btn--primary mp-btn--sm">
      {t("print")}
    </button>
  );
}
