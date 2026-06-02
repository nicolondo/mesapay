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
      className="h-9 px-4 rounded-full bg-ink text-bone text-sm font-medium"
    >
      {t("print")}
    </button>
  );
}
