import { selectReviewIngredient, type InvoiceReviewLine } from "./invoiceReviewLine";

type IngredientChoice = {
  id: string | null;
  name: string;
  measureKind: InvoiceReviewLine["measureKind"];
};

export type ReviewSupplierMatch = {
  ingredient: { kind: "matched"; ingredient: IngredientChoice & { id: string } }
    | { kind: "suggest_create"; name: string };
  matchSource?: "alias" | "name";
  aliasUnavailable?: boolean;
};

/** Only an explicit choice can instruct the server to learn an association. */
export function chooseInvoiceIngredient(line: InvoiceReviewLine, ingredient: IngredientChoice): InvoiceReviewLine {
  return {
    ...selectReviewIngredient(line, ingredient),
    manuallySelected: true,
    rememberMatch: ingredient.id != null && Number.isInteger(line.sourceLineIndex)
      && (line.sourceLineIndex ?? -1) >= 0 && !!line.sourceDescription?.trim(),
    matchSource: undefined,
    aliasUnavailable: false,
  };
}

/** Supplier presentations and remembered names cannot travel to another supplier. */
export function resetInvoiceSupplier(line: InvoiceReviewLine): InvoiceReviewLine {
  // Passing a new choice detaches the supplier presentation using the same
  // quantity conversion as a normal edit, keeping its price as a line total.
  const detached = selectReviewIngredient(line, { id: null, name: line.ingredientName, measureKind: line.measureKind });
  const previousAlias = line.matchSource === "alias" && !line.manuallySelected;
  return {
    ...detached,
    ingredientId: previousAlias ? null : line.ingredientId,
    ingredientName: previousAlias ? (line.sourceDescription ?? line.ingredientName) : line.ingredientName,
    rememberMatch: false,
    matchSource: undefined,
    aliasUnavailable: false,
  };
}

/** A late supplier response must not overwrite an operator's manual selection. */
export function applyInvoiceSupplierMatch(line: InvoiceReviewLine, match: ReviewSupplierMatch): InvoiceReviewLine {
  if (line.manuallySelected || line.sourceLineIndex == null) return line;
  const ingredient = match.ingredient.kind === "matched" ? match.ingredient.ingredient
    : { id: null, name: match.ingredient.name, measureKind: line.measureKind };
  return {
    ...selectReviewIngredient(line, ingredient),
    matchSource: match.matchSource,
    aliasUnavailable: match.aliasUnavailable ?? false,
    rememberMatch: false,
  };
}
