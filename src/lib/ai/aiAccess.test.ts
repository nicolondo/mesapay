import { describe, it, expect } from "vitest";
import { isAiEnabledForPlan, resolveAiEnabled } from "./aiAccess";

describe("isAiEnabledForPlan", () => {
  it("habilita trial y pro, no basic", () => {
    expect(isAiEnabledForPlan("trial")).toBe(true);
    expect(isAiEnabledForPlan("pro")).toBe(true);
    expect(isAiEnabledForPlan("basic")).toBe(false);
  });
});

describe("resolveAiEnabled (override gana al plan)", () => {
  it("override=true habilita aunque el plan sea basic", () => {
    expect(resolveAiEnabled({ plan: "basic", aiInsightsEnabled: true })).toBe(true);
  });
  it("override=false deshabilita aunque el plan sea pro", () => {
    expect(resolveAiEnabled({ plan: "pro", aiInsightsEnabled: false })).toBe(false);
  });
  it("override=null cae al plan", () => {
    expect(resolveAiEnabled({ plan: "pro", aiInsightsEnabled: null })).toBe(true);
    expect(resolveAiEnabled({ plan: "basic", aiInsightsEnabled: null })).toBe(false);
  });
});
