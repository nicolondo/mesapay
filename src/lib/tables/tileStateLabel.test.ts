import { describe, expect, it } from "vitest";
import { tileStateLabelKey } from "./tileStateLabel";
import { tileTokensForState, type TableVisualState } from "@/lib/walkoutRisk";

const none = { needsWaiter: false, pendingMethods: [] as string[] };

describe("tileStateLabelKey", () => {
  it("libre y recién pagada ya tienen su texto propio", () => {
    expect(tileStateLabelKey("free", none)).toBeNull();
    expect(tileStateLabelKey("recently_paid", none)).toBeNull();
  });

  it("nombra cada estado de una cuenta abierta", () => {
    expect(tileStateLabelKey("cooking", none)).toBe("tileStateCooking");
    expect(tileStateLabelKey("ready_to_serve", none)).toBe("tileStateReady");
    expect(tileStateLabelKey("eating", none)).toBe("tileStateEating");
    expect(tileStateLabelKey("eating_at_risk", none)).toBe("tileStateUnpaid");
    expect(tileStateLabelKey("danger", none)).toBe("tileStateWalkout");
  });

  it("por cobrar: dice con qué quiere pagar, o que llamó al mesero", () => {
    expect(tileStateLabelKey("needs_payment", { needsWaiter: false, pendingMethods: ["cash"] })).toBe("tileStateAskedCash");
    expect(tileStateLabelKey("needs_payment_urgent", { needsWaiter: true, pendingMethods: ["external_terminal"] })).toBe(
      "tileStateAskedTerminal",
    );
    expect(tileStateLabelKey("needs_payment", { needsWaiter: false, pendingMethods: ["kushki_card_terminal"] })).toBe(
      "tileStateAskedTerminal",
    );
    expect(tileStateLabelKey("needs_payment", { needsWaiter: true, pendingMethods: [] })).toBe("tileStateCalledWaiter");
    expect(tileStateLabelKey("needs_payment", { needsWaiter: false, pendingMethods: ["kushki_pse"] })).toBe(
      "tileStateAskedBill",
    );
  });
});

describe("tileTokensForState", () => {
  const actionStates: TableVisualState[] = ["ready_to_serve", "eating_at_risk", "needs_payment", "needs_payment_urgent", "danger"];
  it("los estados que piden acción llevan borde sólido de 2 px (se ven aunque el tinte se lave)", () => {
    for (const s of actionStates) {
      const { border } = tileTokensForState(s);
      expect(border).toContain("border-2");
      expect(border).not.toMatch(/\/\d/);
    }
  });

  it("el monto de «por cobrar» ya no usa terracotta (3.4:1 sobre su tinte)", () => {
    expect(tileTokensForState("needs_payment").textAccent).toBe("text-terracotta-2");
  });
});
