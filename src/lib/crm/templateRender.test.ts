import { describe, it, expect } from "vitest";
import { renderTemplate, nl2brIfPlain } from "./templateRender";

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

describe("nl2brIfPlain", () => {
  it("converts newlines to <br> in plain text", () => {
    expect(nl2brIfPlain("Hola\n\n¿Cómo estás?\nChao")).toBe(
      "Hola<br><br>¿Cómo estás?<br>Chao",
    );
  });

  it("converts CRLF newlines too", () => {
    expect(nl2brIfPlain("a\r\nb")).toBe("a<br>b");
  });

  it("leaves real HTML with <p> blocks untouched", () => {
    const html = "<p>Hola</p>\n<p>Chao</p>";
    expect(nl2brIfPlain(html)).toBe(html);
  });

  it("leaves HTML that already uses <br> untouched", () => {
    const html = "Hola<br>Chao\ncon salto crudo";
    expect(nl2brIfPlain(html)).toBe(html);
  });

  it("converts when only inline tags are present", () => {
    expect(nl2brIfPlain("Hola <b>Juan</b>\nChao")).toBe(
      "Hola <b>Juan</b><br>Chao",
    );
  });
});
