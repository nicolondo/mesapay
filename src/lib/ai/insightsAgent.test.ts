import { describe, it, expect, vi } from "vitest";
import { runInsightsAgent } from "./insightsAgent";

function fakeClient(responses: any[]) {
  let i = 0;
  return { messages: { create: vi.fn(async () => responses[i++]) } } as any;
}
const ctx = { scope: { kind: "restaurant", restaurantId: "r1" }, timezone: "America/Bogota" } as any;

describe("runInsightsAgent", () => {
  it("ejecuta tool y devuelve el texto final", async () => {
    const client = fakeClient([
      { stop_reason: "tool_use", content: [
        { type: "tool_use", id: "t1", name: "top_dishes", input: { range: { preset: "30d" }, by: "qty", limit: 5 } },
      ]},
      { stop_reason: "end_turn", content: [{ type: "text", text: "Tu plato top es Taco." }] },
    ]);
    const exec = vi.fn(async () => ({ dishes: [{ name: "Taco", qty: 9 }] }));
    const out = await runInsightsAgent({
      client, model: "claude-x", system: "sys", messages: [{ role: "user", content: "top?" }],
      ctx, executeTool: exec, maxIterations: 6,
    });
    expect(exec).toHaveBeenCalledWith("top_dishes", expect.any(Object), ctx);
    expect(out.text).toContain("Taco");
    expect(out.toolCalls.map((c) => c.name)).toEqual(["top_dishes"]);
  });

  it("al agotar maxIterations hace una llamada final SIN tools y devuelve su texto", async () => {
    const toolMsg = { stop_reason: "tool_use", content: [{ type: "tool_use", id: "t", name: "top_dishes", input: {} }] };
    const finalMsg = { stop_reason: "end_turn", content: [{ type: "text", text: "Con lo disponible, tu mejor categoría es Pizzas." }] };
    const client = fakeClient([toolMsg, toolMsg, finalMsg]);
    const out = await runInsightsAgent({
      client, model: "m", system: "s", messages: [{ role: "user", content: "x" }],
      ctx, executeTool: vi.fn(async () => ({})),
      tools: [{ name: "top_dishes", description: "d", input_schema: { type: "object" } }] as any,
      maxIterations: 2,
    });
    // 2 iteraciones de tool + 1 llamada final de cierre
    expect(client.messages.create).toHaveBeenCalledTimes(3);
    // La llamada final NO debe incluir tools (fuerza al modelo a responder)
    expect(client.messages.create.mock.calls[0][0].tools).toBeDefined();
    expect(client.messages.create.mock.calls[2][0].tools).toBeUndefined();
    expect(out.text).toContain("Pizzas");
  });
});
