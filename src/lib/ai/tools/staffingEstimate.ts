import { z } from "zod";
import { db } from "@/lib/db";
import type { ToolDef } from "./types";
import { rangeInputZod, rangeJsonSchema, resolveRange } from "./dateRange";
import { localParts } from "./timeBuckets";

export type LoadRow = { at: Date };

export function estimateStaffing(rows: LoadRow[], opts: { timezone: string; ordersPerWaiterHour: number }) {
  const map = new Map<string, { dow: number; hour: number; orders: number }>();
  for (const r of rows) {
    const p = localParts(r.at, opts.timezone);
    const key = `${p.dow}-${p.hour}`;
    const cur = map.get(key) ?? { dow: p.dow, hour: p.hour, orders: 0 };
    cur.orders += 1;
    map.set(key, cur);
  }
  const rate = Math.max(1, opts.ordersPerWaiterHour);
  const byHour = [...map.values()]
    .map((c) => ({ ...c, suggestedWaiters: Math.max(1, Math.ceil(c.orders / rate)) }))
    .sort((a, b) => a.dow - b.dow || a.hour - b.hour);
  const peak = byHour.reduce((m, c) => (c.orders > (m?.orders ?? -1) ? c : m), byHour[0] ?? { dow: 0, hour: 0, orders: 0, suggestedWaiters: 1 });
  return { ordersPerWaiterHour: rate, byHour, peak };
}

const inputSchema = z.object({
  range: rangeInputZod,
  ordersPerWaiterHour: z.number().int().min(1).max(30).default(6),
});
type Input = z.infer<typeof inputSchema>;

export const staffingEstimateTool: ToolDef<Input> = {
  name: "staffing_estimate",
  description:
    "Estima cuántos meseros se necesitan por franja horaria según el volumen de " +
    "órdenes y un rendimiento por mesero (default 6 órdenes/mesero/hora). Útil para " +
    "'¿con cuántos meseros manejo la operación?' y dónde está la franja más exigente.",
  inputSchema,
  jsonSchema: {
    type: "object",
    properties: {
      range: rangeJsonSchema,
      ordersPerWaiterHour: { type: "integer", minimum: 1, maximum: 30, description: "Órdenes que atiende un mesero por hora." },
    },
  },
  async run(input, ctx) {
    const { from, to } = resolveRange(input.range);
    const orders = await db.order.findMany({
      where: {
        restaurantId: ctx.scope.restaurantId,
        OR: [{ placedAt: { gte: from, lte: to } }, { placedAt: null, createdAt: { gte: from, lte: to } }],
      },
      select: { placedAt: true, createdAt: true },
    });
    const rows: LoadRow[] = orders.map((o) => ({ at: (o.placedAt ?? o.createdAt) as Date }));
    return {
      range: { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) },
      note: "Estimación heurística por volumen; dow 0=domingo..6=sábado, hour local.",
      ...estimateStaffing(rows, { timezone: ctx.timezone, ordersPerWaiterHour: input.ordersPerWaiterHour }),
    };
  },
};
