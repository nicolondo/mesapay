import { describe, expect, it } from "vitest";
import {
  MANUAL_TABLE_FIRST_NUMBER,
  nextManualTableNumber,
} from "./manualInvoice";

describe("nextManualTableNumber — numeración de las mesas manuales", () => {
  it("la primera del comercio es -100, sin importar las mesas físicas", () => {
    expect(nextManualTableNumber([])).toBe(MANUAL_TABLE_FIRST_NUMBER);
    expect(nextManualTableNumber([1, 2, 3, 12])).toBe(-100);
  });

  it("nunca roza a la de recogida (-1) ni al mostrador (0)", () => {
    expect(nextManualTableNumber([0, 1, 2])).toBe(-100);
    expect(nextManualTableNumber([-1, 0, 1])).toBe(-100);
  });

  it("baja de a uno desde la más baja que exista", () => {
    expect(nextManualTableNumber([-100, 1, 2, -1])).toBe(-101);
    expect(nextManualTableNumber([-100, -101, -102])).toBe(-103);
  });

  it("si alguien ya bajó más allá del rango, sigue desde ahí", () => {
    expect(nextManualTableNumber([-150])).toBe(-151);
  });
});
