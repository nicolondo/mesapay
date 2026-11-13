import type { LineTaxChoice } from "@/lib/erp/purchaseLineTax";
import type { LineIssue, LineIssues, OcCol, OcLine, OcOption } from "./draft";

/** Lo que la tabla y las tarjetas necesitan del formulario. */
export type LineCtl = {
  currency: string;
  taxRates: number[];
  options: readonly OcOption[];
  /** Problemas que ya se muestran (celda tocada o intento de guardar). */
  visibleIssues: (l: OcLine) => LineIssues;
  /** Fila anterior con el mismo insumo (aviso de repetido), o null. */
  duplicateOf: (l: OcLine) => { line: OcLine; index: number } | null;
  /** Descuento propio y consumo de la fila (si está completa). */
  amounts: (key: number) => { lineDiscountCents: number; incCents: number } | null;
  pick: (key: number, o: OcOption) => void;
  createIngredient: (key: number, text: string) => void;
  patch: (key: number, patch: Partial<OcLine>) => void;
  setUnit: (key: number, unit: string) => void;
  setTax: (key: number, choice: LineTaxChoice) => void;
  remove: (key: number) => void;
  merge: (targetKey: number, sourceKey: number) => void;
  touch: (key: number, col: OcCol) => void;
};

export const ISSUE_KEYS: Record<LineIssue, string> = {
  itemRequired: "ocErrItemRequired",
  qtyRequired: "ocErrQtyRequired",
  qtyInvalid: "errContentInvalid",
  qtyWhole: "ocErrQtyWhole",
  priceRequired: "ocErrPriceRequired",
  priceInvalid: "ocErrPriceInvalid",
};

/** Id del mensaje de error de una celda (para aria-describedby). */
export function issueId(key: number, col: "item" | "qty" | "price"): string {
  return `oc-${key}-${col}-err`;
}
