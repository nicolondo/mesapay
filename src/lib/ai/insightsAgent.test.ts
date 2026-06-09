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

  it("corta en maxIterations sin loop infinito", async () => {
    const toolMsg = { stop_reason: "tool_use", content: [{ type: "tool_use", id: "t", name: "top_dishes", input: {} }] };
    const client = fakeClient([toolMsg, toolMsg, toolMsg, toolMsg]);
    const out = await runInsightsAgent({
      client, model: "m", system: "s", messages: [{ role: "user", content: "x" }],
      ctx, executeTool: vi.fn(async () => ({})), maxIterations: 2,
    });
    expect(client.messages.create).toHaveBeenCalledTimes(2);
    expect(out.text).toMatch(/no pude completar|límite/i);
  });
});
