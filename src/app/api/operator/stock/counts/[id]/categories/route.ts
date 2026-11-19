import { NextResponse } from "next/server";
import { z } from "zod";
import { getErpContext, isDenied } from "@/lib/erp/access";
import { appendStockCountCategories, StockCountError } from "@/lib/erp/stockCounts";
import { secureApi } from "@/lib/secureApi";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  revision: z.number().int().min(0),
  // null = «Sin categoría» (insumos sin categoría asignada).
  categories: z.array(z.string().trim().min(1).max(120).nullable()).min(1).max(500),
}).strict();

/**
 * Suma al conteo (en borrador o en el definitivo) todos los insumos activos
 * e inventariables de las categorías pedidas que todavía no están en él.
 * Cada insumo congela su teórico con la existencia de ESTE momento, igual
 * que al traer un insumo suelto. Devuelve el conteo con su revisión nueva y
 * cuántos insumos entraron.
 */
async function POSTHandler(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await getErpContext(["inventory"]);
  if (isDenied(ctx)) return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid" }, { status: 400 });
  const { id } = await params;
  try {
    return NextResponse.json(await appendStockCountCategories(ctx.restaurantId, id, parsed.data));
  } catch (error) {
    if (error instanceof StockCountError) return NextResponse.json({ error: error.code }, { status: error.status });
    throw error;
  }
}

export const POST = secureApi(POSTHandler);
