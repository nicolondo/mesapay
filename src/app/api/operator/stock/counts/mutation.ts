import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { getErpContext, isDenied } from "@/lib/erp/access";
import { mutateStockCount, StockCountError, type StockCountAction } from "@/lib/erp/stockCounts";
import { isValidCountParts, MAX_COUNT_PARTS, MAX_COUNT_QTY } from "@/lib/erp/stockCountParts";

const baseSchema = z.object({ revision: z.number().int().min(0) });
const quantitySchema = z.number().int().min(0).max(MAX_COUNT_QTY);
const itemSchema = z.object({
  itemId: z.string().min(1),
  countedQty: quantitySchema.nullable(),
  countedParts: z.array(quantitySchema).max(MAX_COUNT_PARTS).optional(),
}).refine((item) => item.countedParts === undefined || isValidCountParts(item.countedQty, item.countedParts), { path: ["countedParts"] });
const itemsSchema = baseSchema.extend({ items: z.array(itemSchema).min(1).max(2000) });
const closeSchema = baseSchema.extend({ reviewToken: z.string().uuid() });

export function countMutation(action: StockCountAction) {
  return async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
    const ctx = await getErpContext(["inventory"]);
    if (isDenied(ctx)) return NextResponse.json({ error: ctx.error }, { status: ctx.status });
    const schema = action === "save" ? itemsSchema : action === "close" ? closeSchema : baseSchema;
    const parsed = schema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: parsed.error.issues.some((i) => i.path.includes("countedQty") || i.path.includes("countedParts")) ? "qty_invalid" : "invalid" }, { status: 400 });
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
