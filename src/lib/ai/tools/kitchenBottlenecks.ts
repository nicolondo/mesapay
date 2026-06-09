import { z } from "zod";
import { db } from "@/lib/db";
import type { ToolDef } from "./types";
import { rangeInputZod, rangeJsonSchema, resolveRange } from "./dateRange";
import { localParts } from "./timeBuckets";

export type PrepRow = { station: string; actualMin: number; targetMin: number; servedAt: Date };

export function aggregateBottlenecks(rows: PrepRow[], opts: { timezone: string }) {
  const st = new Map<string, { items: number; actual: number; target: number; over: number }>();
  const hr = new Map<string, { dow: number; hour: number; items: number; over: number }>();
  for (const r of rows) {
    const s = st.get(r.station) ?? { items: 0, actual: 0, target: 0, over: 0 };
    s.items += 1; s.actual += r.actualMin; s.target += r.targetMin;
    if (r.actualMin > r.targetMin) s.over += 1;
    st.set(r.station, s);
    const p = localParts(r.servedAt, opts.timezone);
    const key = `${p.dow}-${p.hour}`;
    const h = hr.get(key) ?? { dow: p.dow, hour: p.hour, items: 0, over: 0 };
    h.items += 1; if (r.actualMin > r.targetMin) h.over += 1;
    hr.set(key, h);
  }
  const byStation = [...st.entries()].map(([station, v]) => ({
    station, items: v.items,
    avgActualMin: Math.round(v.actual / v.items),
    avgTargetMin: Math.round(v.target / v.items),
    overTargetPct: Math.round((v.over / v.items) * 100),
  })).sort((a, b) => b.overTargetPct - a.overTargetPct);
  const byHour = [...hr.values()].map((h) => ({ ...h, overTargetPct: Math.round((h.over / h.items) * 100) }));
  const worstHour = byHour.reduce((m, c) => (c.over > (m?.over ?? -1) ? c : m), byHour[0] ?? { dow: 0, hour: 0, items: 0, over: 0, overTargetPct: 0 });
  return { byStation, worstHour };
}

const inputSchema = z.object({ range: rangeInputZod });
type Input = z.infer<typeof inputSchema>;

export const kitchenBottlenecksTool: ToolDef<Input> = {
  name: "kitchen_bottlenecks",
  description:
    "Cuellos de botella de preparación: compara el tiempo real (de inicio a " +
    "servido) contra el target por estación, y marca la hora/día donde más se " +
    "supera. Útil para '¿cuándo la cocina no da abasto?'.",
  inputSchema,
  jsonSchema: { type: "object", properties: { range: rangeJsonSchema } },
  async run(input, ctx) {
    const { from, to } = resolveRange(input.range);
    const items = await db.orderItem.findMany({
      where: {
        cancelledAt: null,
        preparationStartedAt: { not: null },
        servedAt: { not: null },
        order: { restaurantId: ctx.scope.restaurantId, paidAt: { gte: from, lte: to } },
      },
      select: { station: true, prepMinutesSnapshot: true, preparationStartedAt: true, servedAt: true },
    });
    const rows: PrepRow[] = items.map((i) => ({
      station: i.station,
      targetMin: i.prepMinutesSnapshot,
      actualMin: Math.max(0, Math.round(((i.servedAt as Date).getTime() - (i.preparationStartedAt as Date).getTime()) / 60000)),
      servedAt: i.servedAt as Date,
    }));
    return {
      range: { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) },
      note: "dow 0=domingo..6=sábado, hour local del comercio.",
      ...aggregateBottlenecks(rows, { timezone: ctx.timezone }),
    };
  },
};
