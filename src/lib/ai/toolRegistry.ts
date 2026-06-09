import type Anthropic from "@anthropic-ai/sdk";
import type { ToolContext, ToolDef } from "./tools/types";
import { topDishesTool } from "./tools/topDishes";

// Lista de tools disponibles. Planes siguientes agregan más acá.
const TOOLS: ToolDef<any>[] = [topDishesTool];

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
