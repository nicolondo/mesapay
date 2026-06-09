import { z } from "zod";
import { db } from "@/lib/db";
import type { ToolDef } from "./types";
import { rangeInputZod, rangeJsonSchema, resolveRange } from "./dateRange";

export type StaffRow = { userName: string; amountCents: number; tipCents: number; tableNumber: number | null };

export function aggregateStaff(rows: StaffRow[]) {
  const map = new Map<string, { amountCents: number; tipCents: number; charges: number; tables: Set<number> }>();
  for (const r of rows) {
    const cur = map.get(r.userName) ?? { amountCents: 0, tipCents: 0, charges: 0, tables: new Set<number>() };
    cur.amountCents += r.amountCents;
    cur.tipCents += r.tipCents;
    cur.charges += 1;
    if (r.tableNumber != null) cur.tables.add(r.tableNumber);
    map.set(r.userName, cur);
  }
  const staff = [...map.entries()]
    .map(([userName, v]) => ({
      userName,
      amountCents: v.amountCents,
      tipCents: v.tipCents,
      charges: v.charges,
      tables: v.tables.size,
      avgTicketCents: v.charges ? Math.round(v.amountCents / v.charges) : 0,
    }))
    .sort((a, b) => b.amountCents - a.amountCents);
  return { staff };
}

const inputSchema = z.object({ range: rangeInputZod });
type Input = z.infer<typeof inputSchema>;

export const staffPerformanceTool: ToolDef<Input> = {
  name: "staff_performance",
  description:
    "Desempeño por mesero (según quién cobró): ventas, # de cobros, mesas " +
    "atendidas, propinas y ticket promedio. Útil para '¿quién es mi mejor mesero?'.",
  inputSchema,
  jsonSchema: { type: "object", properties: { range: rangeJsonSchema } },
  async run(input, ctx) {
    const { from, to } = resolveRange(input.range);
    const payments = await db.payment.findMany({
      where: {
        status: "approved",
        collectedByUserId: { not: null },
        order: { restaurantId: ctx.scope.restaurantId, paidAt: { gte: from, lte: to } },
      },
      select: {
        amountCents: true, tipCents: true,
        collectedBy: { select: { name: true, email: true } },
        order: { select: { table: { select: { number: true } } } },
      },
    });
    const rows: StaffRow[] = payments.map((p) => ({
      userName: p.collectedBy?.name || p.collectedBy?.email || "Sin nombre",
      amountCents: p.amountCents,
      tipCents: p.tipCents,
      tableNumber: p.order?.table?.number ?? null,
    }));
    return {
      range: { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) },
      ...aggregateStaff(rows),
    };
  },
};
