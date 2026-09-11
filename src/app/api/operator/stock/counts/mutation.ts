import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { getErpContext, isDenied } from "@/lib/erp/access";
import { mutateStockCount, StockCountError, type StockCountAction } from "@/lib/erp/stockCounts";

const baseSchema = z.object({ revision: z.number().int().min(0) });
const itemsSchema = baseSchema.extend({ items: z.array(z.object({ itemId: z.string().min(1), countedQty: z.number().int().min(0).max(2_000_000_000).nullable() })).min(1).max(2000) });
const closeSchema = baseSchema.extend({ reviewToken: z.string().uuid() });

export function countMutation(action: StockCountAction) {
  return async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
    const ctx = await getErpContext(["inventory"]);
    if (isDenied(ctx)) return NextResponse.json({ error: ctx.error }, { status: ctx.status });
    const schema = action === "save" ? itemsSchema : action === "close" ? closeSchema : baseSchema;
    const parsed = schema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: parsed.error.issues.some((i) => i.path.includes("countedQty")) ? "qty_invalid" : "invalid" }, { status: 400 });
    const { id } = await params;
    const session = action === "close" ? await auth() : null;
    try {
      return NextResponse.json(await mutateStockCount(ctx.restaurantId, id, action, parsed.data, session?.user?.id ?? null));
    } catch (error) {
      if (error instanceof StockCountError) return NextResponse.json({ error: error.code }, { status: error.status });
      throw error;
    }
  };
}
