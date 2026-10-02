import { describe, expect, it } from "vitest";
import { creditNoteDeliveryDecision, creditNoteLeaseWhere } from "./creditNoteDeliveryState";

const now = new Date("2026-10-02T16:00:00Z");
const base = { state: "to_send", hasPayload: false, abandoned: false, leaseExpiresAt: null };

describe("credit note delivery decisions", () => {
  it("prepares a new note only before a signed payload exists", () => {
    expect(creditNoteDeliveryDecision(base, now)).toBe("prepare");
    expect(creditNoteDeliveryDecision({ ...base, hasPayload: true }, now)).toBe("lookup");
  });

  it.each(["sent", "error", "pending"])("reconciles %s against the DIAN before sending again", (state) => {
    expect(creditNoteDeliveryDecision({ ...base, state, hasPayload: true }, now)).toBe("lookup");
  });

  it("can rebuild only a note that has never persisted a signed payload", () => {
    expect(creditNoteDeliveryDecision({ ...base, state: "error" }, now)).toBe("prepare");
    expect(creditNoteDeliveryDecision({ ...base, state: "pending" }, now)).toBe("skip");
  });

  it.each(["accepted", "rejected", "unexpected"])("never emits a terminal or unknown state %s", (state) => {
    expect(creditNoteDeliveryDecision({ ...base, state, hasPayload: true }, now)).toBe("skip");
  });

  it("does not reclaim an active lease or an abandoned note", () => {
    expect(creditNoteDeliveryDecision({ ...base, abandoned: true }, now)).toBe("skip");
    expect(creditNoteDeliveryDecision({ ...base, leaseExpiresAt: new Date(now.getTime() + 1) }, now)).toBe("skip");
    expect(creditNoteDeliveryDecision({ ...base, leaseExpiresAt: now }, now)).toBe("prepare");
  });

  it("claims only within the tenant and only after the previous lease expires", () => {
    expect(creditNoteLeaseWhere("doc", "restaurant", now)).toEqual({
      id: "doc", restaurantId: "restaurant", kind: "credit_note",
      state: { in: ["to_send", "error", "sent", "pending"] },
      creditNote: { is: { abandonedAt: null } },
      OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lte: now } }],
    });
  });
});
