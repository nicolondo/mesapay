import { describe, expect, it } from "vitest";
import { fuzzyNormalize, matchesQuery, searchTokens } from "./menuSearch";

/** Azúcar: buscar `query` dentro de `text`, como lo hace la carta. */
const finds = (text: string, query: string) =>
  matchesQuery(text, searchTokens(query));

describe("palabras sueltas (el caso que motivó el cambio)", () => {
  it("'solomito res' encuentra 'Solomito de res'", () => {
    expect(finds("Solomito de res", "solomito res")).toBe(true);
  });

  it("no importa el orden: 'res solomito' también", () => {
    expect(finds("Solomito de res", "res solomito")).toBe(true);
  });

  it("basta con parte de cada palabra", () => {
    expect(finds("Solomito de res a la parrilla", "solo parri")).toBe(true);
  });

  it("si falta una palabra, no matchea", () => {
    expect(finds("Solomito de res", "solomito cerdo")).toBe(false);
  });

  it("las palabras pueden venir del nombre Y de la descripción", () => {
    expect(finds("Solomito de res — madurado 21 días", "solomito madurado")).toBe(
      true,
    );
  });
});

describe("no se pierde lo que ya funcionaba", () => {
  it("una sola palabra sigue matcheando por subcadena", () => {
    expect(finds("Hamburguesa doble", "burguesa")).toBe(true);
  });

  it("la frase entera y contigua sigue matcheando", () => {
    expect(finds("Solomito de res", "solomito de res")).toBe(true);
  });

  it("consulta vacía no filtra nada", () => {
    expect(finds("lo que sea", "")).toBe(true);
    expect(finds("lo que sea", "   ")).toBe(true);
  });
});

describe("normalización tolerante", () => {
  it("ignora acentos y ñ", () => {
    expect(finds("Limón", "limon")).toBe(true);
    expect(finds("Piña colada", "pina")).toBe(true);
  });

  it("ignora puntuación", () => {
    expect(finds("Sangría, espumosa", "sangria espumosa")).toBe(true);
  });

  it("perdona confusiones ortográficas del español", () => {
    expect(finds("Pescado al ajillo", "pezcado")).toBe(true);
    expect(finds("Vaca vieja", "baka")).toBe(true);
    expect(finds("Huevos pericos", "uevos")).toBe(true);
    expect(finds("Quesillo", "kesillo")).toBe(true);
  });

  it("es simétrica: la misma transformación sobre los dos lados", () => {
    expect(fuzzyNormalize("Vaca")).toBe(fuzzyNormalize("baka"));
  });
});

describe("searchTokens", () => {
  it("parte en palabras y normaliza", () => {
    expect(searchTokens("  Solomito   de RES ")).toEqual([
      "solomito",
      "de",
      "res",
    ]);
  });

  it("una consulta sin letras ni números no deja palabras", () => {
    expect(searchTokens("!!! ---")).toEqual([]);
  });
});
