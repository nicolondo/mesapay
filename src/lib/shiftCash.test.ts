import { describe, expect, it } from "vitest";
import { Prisma } from "@prisma/client";
import { cashCentsToNumber, shiftCashToNumbers } from "./shiftCash";
import { serializeRow, deserializeRow } from "./backups/serialize";
import { tenantModel } from "./backups/tables";

describe("shift cash amounts", () => {
  it.each([0, 2_147_483_647, 2_771_025_000, 3_433_623_000, 10_000_000_000, -3_433_623_000, Number.MAX_SAFE_INTEGER, Number.MIN_SAFE_INTEGER])("preserves %s cents exactly", (amount) => {
    expect(cashCentsToNumber(BigInt(amount))).toBe(amount);
    expect(cashCentsToNumber(amount)).toBe(amount);
  });

  it.each([BigInt(Number.MAX_SAFE_INTEGER) + BigInt(1), BigInt(Number.MIN_SAFE_INTEGER) - BigInt(1), Number.MAX_SAFE_INTEGER + 1, 1.5, NaN, Infinity])("rejects unsafe or fractional value %s", (value) => {
    expect(() => cashCentsToNumber(value)).toThrow("cash_amount_out_of_range");
  });

  it("keeps null, zero, dates, and relations without mutating the record", () => {
    const source = Object.freeze({
      id: "shift", openedAt: new Date(), user: { name: "Ana" },
      openingCashCents: BigInt(40_000_000), declaredCashCents: null,
      expectedCashCents: BigInt(2_771_025_000), cashDiffCents: BigInt(0),
    });
    const dto = shiftCashToNumbers(source);
    expect(dto).toEqual({ ...source, openingCashCents: 40_000_000, expectedCashCents: 2_771_025_000, cashDiffCents: 0 });
    expect(dto.openedAt).toBe(source.openedAt);
    expect(dto.user).toBe(source.user);
    expect(JSON.parse(JSON.stringify(dto)).expectedCashCents).toBe(2_771_025_000);
    expect(source.expectedCashCents).toBe(BigInt(2_771_025_000));
  });

  it("uses BigInt in the generated database model for every cash field", () => {
    const fields = Prisma.dmmf.datamodel.models.find((m) => m.name === "Shift")!.fields;
    for (const name of ["openingCashCents", "declaredCashCents", "expectedCashCents", "cashDiffCents"]) {
      expect(fields.find((f) => f.name === name)?.type).toBe("BigInt");
    }
  });

  it("round-trips new backups and restores legacy numeric backups exactly", () => {
    const fields = tenantModel("Shift")!.fields;
    const legacy = { openingCashCents: 40_000_000, declaredCashCents: 2_771_025_000, expectedCashCents: 3_433_623_000, cashDiffCents: -662_598_000 };
    const restored = deserializeRow(fields, legacy);
    expect(restored.declaredCashCents).toBe(BigInt(2_771_025_000));
    const json = JSON.parse(JSON.stringify(serializeRow(fields, restored)));
    expect(json.declaredCashCents).toBe("2771025000");
    expect(deserializeRow(fields, json)).toEqual(restored);
  });
});
