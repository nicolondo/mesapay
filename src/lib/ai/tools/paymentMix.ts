import { z } from "zod";
import { db } from "@/lib/db";
import type { ToolDef } from "./types";
import { rangeInputZod, rangeJsonSchema, resolveRange } from "./dateRange";

export type PayRow = { method: string; amountCents: number; tipCents: number };

export function aggregatePayments(rows: PayRow[]) {
  const map = new Map<string, { count: number; amountCents: number; tipCents: number }>();
  let totalAmountCents = 0, totalTipCents = 0;
  for (const r of rows) {
    const cur = map.get(r.method) ?? { count: 0, amountCents: 0, tipCents: 0 };
    cur.count += 1;
    cur.amountCents += r.amountCents;
    cur.tipCents += r.tipCents;
    map.set(r.method, cur);
    totalAmountCents += r.amountCents;
    totalTipCents += r.tipCents;
  }
  const methods = [...map.entries()]
    .map(([method, v]) => ({ method, ...v }))
    .sort((a, b) => b.amountCents - a.amountCents);
  return {
    totalAmountCents,
    totalTipCents,
    tipRatePct: totalAmountCents ? Math.round((totalTipCents / totalAmountCents) * 100) : 0,
    methods,
  };
}

const inputSchema = z.object({ range: rangeInputZod });
type Input = z.infer<typeof inputSchema>;

export const paymentMixTool: ToolDef<Input> = {
  name: "payment_mix",
  description:
    "Desglose de los pagos aprobados por método (tarjeta, efectivo, etc.), con " +
    "montos y propinas. Útil para '¿cómo me pagan?' y cuánto entra de propina.",
  inputSchema,
  jsonSchema: { type: "object", properties: { range: rangeJsonSchema } },
  async run(input, ctx) {
    const { from, to } = resolveRange(input.range);
    const payments = await db.payment.findMany({
      where: {
        status: "approved",
        order: { restaurantId: ctx.scope.restaurantId, paidAt: { gte: from, lte: to } },
      },
      select: { method: true, amountCents: true, tipCents: true },
    });
    return {
      range: { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) },
      ...aggregatePayments(payments),
    };
  },
};
