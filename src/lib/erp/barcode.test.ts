import { describe, expect, it } from "vitest";
import { ingredientBarcodeValues, mergeIngredientBarcodes, normalizeBarcode } from "./barcode";

// La normalización es el único punto donde se decide qué es "el mismo
// código": si escanear y guardar no limpian igual, el salto al insumo en el
// conteo falla en silencio. De ahí que se pruebe la basura real del lector.
describe("normalizeBarcode", () => {
  it("deja intacto un EAN-13 limpio", () => {
    expect(normalizeBarcode("7702001007035")).toBe("7702001007035");
  });

  it("quita el Enter y el tabulador que manda el lector HID", () => {
    expect(normalizeBarcode("7702001007035\r\n")).toBe("7702001007035");
    expect(normalizeBarcode("\t7702001007035\t")).toBe("7702001007035");
  });

  it("quita los espacios que se cuelan al digitar a mano", () => {
    expect(normalizeBarcode("  770 200 1007035 ")).toBe("7702001007035");
  });

  it("respeta la caja: Code128 con minúsculas no se toca", () => {
    expect(normalizeBarcode("ab12Xy")).toBe("ab12Xy");
  });

  it("descarta lo que no es ASCII imprimible (ruido del lector)", () => {
    expect(normalizeBarcode("770\u0000200\u001f1007035")).toBe("7702001007035");
  });

  it("vacío, solo-espacios, null y undefined son 'sin código'", () => {
    expect(normalizeBarcode("")).toBeNull();
    expect(normalizeBarcode("   ")).toBeNull();
    expect(normalizeBarcode(null)).toBeNull();
    expect(normalizeBarcode(undefined)).toBeNull();
  });
});

describe("multiple ingredient barcodes", () => {
  it("reads primary and aliases once, retaining case and leading zeroes", () => {
    expect(ingredientBarcodeValues({ barcode: "001", barcodes: [{ barcode: "001" }, { barcode: "abc" }, { barcode: "ABC" }, { barcode: "\t" }] })).toEqual(["001", "abc", "ABC"]);
    expect(ingredientBarcodeValues({ barcode: null })).toEqual([]);
  });
  it("uses authoritative codes when another operator changes the primary, preserving local inventory fields", () => {
    const current = { id: "a", barcode: "OLD", barcodes: [{ barcode: "OLD" }, { barcode: "alias" }], qty: "12", name: "Water" };
    const incoming = { id: "a", barcode: "NEW", barcodes: [{ barcode: "NEW" }, { barcode: "alias" }, { barcode: "added" }] };
    expect(mergeIngredientBarcodes(current, incoming)).toEqual({ ...current, barcode: "NEW", barcodes: incoming.barcodes });
    expect(current.barcodes).toEqual([{ barcode: "OLD" }, { barcode: "alias" }]);
  });
});
