import { z } from "zod";
import { db } from "@/lib/db";
import type { ToolDef } from "./types";
import { rangeInputZod, rangeJsonSchema, resolveRange } from "./dateRange";

export type CancelRow = { kind: string; reason: string; lostCents: number };

export function aggregateCancellations(rows: CancelRow[]) {
  const kind = new Map<string, { count: number; lostCents: number }>();
  const reason = new Map<string, { count: number; lostCents: number }>();
  let totalLostCents = 0;
  for (const r of rows) {
    totalLostCents += r.lostCents;
    const k = kind.get(r.kind) ?? { count: 0, lostCents: 0 };
    k.count += 1; k.lostCents += r.lostCents; kind.set(r.kind, k);
    const re = reason.get(r.reason) ?? { count: 0, lostCents: 0 };
    re.count += 1; re.lostCents += r.lostCents; reason.set(r.reason, re);
  }
  const byKind = [...kind.entries()].map(([k, v]) => ({ kind: k, ...v }));
  const byReason = [...reason.entries()].map(([re, v]) => ({ reason: re, ...v })).sort((a, b) => b.lostCents - a.lostCents);
  return { totalLostCents, totalCount: rows.length, byKind, byReason };
}

const inputSchema = z.object({ range: rangeInputZod });
type Input = z.infer<typeof inputSchema>;

export const cancellationsTool: ToolDef<Input> = {
  name: "cancellations",
  description:
    "Cancelaciones vs cortesías (comps): cuántas, cuánto dinero se perdió y por " +
    "qué motivos. Útil para '¿cuánto pierdo en cancelaciones y cortesías?'.",
  inputSchema,
  jsonSchema: { type: "object", properties: { range: rangeJsonSchema } },
  async run(input, ctx) {
    const { from, to } = resolveRange(input.range);
    const items = await db.orderItem.findMany({
      where: {
        cancelledAt: { gte: from, lte: to, not: null },
        order: { restaurantId: ctx.scope.restaurantId },
      },
      select: { qty: true, priceCentsSnapshot: true, cancellationKind: true, cancellationReason: true },
    });
    const rows: CancelRow[] = items.map((i) => ({
      kind: i.cancellationKind ?? "cancel",
      reason: i.cancellationReason ?? "sin motivo",
      lostCents: i.qty * i.priceCentsSnapshot,
    }));
    return {
      range: { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) },
      ...aggregateCancellations(rows),
    };
  },
};
