"use client";

// Cliente fino — window.print() no es exponible desde un server
// component. Mismo patrón que /factura/[id]/PrintButton.tsx.

import { useTranslations } from "next-intl";

export function PrintButton() {
  const t = useTranslations("opShifts");
  return (
    <button
      type="button"
      onClick={() => window.print()}
      className="mp-btn mp-btn--primary mp-btn--sm"
    >
      {t("print")}
    </button>
  );
}
