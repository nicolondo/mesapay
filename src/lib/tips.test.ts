import { describe, expect, it } from "vitest";
import {
  DEFAULT_TIP_PCT,
  MAX_TIP_PCT,
  TIP_OPTIONS,
  clampTipPct,
  hrefWithTip,
  parseTipPct,
  tipCentsFor,
  tipStorageKey,
  totalWithTip,
} from "./tips";

// La cuenta del ejemplo: $42.900 pendientes de comida, todo en centavos.
const BILL = 42_900_00;

describe("constantes", () => {
  it("el 10 % sugerido está entre los chips", () => {
    expect(TIP_OPTIONS).toContain(DEFAULT_TIP_PCT);
    expect(DEFAULT_TIP_PCT).toBe(10);
  });
  it("los chips van de menor a mayor y caben en el slider", () => {
    const sorted = [...TIP_OPTIONS].sort((a, b) => a - b);
    expect([...TIP_OPTIONS]).toEqual(sorted);
    expect(Math.max(...TIP_OPTIONS)).toBeLessThanOrEqual(MAX_TIP_PCT);
  });
});

describe("tipCentsFor", () => {
  it("10 % de la cuenta", () => {
    expect(tipCentsFor(BILL, 10)).toBe(4_290_00);
  });
  it("0 % ⇒ sin propina", () => {
    expect(tipCentsFor(BILL, 0)).toBe(0);
  });
  it("redondea con Math.round (media unidad para arriba), igual que el cobro", () => {
    // 1.005 × 5 / 100 = 50,25 → 50 ; 1.010 × 5 / 100 = 50,5 → 51
    expect(tipCentsFor(1_005, 5)).toBe(50);
    expect(tipCentsFor(1_010, 5)).toBe(51);
    // Debe coincidir centavo a centavo con la fórmula que usa PayClient.
    for (const pct of TIP_OPTIONS) {
      expect(tipCentsFor(BILL, pct)).toBe(Math.round((BILL * pct) / 100));
    }
  });
  it("base en cero ⇒ propina en cero", () => {
    expect(tipCentsFor(0, 20)).toBe(0);
  });
});

describe("totalWithTip", () => {
  it("base + propina", () => {
    expect(totalWithTip(BILL, 10)).toBe(47_190_00);
    expect(totalWithTip(BILL, 0)).toBe(BILL);
  });
  it("con 15 % coincide con base + tipCentsFor", () => {
    expect(totalWithTip(BILL, 15)).toBe(BILL + tipCentsFor(BILL, 15));
  });
});

describe("clampTipPct", () => {
  it("deja pasar un entero dentro del rango", () => {
    expect(clampTipPct(12)).toBe(12);
    expect(clampTipPct(0)).toBe(0);
    expect(clampTipPct(MAX_TIP_PCT)).toBe(MAX_TIP_PCT);
  });
  it("topa por arriba y por abajo", () => {
    expect(clampTipPct(300)).toBe(MAX_TIP_PCT);
    expect(clampTipPct(-5)).toBe(0);
  });
  it("redondea decimales a entero", () => {
    expect(clampTipPct(12.4)).toBe(12);
    expect(clampTipPct(12.6)).toBe(13);
  });
  it("NaN / Infinity caen a 0, nunca al tope", () => {
    expect(clampTipPct(NaN)).toBe(0);
    expect(clampTipPct(Infinity)).toBe(0);
  });
});

describe("parseTipPct", () => {
  it("acepta números y strings numéricos (query / sessionStorage)", () => {
    expect(parseTipPct(15)).toBe(15);
    expect(parseTipPct("15")).toBe(15);
    expect(parseTipPct(" 7 ")).toBe(7);
    expect(parseTipPct("0")).toBe(0);
  });
  it("acota lo que viene fuera de rango", () => {
    expect(parseTipPct("99")).toBe(MAX_TIP_PCT);
    expect(parseTipPct("-3")).toBe(0);
  });
  it("null para basura, vacío o ausente — el default lo pone el caller", () => {
    expect(parseTipPct(undefined)).toBeNull();
    expect(parseTipPct(null)).toBeNull();
    expect(parseTipPct("")).toBeNull();
    expect(parseTipPct("diez")).toBeNull();
    expect(parseTipPct("NaN")).toBeNull();
  });
});

describe("tipStorageKey", () => {
  it("es por cuenta, con prefijo de la app", () => {
    expect(tipStorageKey("abc")).toBe("mesapay.tip.abc");
    expect(tipStorageKey("abc")).not.toBe(tipStorageKey("xyz"));
  });
});

describe("hrefWithTip", () => {
  it("agrega ?tip= a un href limpio", () => {
    expect(hrefWithTip("/t/son/pay/o1", 10)).toBe("/t/son/pay/o1?tip=10");
  });
  it("encadena con & si ya hay query string", () => {
    expect(hrefWithTip("/t/son/pay/o1?op=1", 5)).toBe("/t/son/pay/o1?op=1&tip=5");
  });
  it("conserva el hash al final", () => {
    expect(hrefWithTip("/t/son/pay/o1#metodos", 0)).toBe(
      "/t/son/pay/o1?tip=0#metodos",
    );
  });
  it("acota el porcentaje antes de escribirlo", () => {
    expect(hrefWithTip("/x", 500)).toBe(`/x?tip=${MAX_TIP_PCT}`);
  });
});
