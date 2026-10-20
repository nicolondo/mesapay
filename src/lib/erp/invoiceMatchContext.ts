import { db } from "@/lib/db";
import {
  MAX_INVOICE_ALIAS_LENGTH,
  normalizeInvoiceAlias,
  type MatchContext,
} from "./invoiceMatch";

/** Active catalog plus the supplier mappings relevant to this extraction. */
export async function loadInvoiceMatchContext(
  restaurantId: string,
  descriptions: string[],
): Promise<MatchContext> {
  const keys = [...new Set(descriptions.map(normalizeInvoiceAlias))]
    .filter((key) => key.length > 0 && key.length <= MAX_INVOICE_ALIAS_LENGTH);
  const [suppliers, ingredients, priceList, aliases] = await Promise.all([
    db.supplier.findMany({
      where: { restaurantId, active: true },
      select: { id: true, name: true, taxId: true },
    }),
    db.ingredient.findMany({
      where: { restaurantId, active: true },
      select: { id: true, name: true, measureKind: true },
    }),
    db.supplierIngredient.findMany({
      where: { supplier: { restaurantId, active: true }, ingredient: { restaurantId, active: true } },
      select: {
        supplierId: true, ingredientId: true, id: true,
        presentationLabel: true, contentQty: true, lastPriceCents: true,
      },
    }),
    db.supplierInvoiceAlias.findMany({
      where: { supplier: { restaurantId, active: true }, normalizedDescription: { in: keys } },
      select: {
        supplierId: true, normalizedDescription: true,
        ingredient: { select: { id: true, restaurantId: true, active: true } },
      },
    }),
  ]);
  return {
    suppliers: suppliers.map((supplier) => ({ id: supplier.id, name: supplier.name, nit: supplier.taxId })),
    ingredients,
    priceList: priceList.map((item) => ({
      supplierId: item.supplierId, ingredientId: item.ingredientId, supplierItemId: item.id,
      presentationLabel: item.presentationLabel, contentQty: item.contentQty, lastPriceCents: item.lastPriceCents,
    })),
    // Retain unusable mappings so matching cannot silently fall back to a
    // different, similarly named ingredient. Never expose a foreign target ID.
    aliases: aliases.map((alias) => ({
      supplierId: alias.supplierId, normalizedDescription: alias.normalizedDescription,
      ingredientId: alias.ingredient.restaurantId === restaurantId && alias.ingredient.active
        ? alias.ingredient.id : null,
    })),
  };
}
