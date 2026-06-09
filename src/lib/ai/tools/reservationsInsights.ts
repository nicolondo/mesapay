import { z } from "zod";
import { db } from "@/lib/db";
import type { ToolDef } from "./types";
import { rangeInputZod, rangeJsonSchema, resolveRange } from "./dateRange";

export type ResRow = { status: string; partySize: number; depositStatus: string; depositCents: number };

export function aggregateReservations(rows: ResRow[]) {
  const status = new Map<string, number>();
  let totalGuests = 0, depositsForfeitedCents = 0, depositsPaidCents = 0;
  for (const r of rows) {
    status.set(r.status, (status.get(r.status) ?? 0) + 1);
    totalGuests += r.partySize;
    if (r.depositStatus === "forfeited") depositsForfeitedCents += r.depositCents;
    if (r.depositStatus === "paid" || r.depositStatus === "applied") depositsPaidCents += r.depositCents;
  }
  const total = rows.length;
  const noShow = status.get("no_show") ?? 0;
  const byStatus = [...status.entries()].map(([s, count]) => ({ status: s, count })).sort((a, b) => b.count - a.count);
  return {
    total,
    totalGuests,
    byStatus,
    noShowPct: total ? Math.round((noShow / total) * 100) : 0,
    depositsPaidCents,
    depositsForfeitedCents,
  };
}

const inputSchema = z.object({ range: rangeInputZod });
type Input = z.infer<typeof inputSchema>;

export const reservationsInsightsTool: ToolDef<Input> = {
  name: "reservations_insights",
  description:
    "Reservas del período: totales, comensales, tasa de no-shows y depósitos " +
    "cobrados/perdidos. Útil para '¿cómo vienen las reservas y los no-shows?'.",
  inputSchema,
  jsonSchema: { type: "object", properties: { range: rangeJsonSchema } },
  async run(input, ctx) {
    const { from, to } = resolveRange(input.range);
    const rs = await db.reservation.findMany({
      where: { restaurantId: ctx.scope.restaurantId, startsAt: { gte: from, lte: to } },
      select: { status: true, partySize: true, depositStatus: true, depositCents: true },
    });
    const rows: ResRow[] = rs.map((r) => ({
      status: r.status,
      partySize: r.partySize,
      depositStatus: r.depositStatus,
      depositCents: r.depositCents ?? 0,
    }));
    return {
      range: { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) },
      ...aggregateReservations(rows),
    };
  },
};
