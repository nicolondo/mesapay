import { describe, expect, it } from "vitest";
import { displayOrderCode, shortCode } from "@/lib/shortCode";

describe("shortCode", () => {
  it("genera 4 grupos de 6 hex mayúsculas separados por guión", () => {
    expect(shortCode()).toMatch(/^[0-9A-F]{6}(-[0-9A-F]{6}){3}$/);
  });
});

describe("displayOrderCode", () => {
  it("devuelve el primer grupo cuando hay guiones", () => {
    expect(displayOrderCode("002A77-77C496-58E6EF-6C25C8")).toBe("002A77");
  });

  it("recorta a 6 caracteres cuando no hay guiones", () => {
    expect(displayOrderCode("002A7777C49658E6EF6C25C8")).toBe("002A77");
  });

  it("deja intacto un código más corto que un grupo", () => {
    expect(displayOrderCode("A4F2")).toBe("A4F2");
  });

  it("devuelve vacío para null, undefined o cadena vacía", () => {
    expect(displayOrderCode(null)).toBe("");
    expect(displayOrderCode(undefined)).toBe("");
    expect(displayOrderCode("")).toBe("");
  });

  it("es el primer grupo de un código recién generado", () => {
    const code = shortCode();
    expect(displayOrderCode(code)).toBe(code.slice(0, 6));
  });
});
