import { describe, expect, it } from "vitest";
import { allocateMixedPayment, mixedPaymentBudget, type MixedPaymentBudgetInput } from "./mixedAmount";

const input: MixedPaymentBudgetInput = {
  netSubtotalCents: 100_000, paidCents: 0, paidTipCents: 0, tipPct: 10,
};

const budget = (overrides: Partial<MixedPaymentBudgetInput> = {}) => mixedPaymentBudget({ ...input, ...overrides });

describe("mixedPaymentBudget", () => {
  it("makes a single tip budget for the whole net account", () => {
    expect(budget()).toEqual({ ok: true, targetTipCents: 10_000, remainingTipCents: 10_000, outstandingFoodCents: 100_000, outstandingGrossCents: 110_000 });
  });

  it("subtracts only approved food and already collected tip", () => {
    expect(budget({ paidCents: 33_000, paidTipCents: 3_000 })).toEqual({ ok: true, targetTipCents: 10_000, remainingTipCents: 7_000, outstandingFoodCents: 70_000, outstandingGrossCents: 77_000 });
  });

  it("uses the supplied net after discounts and added taxes", () => {
    expect(budget({ netSubtotalCents: 90_001 })).toMatchObject({ targetTipCents: 9_000, outstandingGrossCents: 99_001 });
  });

  it("can explicitly revise the account percentage after a prior payment without tip", () => {
    expect(budget({ paidCents: 40_000 })).toMatchObject({ remainingTipCents: 10_000, outstandingFoodCents: 60_000, outstandingGrossCents: 70_000 });
    expect(budget({ paidCents: 40_000, tipPct: 0 })).toMatchObject({ remainingTipCents: 0, outstandingGrossCents: 60_000 });
  });

  it("never reverses extra tip or collects it twice", () => {
    expect(budget({ paidCents: 60_000, paidTipCents: 20_000 })).toMatchObject({ remainingTipCents: 0, outstandingFoodCents: 60_000, outstandingGrossCents: 60_000 });
  });

  it.each([0, 100_000, 100_001])("does not propose tip-only payments on a closed/zero account (%s)", (netSubtotalCents) => {
    expect(budget({ netSubtotalCents, paidCents: 100_001 })).toMatchObject({ outstandingFoodCents: 0, remainingTipCents: 0, outstandingGrossCents: 0 });
  });

  it.each([
    { netSubtotalCents: -1 }, { netSubtotalCents: 0.5 }, { netSubtotalCents: NaN },
    { netSubtotalCents: Infinity }, { netSubtotalCents: Number.MAX_SAFE_INTEGER + 1 },
    { paidCents: -1 }, { paidCents: 1.5 }, { paidCents: Infinity },
    { paidTipCents: -1 }, { paidTipCents: 1 }, { paidTipCents: 0.5 },
    { tipPct: -1 }, { tipPct: 31 }, { tipPct: 0.1 }, { tipPct: NaN },
    { netSubtotalCents: Number.MAX_SAFE_INTEGER, tipPct: 30 },
  ])("rejects unsafe or inconsistent input %j", (overrides) => {
    expect(budget(overrides)).toEqual({ ok: false, error: "invalid_balance" });
  });

  it("rounds the account tip half up at an exact cent", () => {
    expect(budget({ netSubtotalCents: 1_005 })).toMatchObject({ targetTipCents: 101, outstandingGrossCents: 1_106 });
  });
});

