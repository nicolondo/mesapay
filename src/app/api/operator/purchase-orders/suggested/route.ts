import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getErpContext, isDenied } from "@/lib/erp/access";
import { isModuleEnabled } from "@/lib/modules";
import type { ModuleSlug } from "@/lib/modules";

export const dynamic = "force-dynamic";

const GATE: ModuleSlug[] = ["purchasing"];

/**
 * OC sugerida por reorden (ERP A4 · D4): insumos activos bajo su punto de
 * reorden, agrupados por proveedor preferido con cantidades redondeadas
 * HACIA ARRIBA a presentaciones. La UI deja editar y crea borradores por
 * proveedor vía el POST normal de purchase-orders — acá solo se sugiere,
 * no se escribe nada.
 *
 * Requiere purchasing (gate) + inventory (el punto de reorden se compara
 * contra existencias): sin inventory el "bajo mínimo" no significa nada.
 */
export async function GET() {
  const ctx = await getErpContext(GATE);
  if (isDenied(ctx)) {
    return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  }
  const tenant = await db.restaurant.findUnique({
    where: { id: ctx.restaurantId },
    select: { enabledModules: true, inventoryExcludedCategories: true },
  });
  if (!tenant || !isModuleEnabled(tenant.enabledModules, "inventory")) {
    return NextResponse.json({ error: "module_disabled" }, { status: 403 });
  }

  const excluded = tenant.inventoryExcludedCategories;
  const ingredients = await db.ingredient.findMany({
    where: {
      restaurantId: ctx.restaurantId,
      active: true,
      reorderPointBase: { not: null },
      // Categorías sin inventario no entran al reorden (null-category sí).
      ...(excluded.length > 0
        ? { OR: [{ category: null }, { category: { notIn: excluded } }] }
        : {}),
    },
    orderBy: { name: "asc" },
    select: {
      id: true,
      name: true,
      measureKind: true,
      reorderPointBase: true,
      reorderQtyBase: true,
      stockLevel: { select: { qtyBase: true } },
      supplierItems: {
        where: { preferred: true },
        take: 1,
        select: {
          id: true,
          presentationLabel: true,
          contentQty: true,
          lastPriceCents: true,
          supplier: { select: { id: true, name: true } },
        },
      },
    },
  });

  type SuggestedLine = {
    ingredientId: string;
    ingredientName: string;
    measureKind: string;
    stockQtyBase: number;
    reorderPointBase: number;
    /** Base a pedir: max(reorderQtyBase, punto − existencia). */
    needBase: number;
    supplierItemId: string;
    presentationLabel: string;
    contentQty: number;
    /** Presentaciones sugeridas (needBase redondeado hacia arriba, mín. 1). */
    presentations: number;
    lastPriceCents: number | null;
    expectedCostCents: number;
  };
  const bySupplier = new Map<
    string,
    { supplierId: string; supplierName: string; lines: SuggestedLine[] }
  >();
  const unassigned: Array<{
    ingredientId: string;
    ingredientName: string;
    measureKind: string;
    stockQtyBase: number;
    reorderPointBase: number;
    needBase: number;
  }> = [];

  for (const ing of ingredients) {
    const stockQtyBase = ing.stockLevel?.qtyBase ?? 0;
    const point = ing.reorderPointBase!;
    if (stockQtyBase > point) continue; // no está bajo mínimo

    const deficit = Math.max(0, point - stockQtyBase);
    const needBase = Math.max(ing.reorderQtyBase ?? 0, deficit);
    if (needBase <= 0) continue;

    const preferred = ing.supplierItems[0];
    const base = {
      ingredientId: ing.id,
      ingredientName: ing.name,
      measureKind: ing.measureKind,
      stockQtyBase,
      reorderPointBase: point,
      needBase,
    };
    if (!preferred || preferred.contentQty <= 0) {
      unassigned.push(base);
      continue;
    }
    const presentations = Math.max(
      1,
      Math.ceil(needBase / preferred.contentQty),
    );
    const line: SuggestedLine = {
      ...base,
      supplierItemId: preferred.id,
      presentationLabel: preferred.presentationLabel,
      contentQty: preferred.contentQty,
      presentations,
      lastPriceCents: preferred.lastPriceCents,
      expectedCostCents: (preferred.lastPriceCents ?? 0) * presentations,
    };
    let group = bySupplier.get(preferred.supplier.id);
    if (!group) {
      group = {
        supplierId: preferred.supplier.id,
        supplierName: preferred.supplier.name,
        lines: [],
      };
      bySupplier.set(preferred.supplier.id, group);
    }
    group.lines.push(line);
  }

  const suppliers = [...bySupplier.values()].sort((a, b) =>
    a.supplierName.localeCompare(b.supplierName),
  );
  return NextResponse.json({ suppliers, unassigned });
}
