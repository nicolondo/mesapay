import { secureApi } from "@/lib/secureApi";
import { NextResponse } from "next/server";
import { getErpContext, isDenied } from "@/lib/erp/access";
import { loadInventoryStock } from "@/lib/erp/inventoryStock";
import type { ModuleSlug } from "@/lib/modules";

export const dynamic = "force-dynamic";

const GATE: ModuleSlug[] = ["inventory"];

/**
 * Existencias del comercio, con el mismo criterio que la carga inicial de
 * /operator/inventario (ver loadInventoryStock): activos aunque no tengan
 * movimientos, archivados solo con saldo ≠ 0 y sin las categorías marcadas
 * «sin inventario».
 */
async function GETHandler() {
  const ctx = await getErpContext(GATE);
  if (isDenied(ctx)) {
    return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  }
  return NextResponse.json({ stock: await loadInventoryStock(ctx.restaurantId) });
}

export const GET = secureApi(GETHandler);