describe("allocateMixedPayment", () => {
  it("splits a manually entered total into food and included tip", () => {
    expect(allocateMixedPayment(budget(), 33_000)).toEqual({ ok: true, amountCents: 33_000, tipCents: 3_000, foodCents: 30_000, remainingFoodCents: 70_000, remainingTipCents: 7_000, remainingGrossCents: 77_000 });
  });

  it("takes the exact remaining cents when selecting everything", () => {
    expect(allocateMixedPayment(budget({ netSubtotalCents: 10_005, paidCents: 3_337, paidTipCents: 303 }), 7_669)).toEqual({ ok: true, amountCents: 7_669, tipCents: 698, foodCents: 6_971, remainingFoodCents: 0, remainingTipCents: 0, remainingGrossCents: 0 });
  });

  it.each([null, undefined])("distinguishes an empty input (%s)", (amount) => {
    expect(allocateMixedPayment(budget(), amount)).toEqual({ ok: false, error: "empty_amount" });
  });

  it.each([NaN, Infinity, -1, 100.5, Number.MAX_SAFE_INTEGER + 1])("rejects invalid cents %s", (amount) => {
    expect(allocateMixedPayment(budget(), amount)).toEqual({ ok: false, error: "invalid_amount" });
  });

  it.each([0, 1, 99])("respects the existing payment API minimum (%s)", (amount) => {
    expect(allocateMixedPayment(budget(), amount)).toEqual({ ok: false, error: "amount_too_small" });
  });

  it("rejects above the API maximum even if a large account still has balance", () => {
    expect(allocateMixedPayment(budget({ netSubtotalCents: 3_000_000_000 }), 2_000_000_001)).toEqual({ ok: false, error: "amount_too_large" });
  });

  it("rejects an amount beyond the food plus remaining tip", () => {
    expect(allocateMixedPayment(budget(), 110_001)).toEqual({ ok: false, error: "amount_exceeds_outstanding" });
  });

  it("rejects a partial that would leave an unpayable sub-peso remainder", () => {
    expect(allocateMixedPayment(budget(), 109_950)).toEqual({ ok: false, error: "remainder_too_small" });
  });

  it("does not let server close the account with unpaid agreed tip remaining", () => {
    const almostPaid = budget({ netSubtotalCents: 100_000_000, paidCents: 99_999_999 });
    const full = 10_000_001;
    expect(allocateMixedPayment(almostPaid, full - 100)).toEqual({ ok: false, error: "amount_leaves_tip_only" });
    expect(allocateMixedPayment(almostPaid, full)).toMatchObject({ ok: true, foodCents: 1, tipCents: 10_000_000, remainingGrossCents: 0 });
  });

  it("rejects a tiny payment that would be only tip and would not reduce the food balance", () => {
    expect(allocateMixedPayment(budget({ netSubtotalCents: 100_000_000, paidCents: 99_999_999 }), 100)).toEqual({ ok: false, error: "amount_too_small" });
  });

  it("propagates an invalid balance and reports a paid account separately", () => {
    expect(allocateMixedPayment(budget({ tipPct: -1 }), 100)).toEqual({ ok: false, error: "invalid_balance" });
    expect(allocateMixedPayment(budget({ paidCents: 110_000, paidTipCents: 10_000 }), 100)).toEqual({ ok: false, error: "nothing_outstanding" });
  });

  it("uses exact integer products near the maximum permitted payment", () => {
    const b = budget({ netSubtotalCents: 2_000_000_000, tipPct: 30 });
    const first = allocateMixedPayment(b, 2_000_000_000);
    expect(first).toMatchObject({ ok: true, tipCents: 461_538_462, foodCents: 1_538_461_538, remainingGrossCents: 600_000_000 });
    if (!first.ok) throw new Error("expected a valid allocation");
    expect(allocateMixedPayment(budget({ netSubtotalCents: 2_000_000_000, tipPct: 30, paidCents: first.amountCents, paidTipCents: first.tipCents }), first.remainingGrossCents)).toMatchObject({ ok: true, tipCents: 138_461_538, foodCents: 461_538_462, remainingGrossCents: 0 });
  });

  it.each([0, 5, 10, 15, 20, 30])("keeps exact account and tip totals over a long chain at %s%%", (tipPct) => {
    const netSubtotalCents = 9_999_997;
    let paidCents = 0;
    let paidTipCents = 0;
    let count = 0;
    while (count < 10_000) {
      const current = mixedPaymentBudget({ netSubtotalCents, paidCents, paidTipCents, tipPct });
      if (!current.ok) throw new Error("expected a valid balance");
      if (current.outstandingGrossCents === 0) break;
      const selected = Math.min(10_003 + count % 99, current.outstandingGrossCents);
      const amount = current.outstandingGrossCents - selected < 100 ? current.outstandingGrossCents : selected;
      const next = allocateMixedPayment(current, amount);
      if (!next.ok) throw new Error(next.error);
      expect(next.amountCents).toBe(next.foodCents + next.tipCents);
      expect(next.remainingGrossCents).toBe(next.remainingFoodCents + next.remainingTipCents);
      expect(next.remainingGrossCents).toBe(current.outstandingGrossCents - amount);
      paidCents += next.amountCents;
      paidTipCents += next.tipCents;
      count += 1;
    }
    expect(count).toBeGreaterThan(900);
    expect(count).toBeLessThan(10_000);
    expect(paidTipCents).toBe(Math.round(netSubtotalCents * tipPct / 100));
    expect(paidCents - paidTipCents).toBe(netSubtotalCents);
  });

  it("does not mutate the input or balance", () => {
    const frozenInput = Object.freeze({ ...input });
    const frozenBudget = Object.freeze(mixedPaymentBudget(frozenInput));
    expect(allocateMixedPayment(frozenBudget, 11_000)).toMatchObject({ ok: true, amountCents: 11_000 });
    expect(frozenInput).toEqual(input);
    expect(frozenBudget).toEqual(budget());
  });
});
