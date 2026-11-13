import { NextResponse } from "next/server";
import { z } from "zod";
import { getErpContext, isDenied } from "@/lib/erp/access";
import { appendStockCountItem, StockCountError } from "@/lib/erp/stockCounts";
import { secureApi } from "@/lib/secureApi";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  revision: z.number().int().min(0),
  ingredientId: z.string().min(1).max(64),
}).strict();

/**
 * Suma un insumo al conteo en borrador (creado, restaurado o que quedó por
 * fuera al abrirlo). Devuelve el conteo completo con su revisión nueva y la
 * fila del insumo, para que la pantalla salte a ella.
 */
async function POSTHandler(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await getErpContext(["inventory"]);
  if (isDenied(ctx)) return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid" }, { status: 400 });
  const { id } = await params;
  try {
    return NextResponse.json(await appendStockCountItem(ctx.restaurantId, id, parsed.data));
  } catch (error) {
    if (error instanceof StockCountError) return NextResponse.json({ error: error.code }, { status: error.status });
    throw error;
  }
}

export const POST = secureApi(POSTHandler);
