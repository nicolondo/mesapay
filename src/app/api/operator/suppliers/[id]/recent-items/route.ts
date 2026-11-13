import { secureApi } from "@/lib/secureApi";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getErpContext, isDenied } from "@/lib/erp/access";
import { summarizeSupplierHistory } from "@/lib/erp/supplierHistory";
import type { ModuleSlug } from "@/lib/modules";

export const dynamic = "force-dynamic";

const GATE: ModuleSlug[] = ["purchasing"];

/** Órdenes recientes que se leen para resumir lo que se le pide. */
const RECENT_ORDERS = 20;

/**
 * Lo que el comercio le suele pedir a este proveedor (solo lectura): por
 * insumo, en cuántas de sus últimas órdenes aparece y cómo se pidió la
 * última vez (presentación o cantidad, precio de lista, IVA y consumo).
 * «Nueva orden» lo usa para precargar precio y presentación y para
 * «Agregar los habituales». Las órdenes anuladas no cuentan.
 */
async function GETHandler(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const ctx = await getErpContext(GATE);
  if (isDenied(ctx)) {
    return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  }
  const { id } = await params;
  const supplier = await db.supplier.findUnique({
    where: { id },
    select: { restaurantId: true },
  });
  if (!supplier || supplier.restaurantId !== ctx.restaurantId) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  const orders = await db.purchaseOrder.findMany({
    where: {
      restaurantId: ctx.restaurantId,
      supplierId: id,
      status: { not: "canceled" },
    },
    orderBy: [{ createdAt: "desc" }],
    take: RECENT_ORDERS,
    select: {
      createdAt: true,
      items: {
        select: {
          ingredientId: true,
          supplierItemId: true,
          presentations: true,
          qtyOrderedBase: true,
          listCostCents: true,
          expectedCostCents: true,
          taxPct: true,
          expectedIncCents: true,
          ingredient: { select: { active: true } },
        },
      },
    },
  });
  return NextResponse.json(summarizeSupplierHistory(orders));
}

export const GET = secureApi(GETHandler);
