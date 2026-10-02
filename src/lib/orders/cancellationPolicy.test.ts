import { describe, expect, it } from "vitest";
import {
  canCancelPreparedItems, cancellationRequiresAdmin, hasPreparationStarted,
  preparationHistoryData, assertCancellationAllowed, CancellationPermissionError,
} from "./cancellationPolicy";

const started = new Date("2026-10-02T12:00:00Z");
const now = new Date("2026-10-02T12:30:00Z");
const pending = { menuItemId: "dish", kitchenStatus: "placed", preparationStartedAt: null, preparationFirstStartedAt: null, servedAt: null };

describe("cancellation after preparation", () => {
  it.each(["operator", "platform_admin", "group_admin"])("%s may cancel prepared dishes", (role) => {
    expect(canCancelPreparedItems(role)).toBe(true);
    expect(cancellationRequiresAdmin(role, { ...pending, kitchenStatus: "ready" })).toBe(false);
    expect(() => assertCancellationAllowed(role, [{ ...pending, servedAt: started }])).not.toThrow();
  });
  it.each(["mesero", "kitchen", "bar", "terminal", "diner", undefined, null, "unknown"])("%s cannot cancel once preparation starts", (role) => {
    expect(canCancelPreparedItems(role)).toBe(false);
    expect(cancellationRequiresAdmin(role, pending)).toBe(false);
    for (const change of [
      { kitchenStatus: "in_kitchen" }, { kitchenStatus: "ready" }, { servedAt: started },
      { preparationStartedAt: started }, { preparationFirstStartedAt: started.toISOString() },
    ]) {
      const item = { ...pending, ...change };
      expect(hasPreparationStarted(item)).toBe(true);
      expect(cancellationRequiresAdmin(role, item)).toBe(true);
      expect(() => assertCancellationAllowed(role, [pending, item])).toThrow(CancellationPermissionError);
    }
  });
  it("does not mistake manual invoices or free charges for cooked dishes", () => {
    const technical = { ...pending, kitchenStatus: "ready", servedAt: started };
    expect(hasPreparationStarted(technical, "manual")).toBe(false);
    expect(hasPreparationStarted({ ...technical, menuItemId: null })).toBe(false);
    expect(hasPreparationStarted({ ...technical, preparationFirstStartedAt: started }, "manual")).toBe(true);
    expect(() => assertCancellationAllowed("mesero", [])).not.toThrow();
  });
  it("keeps the first preparation history even when the visible state is reset", () => {
    const first = preparationHistoryData(pending, { kitchenStatus: "in_kitchen" }, now);
    expect(first).toEqual({ preparationFirstStartedAt: now });
    const prepared = { ...pending, preparationStartedAt: started };
    expect(preparationHistoryData(prepared, { kitchenStatus: "placed", preparationStartedAt: null }, now))
      .toEqual({ preparationFirstStartedAt: started });
    expect(preparationHistoryData({ ...pending, kitchenStatus: "ready" }, { kitchenStatus: "placed" }, now))
      .toEqual({ preparationFirstStartedAt: now });
    expect(preparationHistoryData({ ...pending, servedAt: started }, { servedAt: null }, now))
      .toEqual({ preparationFirstStartedAt: started });
    expect(preparationHistoryData({ ...pending, preparationFirstStartedAt: started }, { kitchenStatus: "in_kitchen" }, now))
      .toEqual({});
  });
  it("stamps a direct serve, but leaves never-prepared and technical lines alone", () => {
    expect(preparationHistoryData(pending, { servedAt: now }, now)).toEqual({ preparationFirstStartedAt: now });
    expect(preparationHistoryData(pending, { kitchenStatus: "placed" }, now)).toEqual({});
    expect(preparationHistoryData({ ...pending, menuItemId: null }, { kitchenStatus: "ready", servedAt: now }, now)).toEqual({});
    expect(preparationHistoryData(pending, { kitchenStatus: "ready", servedAt: now }, now, "manual")).toEqual({});
  });
});
