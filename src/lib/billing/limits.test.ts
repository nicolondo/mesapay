import { describe, expect, it } from "vitest";
import { MEMBERSHIP_MAX_CENTS } from "./limits";

describe("MEMBERSHIP_MAX_CENTS", () => {
  it("admite mensualidades reales por encima de $1.000.000 (p. ej. Pro a $1.500.000)", () => {
    expect(150_000_000).toBeLessThanOrEqual(MEMBERSHIP_MAX_CENTS);
  });
  it("cabe en una columna Int de Postgres", () => {
    expect(MEMBERSHIP_MAX_CENTS).toBeLessThanOrEqual(2_147_483_647);
  });
});
