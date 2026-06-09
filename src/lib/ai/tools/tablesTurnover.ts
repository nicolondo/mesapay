import { z } from "zod";
import { db } from "@/lib/db";
import type { ToolDef } from "./types";
import { rangeInputZod, rangeJsonSchema, resolveRange } from "./dateRange";

export type TurnRow = { tableNumber: number; occupancyMin: number };

export function aggregateTurnover(rows: TurnRow[]) {
  const map = new Map<number, { turns: number; totalMin: number }>();
  for (const r of rows) {
    const cur = map.get(r.tableNumber) ?? { turns: 0, totalMin: 0 };
    cur.turns += 1;
    cur.totalMin += r.occupancyMin;
    map.set(r.tableNumber, cur);
  }
  const byTable = [...map.entries()]
    .map(([tableNumber, v]) => ({ tableNumber, turns: v.turns, avgOccupancyMin: Math.round(v.totalMin / v.turns) }))
    .sort((a, b) => b.turns - a.turns);
  const totalTurns = rows.length;
  const avgOccupancyMin = totalTurns ? Math.round(rows.reduce((s, r) => s + r.occupancyMin, 0) / totalTurns) : 0;
  return { totalTurns, avgOccupancyMin, byTable };
}

const inputSchema = z.object({ range: rangeInputZod });
type Input = z.infer<typeof inputSchema>;

export const tablesTurnoverTool: ToolDef<Input> = {
  name: "tables_turnover",
  description:
    "Rotación de mesas: cuántas veces se usó cada mesa (vueltas) y el tiempo " +
    "promedio de ocupación. Útil para '¿cómo está la rotación?' y capacidad.",
  inputSchema,
  jsonSchema: { type: "object", properties: { range: rangeJsonSchema } },
  async run(input, ctx) {
    const { from, to } = resolveRange(input.range);
    const orders = await db.order.findMany({
      where: { restaurantId: ctx.scope.restaurantId, orderType: "dineIn", paidAt: { gte: from, lte: to } },
      select: { createdAt: true, paidAt: true, table: { select: { number: true } } },
    });
    const rows: TurnRow[] = orders
      .filter((o) => o.paidAt && o.table)
      .map((o) => ({
        tableNumber: o.table!.number,
        occupancyMin: Math.max(0, Math.round(((o.paidAt as Date).getTime() - o.createdAt.getTime()) / 60000)),
      }));
    return {
      range: { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) },
      ...aggregateTurnover(rows),
    };
  },
};
