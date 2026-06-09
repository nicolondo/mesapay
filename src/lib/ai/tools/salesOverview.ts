import { z } from "zod";
import { db } from "@/lib/db";
import type { ToolContext, ToolDef } from "./types";
import { rangeInputZod, rangeJsonSchema, resolveRange } from "./dateRange";

export type OrderRow = { totalCents: number; diners: number };

function totals(rows: OrderRow[]) {
  const revenueCents = rows.reduce((s, r) => s + r.totalCents, 0);
  const orders = rows.length;
  const diners = rows.reduce((s, r) => s + r.diners, 0);
  return { revenueCents, orders, diners, avgTicketCents: orders ? Math.round(revenueCents / orders) : 0 };
}

export function summarizeSales(cur: OrderRow[], prev: OrderRow[]) {
  const c = totals(cur);
  const p = totals(prev);
  const pct = (now: number, before: number) => (before > 0 ? Math.round(((now - before) / before) * 100) : null);
  return {
    ...c,
    previous: p,
    revenueChangePct: pct(c.revenueCents, p.revenueCents),
    ordersChangePct: pct(c.orders, p.orders),
  };
}

const inputSchema = z.object({ range: rangeInputZod });
type Input = z.infer<typeof inputSchema>;

export const salesOverviewTool: ToolDef<Input> = {
  name: "sales_overview",
  description:
    "Resumen de ventas del período: ingresos, # de órdenes, ticket promedio y " +
    "comensales, con comparación vs el período anterior de igual duración. " +
    "Útil para '¿cómo van las ventas?' y '¿estoy creciendo?'.",
  inputSchema,
  jsonSchema: { type: "object", properties: { range: rangeJsonSchema } },
  async run(input, ctx: ToolContext) {
    const { from, to } = resolveRange(input.range);
    const span = to.getTime() - from.getTime();
    const prevFrom = new Date(from.getTime() - span);
    const sel = { select: { totalCents: true, diners: true } };
    const [cur, prev] = await Promise.all([
      db.order.findMany({ where: { restaurantId: ctx.scope.restaurantId, paidAt: { gte: from, lte: to } }, ...sel }),
      db.order.findMany({ where: { restaurantId: ctx.scope.restaurantId, paidAt: { gte: prevFrom, lt: from } }, ...sel }),
    ]);
    return {
      range: { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) },
      ...summarizeSales(cur, prev),
    };
  },
};
