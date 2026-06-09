import type Anthropic from "@anthropic-ai/sdk";
import type { ToolContext } from "./tools/types";

export type AgentMessage = { role: "user" | "assistant"; content: any };
export type AgentResult = {
  text: string;
  toolCalls: { name: string; input: unknown }[];
};

export async function runInsightsAgent(args: {
  client: Anthropic;
  model: string;
  system: string;
  messages: AgentMessage[];
  ctx: ToolContext;
  executeTool: (name: string, input: unknown, ctx: ToolContext) => Promise<unknown>;
  tools?: Anthropic.Tool[];
  maxIterations?: number;
}): Promise<AgentResult> {
  const { client, model, system, ctx, executeTool } = args;
  const messages: any[] = [...args.messages];
  const toolCalls: { name: string; input: unknown }[] = [];
  const maxIterations = args.maxIterations ?? 8;

  for (let i = 0; i < maxIterations; i++) {
    const res: Anthropic.Messages.Message = await client.messages.create({
      model,
      max_tokens: 1500,
      system,
      tools: args.tools,
      messages,
    });
    const toolUses = (res.content ?? []).filter(
      (b): b is Anthropic.Messages.ToolUseBlock => b.type === "tool_use",
    );
    if (res.stop_reason !== "tool_use" || toolUses.length === 0) {
      const text = (res.content ?? [])
        .filter((b: any) => b.type === "text")
        .map((b: any) => b.text)
        .join("\n")
        .trim();
      return { text: text || "(sin respuesta)", toolCalls };
    }
    // Ejecutar todas las tools pedidas y devolver los resultados.
    messages.push({ role: "assistant", content: res.content });
    const results: any[] = [];
    for (const tu of toolUses) {
      toolCalls.push({ name: tu.name, input: tu.input });
      const out = await executeTool(tu.name, tu.input, ctx);
      results.push({ type: "tool_result", tool_use_id: tu.id, content: JSON.stringify(out) });
    }
    messages.push({ role: "user", content: results });
  }
  // Agotó el presupuesto de tool-calls: pedimos una respuesta final SIN tools
  // para que el modelo redacte con lo que ya obtuvo, en vez de un dead-end.
  const finalRes: Anthropic.Messages.Message = await client.messages.create({
    model,
    max_tokens: 1500,
    system,
    messages,
  });
  const finalText = (finalRes.content ?? [])
    .filter((b): b is Anthropic.Messages.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
  return {
    text: finalText || "No pude completar el análisis. Probá una pregunta más específica.",
    toolCalls,
  };
}
