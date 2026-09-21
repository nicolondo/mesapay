"use client";

import { useTranslations } from "next-intl";

/** Imprime con el diálogo del navegador (la vista lleva su `@media print`). */
export function PrintButton() {
  const t = useTranslations("opReportes");
  return (
    <button
      type="button"
      onClick={() => window.print()}
      className="mp-btn mp-btn--ghost mp-btn--sm no-print"
    >
      {t("print")}
    </button>
  );
}
