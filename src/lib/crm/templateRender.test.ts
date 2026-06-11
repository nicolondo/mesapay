import { describe, it, expect } from "vitest";
import { renderTemplate } from "./templateRender";

describe("renderTemplate", () => {
  it("replaces a basic variable", () => {
    expect(renderTemplate("Hola {{nombre}}", { nombre: "Juan" })).toBe(
      "Hola Juan",
    );
  });

  it("tolerates spaces inside delimiters", () => {
    expect(
      renderTemplate("Hola {{ nombre }} de {{ ciudad }}", {
        nombre: "Ana",
        ciudad: "Bogotá",
      }),
    ).toBe("Hola Ana de Bogotá");
  });

  it("replaces unknown keys with empty string", () => {
    expect(renderTemplate("Hello {{desconocido}}", {})).toBe("Hello ");
  });

  it("escapes HTML in values", () => {
    const result = renderTemplate("{{codigo}}", {
      codigo: "<script>alert(1)</script>",
    });
    expect(result).not.toContain("<script>");
    expect(result).toContain("&lt;script&gt;");
  });

  it("handles multiple replacements of same key", () => {
    expect(
      renderTemplate("{{nombre}} y {{nombre}}", { nombre: "Carlos" }),
    ).toBe("Carlos y Carlos");
  });

  it("leaves non-matching text untouched", () => {
    expect(renderTemplate("Sin variables aquí", { nombre: "X" })).toBe(
      "Sin variables aquí",
    );
  });
});
