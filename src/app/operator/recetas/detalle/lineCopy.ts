"use client";

import { useLocale, useTranslations } from "next-intl";
import { minQtyLabel, type CostSource, type EditLine, type ParseError } from "../recipeModel";

/**
 * Textos por código que comparten la tabla y las tarjetas: de dónde sale el
 * costo de un insumo y qué le falta a una línea para poder guardarse.
 */
export function useLineCopy() {
  const t = useTranslations("opErp");
  const locale = useLocale();
  return {
    source(source: CostSource): string {
      switch (source) {
        case "stock":
          return t("rdSourceStock");
        case "subrecipe":
          return t("rdSourceSubrecipe");
        case "reference":
          return t("rdSourceReference");
        case "supplier":
          return t("rdSourceSupplier");
        default:
          return "";
      }
    },
    error(l: EditLine, error: ParseError): string {
      if (error === "waste_invalid") return t("errWasteInvalid");
      if (error === "qty_too_small") {
        return t("errQtyTooSmall", { min: minQtyLabel(l.measureKind, l.unit, locale) });
      }
      return l.qtyRaw.trim() === "" ? t("rdErrQtyMissing") : t("errContentInvalid");
    },
  };
}
