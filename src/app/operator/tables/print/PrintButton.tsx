"use client";

import { useTranslations } from "next-intl";

// Botón cliente — window.print() no es exponible desde server. Mismo
// patrón que /factura/[id]/PrintButton.tsx y /operator/shifts/[id]/
// PrintButton.tsx.

export function PrintButton() {
  const t = useTranslations("opTables");
  return (
    <button
      type="button"
      onClick={() => window.print()}
      className="mp-btn mp-btn--primary mp-btn--sm"
    >
      {t("printButton")}
    </button>
  );
}
