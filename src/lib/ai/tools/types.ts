import type { ZodTypeAny } from "zod";
import type { InsightsScope } from "../scope";

export type ToolContext = { scope: InsightsScope; timezone: string };

/** Una herramienta de analítica para el agente. */
export type ToolDef<I> = {
  name: string;
  description: string;
  inputSchema: ZodTypeAny; // valida el input que manda Claude
  jsonSchema: Record<string, unknown>; // schema que ve Claude (input_schema)
  run: (input: I, ctx: ToolContext) => Promise<unknown>;
};
