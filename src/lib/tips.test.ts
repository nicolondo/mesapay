import { describe, expect, it } from "vitest";
import {
  DEFAULT_TIP_PCT,
  MAX_TIP_PCT,
  TIP_OPTIONS,
  clampTipPct,
  hrefWithTip,
  TIP_ROUNDING_CENTS,
  parseTipPct,
  tipBaseCentsOf,
  tipBaseExcludesTax,
  tipBasePolicyFor,
  tipCentsFor,
  tipStorageKey,
  totalWithTip,
  type TipBase,
} from "./tips";

// La cuenta del ejemplo: $42.900 pendientes de comida, todo en centavos.
const BILL = 42_900_00;

// El ejemplo del dueño: $108.000 con INC 8 % embebido → base $100.000.
const INC_108K: TipBase = { chargeableCents: 10_800_000, preTaxCents: 10_000_000 };

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

describe("política de la base", () => {
  it("hoy es global: sobre el valor antes de impuestos", () => {
    expect(tipBasePolicyFor()).toBe("pre_tax");
    expect(tipBasePolicyFor({ country: "CO" })).toBe("pre_tax");
  });
});

describe("tipCentsFor — sobre el valor antes de impuestos", () => {
  it("el ejemplo del dueño: $108.000 con INC 8 % → base $100.000 → 10 % = $10.000 (antes $10.800)", () => {
    expect(tipBaseCentsOf(10_800_000, INC_108K)).toBe(10_000_000);
    expect(tipCentsFor(10_800_000, 10, INC_108K)).toBe(1_000_000);
    expect(totalWithTip(10_800_000, 10, INC_108K)).toBe(11_800_000);
    // La regla vieja (con impuesto) daba $10.800.
    expect(tipCentsFor(10_800_000, 10, null)).toBe(1_080_000);
  });

  it("IVA 19 %: $119.000 → base $100.000 → $10.000", () => {
    const iva: TipBase = { chargeableCents: 11_900_000, preTaxCents: 10_000_000 };
    expect(tipCentsFor(11_900_000, 10, iva)).toBe(1_000_000);
  });

  it("cuenta sin impuesto (o sin datos de impuesto): la base es el monto", () => {
    const none: TipBase = { chargeableCents: BILL, preTaxCents: BILL };
    expect(tipCentsFor(BILL, 10, none)).toBe(4_290_00);
    expect(tipCentsFor(BILL, 10, null)).toBe(4_290_00);
    expect(tipBaseExcludesTax(BILL, none)).toBe(false);
    expect(tipBaseExcludesTax(10_800_000, INC_108K)).toBe(true);
  });

  it("pago parcial: la base es la parte PROPORCIONAL sin impuesto de lo que se paga", () => {
    // La mitad ($54.000) → base $50.000 → $5.000.
    expect(tipBaseCentsOf(5_400_000, INC_108K)).toBe(5_000_000);
    expect(tipCentsFor(5_400_000, 10, INC_108K)).toBe(500_000);
    // Partes iguales × 3 ($36.000) → base $33.333,33 → $3.333.
    expect(tipBaseCentsOf(3_600_000, INC_108K)).toBe(3_333_333);
    expect(tipCentsFor(3_600_000, 10, INC_108K)).toBe(333_300);
  });

  it("redondea la propina al PESO entero, mitad hacia arriba", () => {
    expect(TIP_ROUNDING_CENTS).toBe(100);
    // $30.000 con INC 8 %: base $27.777,78 → 10 % = $2.777,78 → $2.778.
    const plate: TipBase = { chargeableCents: 3_000_000, preTaxCents: 2_777_778 };
    expect(tipCentsFor(3_000_000, 10, plate)).toBe(277_800);
    // $505 sin impuesto: 10 % = $50,50 → $51; $504: $50,40 → $50.
    expect(tipCentsFor(50_500, 10, null)).toBe(5_100);
    expect(tipCentsFor(50_400, 10, null)).toBe(5_000);
    for (const pct of TIP_OPTIONS) {
      expect(tipCentsFor(10_800_000, pct, INC_108K) % TIP_ROUNDING_CENTS).toBe(0);
    }
  });

  it("0 %, monto en cero o negativo ⇒ sin propina", () => {
    expect(tipCentsFor(BILL, 0, INC_108K)).toBe(0);
    expect(tipCentsFor(BILL, -5, INC_108K)).toBe(0);
    expect(tipCentsFor(0, 20, INC_108K)).toBe(0);
    expect(tipCentsFor(-100, 10, INC_108K)).toBe(0);
    expect(tipBaseCentsOf(0, INC_108K)).toBe(0);
  });

  it("la base nunca supera el monto y no pierde centavos con cuentas grandes", () => {
    const huge: TipBase = { chargeableCents: 2_000_000_000, preTaxCents: 1_851_851_852 };
    expect(tipBaseCentsOf(2_000_000_000, huge)).toBe(1_851_851_852);
    expect(tipBaseCentsOf(1_999_999_999, huge)).toBe(1_851_851_851);
    const odd: TipBase = { chargeableCents: 100, preTaxCents: 300 };
    expect(tipBaseCentsOf(100, odd)).toBe(100);
  });
});

describe("totalWithTip", () => {
  it("monto + propina", () => {
    expect(totalWithTip(BILL, 10, null)).toBe(47_190_00);
    expect(totalWithTip(BILL, 0, INC_108K)).toBe(BILL);
  });
  it("coincide con monto + tipCentsFor", () => {
    for (const pct of TIP_OPTIONS) {
      expect(totalWithTip(BILL, pct, INC_108K)).toBe(BILL + tipCentsFor(BILL, pct, INC_108K));
    }
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
