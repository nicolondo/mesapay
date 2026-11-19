import { describe, expect, it } from "vitest";
import { shouldAutofocusAmount } from "./autofocusAmount";

const amountInput = { tagName: "INPUT" };
const box = (members: unknown[]) => ({ contains: (n: unknown) => members.includes(n) });

describe("shouldAutofocusAmount", () => {
  it("sin input de monto montado no hay nada que enfocar", () => {
    expect(shouldAutofocusAmount({ active: { tagName: "INPUT" }, supplierBox: box([]), amountInput: null })).toBe(false);
  });

  it("enfoca cuando el foco viene del combobox de proveedor (flujo normal)", () => {
    const supplierInput = { tagName: "INPUT" };
    expect(
      shouldAutofocusAmount({ active: supplierInput, supplierBox: box([supplierInput]), amountInput }),
    ).toBe(true);
  });

  it("enfoca cuando nada tiene el foco (body) o lo tiene un botón", () => {
    expect(shouldAutofocusAmount({ active: null, supplierBox: box([]), amountInput })).toBe(true);
    expect(shouldAutofocusAmount({ active: { tagName: "BODY" }, supplierBox: box([]), amountInput })).toBe(true);
    expect(shouldAutofocusAmount({ active: { tagName: "BUTTON" }, supplierBox: box([]), amountInput })).toBe(true);
  });

  it("NO roba el foco si el usuario está escribiendo en otro campo", () => {
    for (const tagName of ["INPUT", "TEXTAREA", "SELECT"]) {
      expect(shouldAutofocusAmount({ active: { tagName }, supplierBox: box([]), amountInput })).toBe(false);
    }
  });

  it("re-seleccionar está bien si el foco ya está en el monto", () => {
    expect(shouldAutofocusAmount({ active: amountInput, supplierBox: box([]), amountInput })).toBe(true);
  });

  it("sin contenedor de proveedor montado, un campo ajeno conserva el foco", () => {
    expect(shouldAutofocusAmount({ active: { tagName: "INPUT" }, supplierBox: null, amountInput })).toBe(false);
  });
});
