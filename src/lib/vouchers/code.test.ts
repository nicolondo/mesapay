import { describe, expect, it } from "vitest";
import {
  VOUCHER_ALPHABET,
  formatVoucherCode,
  generateVoucherCode,
  looksLikeVoucherCode,
  normalizeVoucherCode,
  voucherPrefix,
} from "./code";

describe("voucherPrefix", () => {
  it("toma las iniciales de las palabras con significado", () => {
    expect(voucherPrefix("Son y Melona")).toBe("SM");
    expect(voucherPrefix("La Casa del Mar")).toBe("CM");
    expect(voucherPrefix("Café de la Plaza Mayor")).toBe("CPM");
  });
  it("con una sola palabra usa sus dos primeras letras, sin acentos", () => {
    expect(voucherPrefix("Andrés")).toBe("AN");
    expect(voucherPrefix("Ñoquis")).toBe("NO");
  });
  it("recorta a tres letras y cae a MP sin letras utilizables", () => {
    expect(voucherPrefix("Uno Tres Cuatro Cinco")).toBe("UTC");
    expect(voucherPrefix("")).toBe("MP");
    expect(voucherPrefix("¡!")).toBe("MP");
  });
});

describe("generateVoucherCode", () => {
  it("el alfabeto no tiene 0/O ni 1/I", () => {
    expect(VOUCHER_ALPHABET).not.toMatch(/[0O1I]/);
    expect(VOUCHER_ALPHABET).toHaveLength(32);
  });
  it("es determinista con los bytes inyectados y se guarda compacto", () => {
    const bytes = new Uint8Array([0, 1, 2, 3, 31, 32, 255, 100]);
    const code = generateVoucherCode("SM", () => bytes);
    // 32 % 32 = 0 → 'A'; 255 % 32 = 31 → '9'; 100 % 32 = 4 → 'E'
    expect(code).toBe("SMABCD9A9E");
    expect(formatVoucherCode(code)).toBe("SM-ABCD-9A9E");
  });
  it("con bytes reales produce códigos del formato PREFIJO + 8 símbolos válidos", () => {
    for (let i = 0; i < 200; i++) {
      const code = generateVoucherCode("CPM");
      expect(code).toMatch(/^CPM[A-HJ-NP-Z2-9]{8}$/);
      expect(looksLikeVoucherCode(code)).toBe(true);
    }
  });
  it("dos códigos seguidos no se repiten", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 500; i++) seen.add(generateVoucherCode("SM"));
    expect(seen.size).toBe(500);
  });
});

describe("normalizeVoucherCode / formatVoucherCode", () => {
  it("acepta lo que tipea la gente: minúsculas, guiones, espacios, acentos", () => {
    expect(normalizeVoucherCode(" sm-7k3q 9x2a ")).toBe("SM7K3Q9X2A");
    expect(normalizeVoucherCode("SM–7K3Q–9X2A")).toBe("SM7K3Q9X2A");
  });
  it("formatear y normalizar son inversas", () => {
    const code = generateVoucherCode("LCM");
    expect(normalizeVoucherCode(formatVoucherCode(code))).toBe(code);
  });
  it("looksLikeVoucherCode rechaza basura sin ir a la base", () => {
    expect(looksLikeVoucherCode("")).toBe(false);
    expect(looksLikeVoucherCode("SM")).toBe(false);
    expect(looksLikeVoucherCode("SM7K3Q9X2O")).toBe(false); // O no existe
    expect(looksLikeVoucherCode("SM7K3Q9X2A")).toBe(true);
  });
});
