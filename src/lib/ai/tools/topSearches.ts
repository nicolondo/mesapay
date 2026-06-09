import { z } from "zod";
import { db } from "@/lib/db";
import type { ToolContext, ToolDef } from "./types";
import { rangeInputZod, rangeJsonSchema } from "./dateRange";
import { resolveRange } from "./dateRange";

export type SearchRow = { term: string; hadResults: boolean };

export function aggregateSearches(rows: SearchRow[], opts: { limit: number }) {
  const map = new Map<string, { count: number; noResults: number }>();
  for (const r of rows) {
    const cur = map.get(r.term) ?? { count: 0, noResults: 0 };
    cur.count += 1;
    if (!r.hadResults) cur.noResults += 1;
    map.set(r.term, cur);
  }
  const all = [...map.entries()].map(([term, v]) => ({
    term,
    count: v.count,
    noResultsPct: Math.round((v.noResults / v.count) * 100),
  }));
  const terms = [...all].sort((a, b) => b.count - a.count).slice(0, opts.limit);
  const topNoResults = [...map.entries()]
    .filter(([, v]) => v.noResults > 0)
    .map(([term, v]) => ({ term, count: v.noResults }))
    .sort((a, b) => b.count - a.count)
    .slice(0, opts.limit);
  return { totalSearches: rows.length, terms, topNoResults };
}

const inputSchema = z.object({
  range: rangeInputZod,
  limit: z.number().int().min(1).max(25).default(10),
});
type Input = z.infer<typeof inputSchema>;

export const topSearchesTool: ToolDef<Input> = {
  name: "top_searches",
  description:
    "Términos que más buscan los comensales en la carta y qué porcentaje no " +
    "arrojó resultados (demanda insatisfecha). Útil para '¿qué busca la gente?' " +
    "y '¿qué buscan y no encuentran?'.",
  inputSchema,
  jsonSchema: {
    type: "object",
    properties: {
      range: rangeJsonSchema,
      limit: { type: "integer", minimum: 1, maximum: 25 },
    },
  },
  async run(input, ctx: ToolContext) {
    const { from, to } = resolveRange(input.range);
    const events = await db.searchEvent.findMany({
      where: { restaurantId: ctx.scope.restaurantId, createdAt: { gte: from, lte: to } },
      select: { term: true, hadResults: true },
    });
    return {
      range: { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) },
      ...aggregateSearches(events, { limit: input.limit }),
    };
  },
};
