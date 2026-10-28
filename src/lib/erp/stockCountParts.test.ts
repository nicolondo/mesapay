import { describe, expect, it } from "vitest";
import { effectiveCountParts, isValidCountParts, MAX_COUNT_PARTS, MAX_COUNT_QTY } from "./stockCountParts";

describe("stock count parts in base units", () => {
  it("preserves repeated scans without changing their order or the input", () => {
    const parts = Object.freeze([12_000, 3_000, 5_000]);
    expect(isValidCountParts(20_000, parts)).toBe(true);
    expect(effectiveCountParts(20_000, parts)).toEqual([12_000, 3_000, 5_000]);
    expect(effectiveCountParts(20_000, parts)).not.toBe(parts);
  });

  it("keeps a counted zero distinct from an ingredient that is not counted", () => {
    expect(isValidCountParts(0, [0])).toBe(true);
    expect(isValidCountParts(null, [])).toBe(true);
    expect(isValidCountParts(0, [])).toBe(false);
    expect(isValidCountParts(null, [0])).toBe(false);
    expect(effectiveCountParts(0, [])).toEqual([0]);
    expect(effectiveCountParts(null, [12_000])).toEqual([]);
  });

  it("supports the maximum quantity and number of scans", () => {
    expect(MAX_COUNT_PARTS).toBe(200);
    expect(MAX_COUNT_QTY).toBe(2_000_000_000);
    expect(isValidCountParts(MAX_COUNT_QTY, [MAX_COUNT_QTY])).toBe(true);
    expect(isValidCountParts(200, Array.from({ length: MAX_COUNT_PARTS }, () => 1))).toBe(true);
  });

  it.each([
    [20, [12, 3, 4]], [20, []], [20, [20.1]], [20, [-1, 21]],
    [20, ["20"]], [20, [null]], [20, null], [20, undefined], [20, "20"],
    [20, [NaN]], [20, [Infinity]], [20, new Array(1)],
    [2_000_000_001, [2_000_000_001]], [2_000_000_000, [2_000_000_000, 1]],
    [201, Array.from({ length: 201 }, () => 1)],
    [-1, [-1]], [NaN, []], [Infinity, []], [1.5, [1.5]], [undefined, []],
  ])("rejects invalid totals/parts: %j / %j", (total, parts) => {
    expect(isValidCountParts(total, parts)).toBe(false);
  });

  it.each([undefined, null, [], [5, 5], [-1, 21], [20.1], ["20"]])("normalizes legacy or inconsistent parts (%j) using the authoritative total", (parts) => {
    expect(effectiveCountParts(20, parts)).toEqual([20]);
  });

  it("does not make invalid historical totals editable as valid inventory", () => {
    expect(effectiveCountParts(-1, [-1])).toEqual([]);
    expect(effectiveCountParts(Infinity, [])).toEqual([]);
  });
});
