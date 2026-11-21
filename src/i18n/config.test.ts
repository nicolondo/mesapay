import { describe, expect, it } from "vitest";
import { isLocale, matchLocale } from "./config";

describe("device language", () => {
  it.each([
    ["es-CO,es;q=0.9", "es"],
    ["en-US,en;q=0.9", "en"],
    ["pt-BR,pt;q=0.9,en;q=0.8", "pt"],
    ["PT-pt", "pt"],
    [" en-GB ; q=1.000 , es;q=0.5 ", "en"],
  ])("recognizes the primary regional language %s", (header, expected) => {
    expect(matchLocale(header)).toBe(expected);
  });

  it.each([
    "fr-FR,fr;q=0.9,en;q=0.8",
    "de-DE,en-US;q=0.9,pt-BR;q=0.8",
    "zh-Hant-TW,pt;q=0.5",
    "en;q=0.5,fr-FR;q=1",
    "fr-FR,en-US",
    "*,en;q=0.9",
  ])("uses Spanish when the primary language is unavailable: %s", header => {
    expect(matchLocale(header)).toBe("es");
  });

  it.each([
    ["en;q=0.7,pt-BR;q=0.9,es;q=0.5", "pt"],
    ["pt-BR;q=0.8,en-US;q=0.8", "pt"],
    ["en-US;q=0.8,pt-BR;q=0.8", "en"],
    ["pt;q=0,fr;q=0.9,en;q=0.8", "es"],
    ["en;q=0,pt;q=0.5", "pt"],
    ["pt; Q = 0.9,en;q=0.5", "pt"],
    ["en;q=NaN,pt;q=0.7", "pt"],
    ["en;q=2,pt;q=0.7", "pt"],
    ["en;q=-1,pt;q=0.7", "pt"],
    ["en;q=0.9junk,pt;q=0.7", "pt"],
    ["en;q=0.9;q=0.5,pt;q=0.7", "pt"],
  ])("respects valid nonzero priorities: %s", (header, expected) => {
    expect(matchLocale(header)).toBe(expected);
  });

  it.each([null, undefined, "", " ", "*", "en;q=0,pt;q=0", "en;q=NaN", "en;q=2", "en;q=-1", "en;q=0.9999", "en;q=0.8junk", "en_US", "not a language", "en;other=1"])(
    "falls back safely for absent or unusable preferences: %s", header => {
      expect(matchLocale(header)).toBe("es");
    },
  );

  it("accepts only supported explicit choices", () => {
    for (const locale of ["es", "en", "pt"]) expect(isLocale(locale)).toBe(true);
    for (const locale of [null, undefined, "", "fr", "EN", "en-US", "../../en"]) expect(isLocale(locale)).toBe(false);
  });

  it("ignores a long malformed entry without hiding the valid device preference", () => {
    const malformed = "en" + " ".repeat(15_000) + "!";
    expect(matchLocale(malformed)).toBe("es");
    expect(matchLocale(`${malformed},pt-BR;q=0.9`)).toBe("pt");
  });
});
