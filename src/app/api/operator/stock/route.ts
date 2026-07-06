import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getErpContext, isDenied } from "@/lib/erp/access";
import type { ModuleSlug } from "@/lib/modules";

export const dynamic = "force-dynamic";

const GATE: ModuleSlug[] = ["inventory"];

/**
 * Existencias del comercio. Se lista desde el lado del INSUMO (no del
 * StockLevel) para incluir insumos activos sin movimientos todavía
 * (level null → 0). Los inactivos solo aparecen si conservan saldo ≠ 0
 * — un insumo descatalogado con stock sigue siendo plata en la bodega.
 */
export async function GET() {
  const ctx = await getErpContext(GATE);
  if (isDenied(ctx)) {
    return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  }
  const ingredients = await db.ingredient.findMany({
    where: { restaurantId: ctx.restaurantId },
    orderBy: [{ active: "desc" }, { name: "asc" }],
    select: {
      id: true,
      name: true,
      category: true,
      measureKind: true,
      active: true,
      // A4 — la UI marca "bajo mínimo" con qtyBase <= reorderPointBase.
      reorderPointBase: true,
      reorderQtyBase: true,
      stockLevel: {
        select: { qtyBase: true, totalValueCents: true, updatedAt: true },
      },
    },
  });
  const rows = ingredients.filter(
    (i) => i.active || (i.stockLevel && i.stockLevel.qtyBase !== 0),
  );
  return NextResponse.json({ stock: rows });
}
