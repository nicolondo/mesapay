import { describe, expect, it } from "vitest";
import { fmtCOP } from "./format";
import {
  asSalesTaxKind,
  checkoutTaxLine,
  payModeSubtotalCents,
  type CheckoutTax,
  type PayMode,
} from "./checkoutTax";

const INC8: CheckoutTax = { kind: "inc", pct: 8 };
const IVA19: CheckoutTax = { kind: "iva", pct: 19 };
const NONE: CheckoutTax = { kind: "none", pct: 0 };

// La cuenta del ejemplo del dueño: $42.900 de carta con impoconsumo 8% ⇒
// $3.178 de impuesto ADENTRO del precio (42.900 × 8 / 108). Todo en centavos.
const BILL = 42_900_00;
// Tres en la mesa; "lo mío" de la persona elegida son $12.500.
const SPLIT = { splitCount: 3, mineCents: 12_500_00 };

const MODES: PayMode[] = ["full", "equal", "mine"];
const lineFor = (mode: PayMode, tax: CheckoutTax) =>
  checkoutTaxLine(payModeSubtotalCents(mode, BILL, SPLIT), tax);

describe("payModeSubtotalCents", () => {
  it("Todo: lo que falta de la cuenta", () => {
    expect(payModeSubtotalCents("full", BILL, SPLIT)).toBe(BILL);
  });
  it("Partes iguales: lo que falta entre N", () => {
    expect(payModeSubtotalCents("equal", BILL, SPLIT)).toBe(14_300_00);
  });
  it("Partes iguales: nunca entre menos de 2", () => {
    expect(
      payModeSubtotalCents("equal", BILL, { ...SPLIT, splitCount: 1 }),
    ).toBe(21_450_00);
  });
  it("Lo mío: los platos de la persona", () => {
    expect(payModeSubtotalCents("mine", BILL, SPLIT)).toBe(12_500_00);
  });
  it("Lo mío: topado por lo que falta si ya pagó parte", () => {
    expect(payModeSubtotalCents("mine", 10_000_00, SPLIT)).toBe(10_000_00);
  });
  it("Lo mío sin persona elegida: cero", () => {
    expect(payModeSubtotalCents("mine", BILL, { ...SPLIT, mineCents: 0 })).toBe(0);
  });
  it("reparte lo que FALTA, no la cuenta original", () => {
    // Cuenta ya cubierta: partes iguales × 2 no puede querer cobrar nada —
    // el bug histórico de "debía $71k y quería cobrar $214k".
    expect(payModeSubtotalCents("equal", 0, { splitCount: 2, mineCents: 0 })).toBe(0);
  });
});

describe("checkoutTaxLine por modo de pago", () => {
  it("Todo con impoconsumo 8%: $3.178 dentro de $42.900", () => {
    const line = lineFor("full", INC8);
    expect(line).toEqual({
      kind: "inc",
      pct: 8,
      taxCents: 3_177_78,
      baseCents: 39_722_22,
    });
    expect(fmtCOP(line!.taxCents)).toBe("$3.178");
  });
  it("Partes iguales: el impuesto va sobre la parte, no sobre la cuenta", () => {
    expect(lineFor("equal", INC8)).toEqual({
      kind: "inc",
      pct: 8,
      taxCents: 1_059_26,
      baseCents: 13_240_74,
    });
  });
  it("Lo mío: sobre los platos de la persona", () => {
    expect(lineFor("mine", INC8)).toEqual({
      kind: "inc",
      pct: 8,
      taxCents: 925_93,
      baseCents: 11_574_07,
    });
  });
  it("IVA 19%: misma cuenta, otro nombre y otra tarifa", () => {
    expect(lineFor("full", IVA19)).toEqual({
      kind: "iva",
      pct: 19,
      taxCents: 6_849_58,
      baseCents: 36_050_42,
    });
  });
  it("sin impuesto configurado no hay renglón, en ningún modo", () => {
    for (const mode of MODES) expect(lineFor(mode, NONE)).toBeNull();
  });
  it("tarifa en cero o monto en cero: tampoco", () => {
    expect(checkoutTaxLine(BILL, { kind: "inc", pct: 0 })).toBeNull();
    expect(checkoutTaxLine(0, INC8)).toBeNull();
    expect(
      checkoutTaxLine(payModeSubtotalCents("mine", BILL, { ...SPLIT, mineCents: 0 }), INC8),
    ).toBeNull();
    expect(checkoutTaxLine(BILL, null)).toBeNull();
  });
  it("es informativo: base + impuesto = el monto que ya se cobraba", () => {
    for (const mode of MODES) {
      const amount = payModeSubtotalCents(mode, BILL, SPLIT);
      const line = lineFor(mode, INC8)!;
      expect(line.baseCents + line.taxCents).toBe(amount);
    }
  });
});

describe("asSalesTaxKind", () => {
  it("acepta inc e iva", () => {
    expect(asSalesTaxKind("inc")).toBe("inc");
    expect(asSalesTaxKind("iva")).toBe("iva");
  });
  it("cualquier otra cosa es sin impuesto — nunca se inventa uno", () => {
    expect(asSalesTaxKind("none")).toBe("none");
    expect(asSalesTaxKind("")).toBe("none");
    expect(asSalesTaxKind("INC")).toBe("none");
    expect(asSalesTaxKind(null)).toBe("none");
    expect(asSalesTaxKind(undefined)).toBe("none");
  });
});
