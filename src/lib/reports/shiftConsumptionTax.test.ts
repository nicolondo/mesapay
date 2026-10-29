import { describe, expect, it } from "vitest";
import { allocateShiftConsumptionTax, sumShiftConsumptionTax, type FiscalPayment } from "./shiftConsumptionTax";

const time = new Date("2026-10-28T17:00:00Z");
const payment = (id: string, amountCents: number, tipCents = 0, patch: Partial<FiscalPayment> = {}): FiscalPayment => ({
  id, amountCents, tipCents, createdAt: time, settledAt: time, ...patch,
});
const invoice = (fiscal: Record<string, unknown> = {}, totalCents = 11900) => ({
  totalCents,
  fiscal: { totalCents, tipCents: 1000, taxCents: 1900, taxByKind: { inc: 0, iva: 1900 }, salesTaxKind: "inc", embeddedTaxCents: 400, ...fiscal },
});
const result = (cents: number, pending = 0) => ({ consumptionTaxCents: cents, taxPendingPayments: pending });

describe("frozen consumption tax allocated to shift payments", () => {
  it("adds frozen embedded INC and explicit INC, excluding IVA and tips", () => {
    const rows = allocateShiftConsumptionTax(invoice({ taxCents: 2000, taxByKind: { inc: 100, iva: 1900 } }), [payment("a", 11900, 1000)]);
    expect(rows.get("a")).toEqual(result(500));
  });

  it("never treats embedded IVA as INC", () => {
    expect(allocateShiftConsumptionTax(invoice({ salesTaxKind: "iva" }), [payment("a", 11900, 1000)]).get("a")).toEqual(result(0));
  });

  it("splits using food paid, keeping a fixed invoice denominator despite different tips", () => {
    const rows = allocateShiftConsumptionTax(invoice({ totalCents: 12000, tipCents: 2000, taxCents: 0, taxByKind: { inc: 0, iva: 0 }, embeddedTaxCents: 740 }, 12000), [
      payment("a", 7000, 2000), payment("b", 5000, 0),
    ]);
    expect(rows.get("a")).toEqual(result(370));
    expect(rows.get("b")).toEqual(result(370));
    expect(sumShiftConsumptionTax(rows, ["b"])).toEqual(result(370));
  });

  it("keeps exact cumulative rounding, stable tie ordering and the refunded payment's original share", () => {
    const frozen = invoice({ totalCents: 3, tipCents: 0, taxCents: 0, taxByKind: { inc: 0, iva: 0 }, embeddedTaxCents: 1 }, 3);
    const rows = allocateShiftConsumptionTax(frozen, [payment("c", 1), payment("b", 1), payment("a", 1)]);
    expect([...rows]).toEqual([["a", result(0)], ["b", result(1)], ["c", result(0)]]);
    // The full settlement history includes a refunded 'b'; selecting the
    // surviving payments must not move b's original tax into a later shift.
    expect(sumShiftConsumptionTax(rows, ["a", "c"])).toEqual(result(0));
    expect(sumShiftConsumptionTax(rows, ["a", "b", "c"])).toEqual(result(1));
  });

  it("uses settledAt, falling back to createdAt for historical payments", () => {
    const frozen = invoice({ totalCents: 2, tipCents: 0, taxCents: 0, taxByKind: { inc: 0, iva: 0 }, embeddedTaxCents: 1 }, 2);
    const rows = allocateShiftConsumptionTax(frozen, [
      payment("a", 1, 0, { settledAt: new Date("2026-10-28T19:00:00Z") }),
      payment("b", 1, 0, { settledAt: null, createdAt: new Date("2026-10-28T18:00:00Z") }),
    ]);
    expect([...rows]).toEqual([["b", result(1)], ["a", result(0)]]);
  });

  it("does not redistribute unpaid portions or allocate more than the frozen tax", () => {
    const frozen = invoice({ totalCents: 1000, tipCents: 0, taxCents: 0, taxByKind: { inc: 0, iva: 0 }, embeddedTaxCents: 80 }, 1000);
    expect(allocateShiftConsumptionTax(frozen, [payment("a", 250)]).get("a")).toEqual(result(20));
    const rows = allocateShiftConsumptionTax(frozen, [payment("a", 750), payment("b", 750), payment("c", 100)]);
    expect([...rows.values()]).toEqual([result(60), result(20), result(0)]);
  });

  it("keeps legacy invoice tax at zero when optional tax fields were never frozen", () => {
    const legacy = { totalCents: 1100, fiscal: { totalCents: 1100, tipCents: 100 } };
    expect(allocateShiftConsumptionTax(legacy, [payment("a", 1100, 100)]).get("a")).toEqual(result(0));
  });

  it("handles valid zero-value and tip-only invoices", () => {
    expect(allocateShiftConsumptionTax({ totalCents: 0, fiscal: { totalCents: 0, tipCents: 0 } }, [payment("a", 0)]).get("a")).toEqual(result(0));
    expect(allocateShiftConsumptionTax({ totalCents: 100, fiscal: { totalCents: 100, tipCents: 100 } }, [payment("a", 100, 100)]).get("a")).toEqual(result(0));
  });

  it("does exact multiplication above Number's safe product range", () => {
    const max = Number.MAX_SAFE_INTEGER;
    const half = Math.floor(max / 2);
    const frozen = { totalCents: max, fiscal: { totalCents: max, tipCents: 0, salesTaxKind: "inc", embeddedTaxCents: max - 1 } };
    const rows = allocateShiftConsumptionTax(frozen, [payment("a", half), payment("b", half + 1)]);
    expect(rows.get("a")).toEqual(result(half));
    expect(rows.get("b")).toEqual(result(half));
    expect(sumShiftConsumptionTax(rows, ["a", "b"])).toEqual(result(max - 1));
  });

  it.each([
    null, { totalCents: 11900, fiscal: null }, { totalCents: 11900, fiscal: [] },
    { totalCents: 11900, fiscal: {} }, invoice({ totalCents: 1 }), invoice({ tipCents: 12000 }),
    invoice({ embeddedTaxCents: "400" }), invoice({ embeddedTaxCents: -1 }), invoice({ embeddedTaxCents: 0.1 }),
    invoice({ embeddedTaxCents: null }), invoice({ embeddedTaxCents: 12000 }),
    invoice({ salesTaxKind: "unexpected" }), invoice({ salesTaxKind: "none" }),
    invoice({ taxByKind: null }), invoice({ taxByKind: { inc: 0, iva: 0 } }),
    invoice({ taxByKind: { inc: -1, iva: 1901 } }), invoice({ taxCents: "1900" }),
    { totalCents: 11900, fiscal: { totalCents: 11900, tipCents: 1000, taxCents: 1900 } },
  ])("marks unknown or unreliable frozen values as pending: %j", (frozen) => {
    expect(allocateShiftConsumptionTax(frozen, [payment("a", 11900, 1000), payment("b", 0)]).get("a")).toEqual(result(0, 1));
    expect(sumShiftConsumptionTax(allocateShiftConsumptionTax(frozen, [payment("a", 11900, 1000), payment("b", 0)]), ["a", "b"])).toEqual(result(0, 2));
  });

  it.each([
    payment("b", -1), payment("b", 1, 2), payment("b", 0.1), payment("b", Number.MAX_SAFE_INTEGER + 1),
    payment("b", 1, 0, { settledAt: new Date("invalid") }),
  ])("does not reallocate around an unreliable historical payment", (bad) => {
    expect(allocateShiftConsumptionTax(invoice(), [payment("a", 11900, 1000), bad]).get("a")).toEqual(result(0, 1));
  });

  it("deduplicates selected IDs and flags a selected payment absent from the tenant projection", () => {
    const rows = allocateShiftConsumptionTax(invoice(), [payment("a", 11900, 1000)]);
    expect(sumShiftConsumptionTax(rows, ["a", "a", "foreign"])).toEqual(result(400, 1));
  });
});
