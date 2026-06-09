import type Anthropic from "@anthropic-ai/sdk";
import type { ToolContext, ToolDef } from "./tools/types";
import { topDishesTool } from "./tools/topDishes";
import { topSearchesTool } from "./tools/topSearches";
import { salesOverviewTool } from "./tools/salesOverview";
import { revenueTrendTool } from "./tools/revenueTrend";
import { categoryBreakdownTool } from "./tools/categoryBreakdown";
import { trafficByTimeTool } from "./tools/trafficByTime";
import { tablesTurnoverTool } from "./tools/tablesTurnover";
import { paymentMixTool } from "./tools/paymentMix";
import { staffPerformanceTool } from "./tools/staffPerformance";
import { staffingEstimateTool } from "./tools/staffingEstimate";
import { kitchenBottlenecksTool } from "./tools/kitchenBottlenecks";
import { cancellationsTool } from "./tools/cancellations";
import { reservationsInsightsTool } from "./tools/reservationsInsights";

// Lista de tools disponibles. Planes siguientes agregan más acá.
const TOOLS: ToolDef<any>[] = [
  topDishesTool,
  salesOverviewTool,
  revenueTrendTool,
  categoryBreakdownTool,
  trafficByTimeTool,
  tablesTurnoverTool,
  paymentMixTool,
  staffPerformanceTool,
  staffingEstimateTool,
  kitchenBottlenecksTool,
  cancellationsTool,
  topSearchesTool,
  reservationsInsightsTool,
];

/** Definiciones que ve Claude (name/description/input_schema). */
export function anthropicTools(): Anthropic.Tool[] {
  return TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.jsonSchema as Anthropic.Tool.InputSchema,
  }));
}

/** Ejecuta una tool por nombre, validando el input con su Zod schema. */
export async function executeTool(
  name: string,
  rawInput: unknown,
  ctx: ToolContext,
): Promise<unknown> {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) return { error: `tool desconocida: ${name}` };
  const parsed = tool.inputSchema.safeParse(rawInput ?? {});
  if (!parsed.success) return { error: "input inválido", issues: parsed.error.issues.slice(0, 3) };
  try {
    return await tool.run(parsed.data, ctx);
  } catch (err) {
    return { error: err instanceof Error ? err.message : "tool falló" };
  }
}
