import { z } from "zod";
import { db } from "@/lib/db";
import type { ToolContext, ToolDef } from "./types";
import { resolveRange, rangeInputZod, rangeJsonSchema, type RangeInput } from "./dateRange";

export type DishRow = { name: string; qty: number; priceCents: number };
export type TopDish = { name: string; qty: number; revenueCents: number };

/** PURO: agrupa por nombre, ordena por qty o ingreso, top-N. */
export function aggregateTopDishes(
  rows: DishRow[],
  opts: { by: "qty" | "revenue"; limit: number },
): TopDish[] {
  const map = new Map<string, TopDish>();
  for (const r of rows) {
    const cur = map.get(r.name) ?? { name: r.name, qty: 0, revenueCents: 0 };
    cur.qty += r.qty;
    cur.revenueCents += r.qty * r.priceCents;
    map.set(r.name, cur);
  }
  const arr = [...map.values()];
  arr.sort((a, b) => {
    if (opts.by === "revenue") {
      const diff = b.revenueCents - a.revenueCents;
      return diff !== 0 ? diff : a.qty - b.qty; // tie-break: fewer items = higher unit price
    }
    return b.qty - a.qty;
  });
  return arr.slice(0, opts.limit);
}

const inputSchema = z.object({
  range: rangeInputZod,
  by: z.enum(["qty", "revenue"]).default("qty"),
  limit: z.number().int().min(1).max(25).default(10),
});
type Input = z.infer<typeof inputSchema>;

export const topDishesTool: ToolDef<Input> = {
  name: "top_dishes",
  description:
    "Platos más vendidos del restaurante en un rango. Devuelve top-N por " +
    "cantidad o por ingreso. Útil para 'qué se vende más/menos'.",
  inputSchema,
  jsonSchema: {
    type: "object",
    properties: {
      range: rangeJsonSchema,
      by: { type: "string", enum: ["qty", "revenue"], description: "Ordenar por cantidad o ingreso." },
      limit: { type: "integer", minimum: 1, maximum: 25 },
    },
  },
  async run(input: Input, ctx: ToolContext) {
    const { from, to } = resolveRange(input.range as RangeInput);
    const items = await db.orderItem.findMany({
      where: {
        cancelledAt: null,
        order: {
          restaurantId: ctx.scope.restaurantId, // SCOPE del server
          paidAt: { gte: from, lte: to },
        },
      },
      select: { nameSnapshot: true, qty: true, priceCentsSnapshot: true },
    });
    const rows: DishRow[] = items.map((i) => ({
      name: i.nameSnapshot,
      qty: i.qty,
      priceCents: i.priceCentsSnapshot,
    }));
    return {
      range: { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) },
      by: input.by,
      dishes: aggregateTopDishes(rows, { by: input.by, limit: input.limit }),
    };
  },
};
