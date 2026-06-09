import { z } from "zod";
import { db } from "@/lib/db";
import type { ToolDef } from "./types";
import { rangeInputZod, rangeJsonSchema, resolveRange } from "./dateRange";
import { localParts } from "./timeBuckets";

export type TrafficRow = { at: Date; revenueCents: number };

export function aggregateTraffic(rows: TrafficRow[], opts: { timezone: string }) {
  const map = new Map<string, { dow: number; hour: number; orders: number; revenueCents: number }>();
  for (const r of rows) {
    const p = localParts(r.at, opts.timezone);
    const key = `${p.dow}-${p.hour}`;
    const cur = map.get(key) ?? { dow: p.dow, hour: p.hour, orders: 0, revenueCents: 0 };
    cur.orders += 1;
    cur.revenueCents += r.revenueCents;
    map.set(key, cur);
  }
  const cells = [...map.values()].sort((a, b) => a.dow - b.dow || a.hour - b.hour);
  const busiest = cells.reduce((m, c) => (c.orders > (m?.orders ?? -1) ? c : m), cells[0] ?? { dow: 0, hour: 0, orders: 0, revenueCents: 0 });
  return { cells, busiest };
}

const inputSchema = z.object({ range: rangeInputZod });
type Input = z.infer<typeof inputSchema>;

export const trafficByTimeTool: ToolDef<Input> = {
  name: "traffic_by_time",
  description:
    "Tráfico por día de la semana y hora (en la zona horaria del comercio): " +
    "muestra los picos y los valles de movimiento. Útil para '¿qué días y horas " +
    "tengo más/menos movimiento?'.",
  inputSchema,
  jsonSchema: { type: "object", properties: { range: rangeJsonSchema } },
  async run(input, ctx) {
    const { from, to } = resolveRange(input.range);
    const orders = await db.order.findMany({
      where: {
        restaurantId: ctx.scope.restaurantId,
        OR: [{ placedAt: { gte: from, lte: to } }, { placedAt: null, createdAt: { gte: from, lte: to } }],
      },
      select: { placedAt: true, createdAt: true, totalCents: true },
    });
    const rows: TrafficRow[] = orders.map((o) => ({ at: (o.placedAt ?? o.createdAt) as Date, revenueCents: o.totalCents }));
    return {
      range: { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) },
      note: "dow: 0=domingo..6=sábado; hour en hora local del comercio",
      ...aggregateTraffic(rows, { timezone: ctx.timezone }),
    };
  },
};
