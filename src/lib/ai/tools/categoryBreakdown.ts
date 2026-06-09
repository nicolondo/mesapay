import { z } from "zod";
import { db } from "@/lib/db";
import type { ToolDef } from "./types";
import { rangeInputZod, rangeJsonSchema, resolveRange } from "./dateRange";

export type CatRow = { category: string; kind: string; qty: number; priceCents: number };

export function aggregateCategories(rows: CatRow[], opts: { limit: number }) {
  const cat = new Map<string, { kind: string; qty: number; revenueCents: number }>();
  const kind = new Map<string, number>();
  let total = 0;
  for (const r of rows) {
    const rev = r.qty * r.priceCents;
    total += rev;
    const c = cat.get(r.category) ?? { kind: r.kind, qty: 0, revenueCents: 0 };
    c.qty += r.qty;
    c.revenueCents += rev;
    cat.set(r.category, c);
    kind.set(r.kind, (kind.get(r.kind) ?? 0) + rev);
  }
  const categories = [...cat.entries()]
    .map(([category, v]) => ({ category, ...v }))
    .sort((a, b) => b.revenueCents - a.revenueCents)
    .slice(0, opts.limit);
  const byKind = [...kind.entries()]
    .map(([k, revenueCents]) => ({ kind: k, revenueCents }))
    .sort((a, b) => b.revenueCents - a.revenueCents);
  return { totalRevenueCents: total, categories, byKind };
}

const inputSchema = z.object({ range: rangeInputZod, limit: z.number().int().min(1).max(30).default(15) });
type Input = z.infer<typeof inputSchema>;

export const categoryBreakdownTool: ToolDef<Input> = {
  name: "category_breakdown",
  description:
    "Ventas desglosadas por categoría de la carta y por tipo (comida, bebida, " +
    "postre, etc.). Útil para ver el peso de vinos/bebidas vs comida.",
  inputSchema,
  jsonSchema: {
    type: "object",
    properties: { range: rangeJsonSchema, limit: { type: "integer", minimum: 1, maximum: 30 } },
  },
  async run(input, ctx) {
    const { from, to } = resolveRange(input.range);
    const items = await db.orderItem.findMany({
      where: {
        cancelledAt: null,
        order: { restaurantId: ctx.scope.restaurantId, paidAt: { gte: from, lte: to } },
      },
      select: {
        qty: true,
        priceCentsSnapshot: true,
        menuItem: { select: { category: { select: { label: true, kind: true } } } },
      },
    });
    const rows: CatRow[] = items.map((i) => ({
      category: i.menuItem?.category?.label ?? "Sin categoría",
      kind: i.menuItem?.category?.kind ?? "other",
      qty: i.qty,
      priceCents: i.priceCentsSnapshot,
    }));
    return {
      range: { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) },
      ...aggregateCategories(rows, { limit: input.limit }),
    };
  },
};
