import { describe, expect, it } from "vitest";
import {
  equivalentCssValues,
  isBadColorMixFallback,
  parseColor,
  staticizeColorMix,
  toHex,
} from "./legacyCss.cjs";

const tokens = new Map<string, string>([
  ["--op-text", "#1A1613"],
  ["--op-surface", "#FFFFFF"],
  ["--ok", "#2E6B4C"],
  ["--color-ok", "var(--ok)"],
]);

describe("parseColor / toHex", () => {
  it("entiende hex, rgb() con comas o espacios y oklch()", () => {
    expect(toHex(parseColor("#1A1613")!)).toBe("#1a1613");
    expect(toHex(parseColor("#f5f1ea1a")!)).toBe("#f5f1ea1a");
    expect(toHex(parseColor("rgba(26, 22, 19, 0.5)")!)).toBe("#1a161380");
    expect(toHex(parseColor("rgb(26 22 19 / 50%)")!)).toBe("#1a161380");
    // oklch del rojo-500 de Tailwind ≈ #fb2c36
    const red = parseColor("oklch(63.7% 0.237 25.331)")!;
    expect(Math.round(red[0] * 255)).toBeGreaterThan(240);
    expect(parseColor("currentColor")).toBeNull();
  });
});

describe("staticizeColorMix", () => {
  it("una opacidad sobre una variable de :root da el mismo color con alfa", () => {
    expect(staticizeColorMix("color-mix(in oklab, var(--op-text) 10%, transparent)", tokens)).toEqual({
      value: "#1a16131a",
    });
  });

  it("resuelve cadenas de variables y deja el resto del valor", () => {
    expect(staticizeColorMix("1px solid color-mix(in srgb, var(--color-ok) 30%, transparent)", tokens)).toEqual({
      value: "1px solid #2e6b4c4d",
    });
  });

  it("mezcla dos colores opacos (8% de verde sobre blanco)", () => {
    const res = staticizeColorMix("color-mix(in srgb, var(--ok) 8%, var(--op-surface))", tokens);
    expect(res.value).toBe("#eef3f1");
  });

  it("no inventa un valor para currentColor ni para variables desconocidas", () => {
    expect(staticizeColorMix("color-mix(in srgb, currentColor 10%, transparent)", tokens).value).toBeUndefined();
    expect(staticizeColorMix("color-mix(in srgb, var(--nada) 10%, transparent)", tokens).value).toBeUndefined();
  });
});

describe("isBadColorMixFallback", () => {
  it("detecta el color sólido que deja Tailwind cuando no resuelve la variable", () => {
    const modern = "color-mix(in oklab, var(--op-text) 30%, transparent)";
    expect(isBadColorMixFallback("var(--op-text)", modern)).toBe(true);
    expect(isBadColorMixFallback("#1a16134d", modern)).toBe(false);
    expect(isBadColorMixFallback("currentColor", "color-mix(in srgb, currentColor 10%, transparent)")).toBe(true);
  });
});

describe("equivalentCssValues", () => {
  it("tolera el redondeo de canal pero no un color distinto", () => {
    expect(equivalentCssValues("1px solid #2e6b4c4d", "1px solid #2E6B4C4C")).toBe(true);
    expect(equivalentCssValues("#2e6b4c", "#eef3f1")).toBe(false);
    expect(equivalentCssValues("0 0 0 1px #000", "0 0 0 2px #000")).toBe(false);
  });
});
