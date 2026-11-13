import { describe, expect, it } from "vitest";
import { ingredientMatchesSearch } from "./ingredientSearch";

const vino = {
  name: "Rosaleda Sauvignon Blanc",
  category: "Vinos",
  sku: "VIN-021",
  barcode: "7800000000017",
  barcodes: [{ barcode: "7800000000017" }, { barcode: "7800000000024" }],
};

describe("ingredientMatchesSearch", () => {
  it("vacío coincide con todo", () => {
    expect(ingredientMatchesSearch(vino, "")).toBe(true);
    expect(ingredientMatchesSearch(vino, "   ")).toBe(true);
  });

  it("por nombre, categoría o SKU, sin tildes ni mayúsculas", () => {
    expect(ingredientMatchesSearch(vino, "sauvignon")).toBe(true);
    expect(ingredientMatchesSearch(vino, "VINOS")).toBe(true);
    expect(ingredientMatchesSearch(vino, "vin-021")).toBe(true);
    expect(ingredientMatchesSearch({ ...vino, name: "Azúcar morena" }, "azucar")).toBe(true);
    expect(ingredientMatchesSearch(vino, "cerveza")).toBe(false);
  });

  it("por el código de barras principal o por uno adicional", () => {
    expect(ingredientMatchesSearch(vino, "7800000000017")).toBe(true);
    expect(ingredientMatchesSearch(vino, "7800000000024")).toBe(true);
    expect(ingredientMatchesSearch(vino, "7800000000031")).toBe(false);
  });

  it("lo que teclea el lector (espacios, salto de línea) también encuentra", () => {
    expect(ingredientMatchesSearch(vino, " 7800000000024\n")).toBe(true);
    expect(ingredientMatchesSearch(vino, "78000 00000 024")).toBe(true);
  });

  it("un tramo del código sirve", () => {
    expect(ingredientMatchesSearch(vino, "0000024")).toBe(true);
  });

  it("sin registro de códigos adicionales usa el principal; sin código no coincide por código", () => {
    expect(ingredientMatchesSearch({ name: "Queso", category: null, barcode: "7700000000015" }, "7700000000015")).toBe(true);
    expect(ingredientMatchesSearch({ name: "Queso", category: null, barcode: null }, "7700000000015")).toBe(false);
  });

  it("códigos alfanuméricos sin distinguir mayúsculas", () => {
    expect(ingredientMatchesSearch({ name: "Caja", category: null, barcode: "ABC-123" }, "abc-123")).toBe(true);
  });
});
