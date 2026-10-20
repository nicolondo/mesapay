import { Prisma } from "@prisma/client";
import { PurchaseInvoiceSchema, type PurchaseInvoiceExtraction } from "@/lib/anthropic";
import { lockStock } from "@/lib/orderLock";
import { MAX_INVOICE_ALIAS_LENGTH, normalizeInvoiceAlias } from "./invoiceMatch";
import { PurchasingError } from "./purchasing";

export class InvoiceAliasError extends Error {
  constructor(public readonly code: "alias_invalid" | "alias_conflict") {
    super(code);
    this.name = "InvoiceAliasError";
  }
}

type ReviewedAliasLine = {
  ingredientId: string | null;
  sourceLineIndex?: number;
  rememberMatch?: boolean;
};
type AliasSelection = {
  ingredientId: string;
  sourceDescription: string;
  normalizedDescription: string;
};

function collectSelections(
  extraction: PurchaseInvoiceExtraction,
  lines: ReviewedAliasLine[],
): AliasSelection[] {
  const selections = new Map<string, AliasSelection>();
  for (const line of lines) {
    if (!line.rememberMatch) continue;
    const index = line.sourceLineIndex;
    if (!line.ingredientId || index === undefined || !Number.isInteger(index) || index < 0 || index >= extraction.lines.length) {
      throw new InvoiceAliasError("alias_invalid");
    }
    const sourceDescription = extraction.lines[index].description.trim();
    const normalizedDescription = normalizeInvoiceAlias(sourceDescription);
    if (
      sourceDescription.length > MAX_INVOICE_ALIAS_LENGTH ||
      normalizedDescription.length > MAX_INVOICE_ALIAS_LENGTH ||
      !/[\p{L}\p{N}]/u.test(normalizedDescription)
    ) {
      throw new InvoiceAliasError("alias_invalid");
    }
    const previous = selections.get(normalizedDescription);
    if (previous && previous.ingredientId !== line.ingredientId) {
      throw new InvoiceAliasError("alias_conflict");
    }
    if (!previous) selections.set(normalizedDescription, {
      ingredientId: line.ingredientId, sourceDescription, normalizedDescription,
    });
  }
  return [...selections.values()];
}

/**
 * Called only inside the pending-upload confirmation transaction. It reads
 * source descriptions from the claimed upload, never from client row labels.
 * An order/receipt failure rolls back these preferences along with the claim.
 */
export async function rememberInvoiceAliases(
  tx: Prisma.TransactionClient,
  args: { restaurantId: string; uploadId: string; supplierId: string; lines: ReviewedAliasLine[] },
): Promise<void> {
  if (!args.lines.some((line) => line.rememberMatch)) return;
  const upload = await tx.purchaseInvoiceUpload.findUnique({
    where: { id: args.uploadId },
    select: { restaurantId: true, status: true, extraction: true },
  });
  if (!upload || upload.restaurantId !== args.restaurantId || upload.status !== "confirming") {
    throw new InvoiceAliasError("alias_invalid");
  }
  const parsed = PurchaseInvoiceSchema.safeParse(upload.extraction);
  if (!parsed.success) throw new InvoiceAliasError("alias_invalid");
  const selections = collectSelections(parsed.data, args.lines);

  // Use the ingredient-edit lock before row locks, in the same order as
  // archive/stock mutations. Supplier row locks also serialize archiving.
  await lockStock(tx, args.restaurantId);
  const suppliers = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "Supplier"
    WHERE "id" = ${args.supplierId} AND "restaurantId" = ${args.restaurantId} AND "active" = true
    FOR SHARE`;
  if (suppliers.length !== 1) throw new PurchasingError("supplier_not_found");
  const ingredientIds = [...new Set(selections.map((selection) => selection.ingredientId))];
  const ingredients = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "Ingredient"
    WHERE "id" IN (${Prisma.join(ingredientIds)}) AND "restaurantId" = ${args.restaurantId} AND "active" = true
    ORDER BY "id" FOR SHARE`;
  if (ingredients.length !== ingredientIds.length) throw new PurchasingError("ingredient_not_found");

  for (const selection of selections) {
    await tx.supplierInvoiceAlias.upsert({
      where: { supplierId_normalizedDescription: {
        supplierId: args.supplierId, normalizedDescription: selection.normalizedDescription,
      } },
      create: { supplierId: args.supplierId, ...selection },
      update: { ingredientId: selection.ingredientId, sourceDescription: selection.sourceDescription },
    });
  }
}
