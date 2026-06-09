import { z } from "zod";
import { db } from "@/lib/db";
import type { ToolDef } from "./types";
import { rangeInputZod, rangeJsonSchema, resolveRange } from "./dateRange";
import { dateKeyInTz } from "./timeBuckets";

export type PaidOrder = { paidAt: Date; totalCents: number };

export function aggregateTrend(rows: PaidOrder[], opts: { bucket: "day" | "week" | "month"; timezone: string }) {
  const map = new Map<string, { revenueCents: number; orders: number }>();
  for (const r of rows) {
    const key = dateKeyInTz(r.paidAt, opts.timezone, opts.bucket);
    const cur = map.get(key) ?? { revenueCents: 0, orders: 0 };
    cur.revenueCents += r.totalCents;
    cur.orders += 1;
    map.set(key, cur);
  }
  const points = [...map.entries()]
    .map(([period, v]) => ({ period, ...v }))
    .sort((a, b) => a.period.localeCompare(b.period));
  const first = points[0]?.revenueCents ?? 0;
  const last = points[points.length - 1]?.revenueCents ?? 0;
  const growthPct = first > 0 ? Math.round(((last - first) / first) * 100) : null;
  return { points, growthPct };
}

const inputSchema = z.object({
  range: rangeInputZod,
  bucket: z.enum(["day", "week", "month"]).default("day"),
});
type Input = z.infer<typeof inputSchema>;

export const revenueTrendTool: ToolDef<Input> = {
  name: "revenue_trend",
  description:
    "Tendencia de ingresos como serie temporal (por día, semana o mes) con el " +
    "crecimiento porcentual del período. Útil para ver si las ventas suben o bajan.",
  inputSchema,
  jsonSchema: {
    type: "object",
    properties: {
      range: rangeJsonSchema,
      bucket: { type: "string", enum: ["day", "week", "month"], description: "Granularidad de la serie." },
    },
  },
  async run(input, ctx) {
    const { from, to } = resolveRange(input.range);
    const rows = await db.order.findMany({
      where: { restaurantId: ctx.scope.restaurantId, paidAt: { gte: from, lte: to } },
      select: { paidAt: true, totalCents: true },
    });
    return {
      range: { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) },
      bucket: input.bucket,
      ...aggregateTrend(
        rows.map((r) => ({ paidAt: r.paidAt as Date, totalCents: r.totalCents })),
        { bucket: input.bucket, timezone: ctx.timezone },
      ),
    };
  },
};
