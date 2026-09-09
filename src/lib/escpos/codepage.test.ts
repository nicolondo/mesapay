import { describe, expect, it } from "vitest";
import { CP850_HIGH, encodeCp850, toCp850Text } from "./codepage";

describe("tabla CP850", () => {
  it("tiene exactamente los 128 caracteres de 0x80 a 0xFF", () => {
    expect(CP850_HIGH.length).toBe(128);
    // Sin repetidos: un carácter duplicado significaría que la tabla
    // está corrida y media comanda saldría mal.
    expect(new Set(CP850_HIGH).size).toBe(128);
  });

  it("0xFF es NBSP y 0xF0 es el guion suave (los invisibles en su sitio)", () => {
    expect(CP850_HIGH.codePointAt(127)).toBe(0x00a0);
    expect(CP850_HIGH.codePointAt(0)).toBe(0x00c7); // Ç en 0x80
  });
});

describe("encodeCp850 — español de cocina", () => {
  it("ñ y tildes salen como un byte CP850, no como UTF-8", () => {
    // Si esto se rompe, la cocina lee "champiÃ±Ã³n".
    expect(encodeCp850("ñ").toString("hex")).toBe("a4");
    expect(encodeCp850("Ñ").toString("hex")).toBe("a5");
    expect(encodeCp850("á").toString("hex")).toBe("a0");
    expect(encodeCp850("é").toString("hex")).toBe("82");
    expect(encodeCp850("í").toString("hex")).toBe("a1");
    expect(encodeCp850("ó").toString("hex")).toBe("a2");
    expect(encodeCp850("ú").toString("hex")).toBe("a3");
    expect(encodeCp850("ü").toString("hex")).toBe("81");
    expect(encodeCp850("¿").toString("hex")).toBe("a8");
    expect(encodeCp850("¡").toString("hex")).toBe("ad");
  });

  it("Ñoquis con champiñón sale entero y con la longitud exacta", () => {
    const src = "Ñoquis con champiñón";
    const bytes = encodeCp850(src);
    // Un byte por carácter: si fuera UTF-8 serían 22 bytes para 20 chars.
    expect(bytes.length).toBe(src.length);
    expect(bytes.toString("hex")).toMatchSnapshot();
  });

  it("el portugués también entra (ã õ ç) — la app es trilingüe", () => {
    expect(encodeCp850("ã").toString("hex")).toBe("c6");
    expect(encodeCp850("õ").toString("hex")).toBe("e4");
    expect(encodeCp850("ç").toString("hex")).toBe("87");
    expect(encodeCp850("Pão de queijo").length).toBe(13);
  });

  it("compone la ñ escrita como n + tilde combinante (pegado desde iOS)", () => {
    const descompuesto = "n\u0303oquis"; // NFD: n + U+0303
    expect(toCp850Text(descompuesto)).toBe("ñoquis");
    expect(encodeCp850(descompuesto).toString("hex")).toBe(
      encodeCp850("ñoquis").toString("hex"),
    );
  });

  it("un espacio normal NO se codifica como el NBSP de 0xFF", () => {
    expect(encodeCp850(" ").toString("hex")).toBe("20");
    expect(encodeCp850("\u00A0").toString("hex")).toBe("20");
  });
});

describe("toCp850Text — lo que no existe en CP850", () => {
  it("translitera tipografía de Word/celular", () => {
    expect(toCp850Text("“hola” — ok…")).toBe('"hola" - ok...');
    expect(toCp850Text("it’s")).toBe("it's");
    expect(toCp850Text("50 €")).toBe("50 EUR");
  });

  it("descarta emoji en vez de ensuciar la comanda con interrogantes", () => {
    expect(toCp850Text("sin cebolla 🙏")).toBe("sin cebolla ");
    expect(toCp850Text("🔥🔥 urgente")).toBe(" urgente");
  });

  it("le quita el acento a lo que no tiene lugar en la tabla", () => {
    // ẞ / ő / ū no están en CP850: se cae a la letra base.
    expect(toCp850Text("ő")).toBe("o");
    expect(toCp850Text("ū")).toBe("u");
  });

  it("lo verdaderamente irrepresentable cae a ?", () => {
    expect(toCp850Text("Привет")).toBe("??????");
  });

  it("conserva los saltos de línea y mata los caracteres de control", () => {
    expect(toCp850Text("a\nb")).toBe("a\nb");
    expect(toCp850Text("a\u0007b")).toBe("ab");
  });
});
