import { describe, it, expect } from "vitest";
import { aggregateCancellations, type CancelRow } from "./cancellations";

const rows: CancelRow[] = [
  { kind: "cancel", reason: "demora", lostCents: 10000 },
  { kind: "cancel", reason: "demora", lostCents: 5000 },
  { kind: "comp", reason: "cortesía", lostCents: 8000 },
];

describe("aggregateCancellations", () => {
  it("separa cancel vs comp y agrupa por motivo", () => {
    const r = aggregateCancellations(rows);
    expect(r.byKind).toContainEqual({ kind: "cancel", count: 2, lostCents: 15000 });
    expect(r.byKind).toContainEqual({ kind: "comp", count: 1, lostCents: 8000 });
    expect(r.totalLostCents).toBe(23000);
    expect(r.byReason[0]).toEqual({ reason: "demora", count: 2, lostCents: 15000 });
  });
});
