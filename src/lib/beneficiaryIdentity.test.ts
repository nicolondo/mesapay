import { describe, expect, it } from "vitest";
import { compareBeneficiaryIds } from "./beneficiaryIdentity";

const compare = (
  taxId: string,
  holderDocNumber: string,
  holderDocType = "NIT",
  country = "CO",
) => compareBeneficiaryIds({ taxId, holderDocNumber, holderDocType, country });

describe("beneficiary document identity", () => {
  it.each([
    ["901944469-1", "901944469"],
    ["901.944.469 - 1", "901.944.469"],
    ["901944469", "901944469-1"],
    ["901944469-1", "901944469-1"],
  ])("recognizes a validated, separate DV: %s / %s", (rut, bank) => {
    expect(compare(rut, bank)).toEqual({
      matches: true,
      rutId: "901944469",
      bankId: "901944469",
    });
  });
  it.each([
    ["901944469-2", "901944469"],
    ["901944469-2", "901944469-2"],
    ["901944469", "901944469-2"],
    ["901944469-1", "901944468"],
    ["9019444691", "901944469"],
    ["901944469-1-0", "901944469"],
    ["ABC901944469", "901944469"],
    ["", ""],
  ])("does not approve invalid or different IDs: %s / %s", (rut, bank) => {
    expect(compare(rut, bank).matches).toBe(false);
  });
  it("does not remove a digit from a citizen document", () => {
    expect(compare("901944469-1", "9019444691", "CC").matches).toBe(false);
  });
  it("preserves RFC letters outside Colombia", () => {
    expect(compare("ABC010203XX1", "ABC010203XX1", "NIT", "MX").matches).toBe(
      true,
    );
    expect(compare("ABC010203XX1", "DEF010203XX1", "NIT", "MX").matches).toBe(
      false,
    );
  });
});
