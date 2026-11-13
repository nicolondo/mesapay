// La regla de «monto distinto» del datáfono Kushki (terminalAmount.ts): qué
// se liquida solo (propina, parcial) y qué queda para conciliar.
import { describe, expect, it } from "vitest";
import {
  DEFAULT_TERMINAL_EXTRA_CAP,
  adjustedTerminalPayment,
  classifyTerminalAmount,
  pesosToCents,
  toTerminalAmountView,
} from "./terminalAmount";

describe("classifyTerminalAmount", () => {
  it("el caso real: se mandó $5.520 y se autorizó $5.525 → propina de $5", () => {
    expect(classifyTerminalAmount(552_000, 552_500)).toEqual({ kind: "tip", authorizedCents: 552_500, diffCents: 500 });
  });

  it("igual → exact", () => {
    expect(classifyTerminalAmount(552_000, 552_000)).toEqual({ kind: "exact", authorizedCents: 552_000 });
  });

  it("de más, hasta el 30 % → propina; por encima → over_cap", () => {
    expect(classifyTerminalAmount(10_000_00, 13_000_00)).toMatchObject({ kind: "tip", diffCents: 3_000_00 });
    expect(classifyTerminalAmount(10_000_00, 13_000_01)).toMatchObject({ kind: "mismatch", reason: "over_cap" });
  });

  it("de más, sobre el tope absoluto ($200.000) aunque quepa en el porcentaje → over_cap", () => {
    expect(classifyTerminalAmount(1_000_000_00, 1_200_000_00)).toMatchObject({ kind: "tip" });
    expect(classifyTerminalAmount(1_000_000_00, 1_200_000_01)).toMatchObject({ kind: "mismatch", reason: "over_cap" });
  });

  it("el tope es configurable", () => {
    const cap = { maxPercent: 10, maxCents: 500 };
    expect(classifyTerminalAmount(10_000, 10_500, cap)).toMatchObject({ kind: "tip" });
    expect(classifyTerminalAmount(10_000, 10_501, cap)).toMatchObject({ kind: "mismatch", reason: "over_cap" });
  });

  it("de menos → parcial, con lo que falta", () => {
    expect(classifyTerminalAmount(5_000_000, 3_000_000)).toEqual({ kind: "partial", authorizedCents: 3_000_000, diffCents: 2_000_000 });
  });

  it("×100 o ÷100 (pesos contra centavos) → units, nunca propina ni parcial", () => {
    expect(classifyTerminalAmount(552_000, 55_200_000)).toMatchObject({ kind: "mismatch", reason: "units" });
    expect(classifyTerminalAmount(552_000, 5_520)).toMatchObject({ kind: "mismatch", reason: "units" });
    // Cerca de ÷100 (el datáfono además sumó algo): sigue siendo unidades.
    expect(classifyTerminalAmount(552_000, 5_525)).toMatchObject({ kind: "mismatch", reason: "units" });
    expect(classifyTerminalAmount(552_000, 55_250_000)).toMatchObject({ kind: "mismatch", reason: "units" });
  });

  it("sin monto legible, cero o negativo → invalid", () => {
    expect(classifyTerminalAmount(552_000, null)).toMatchObject({ kind: "mismatch", reason: "invalid" });
    expect(classifyTerminalAmount(552_000, 0)).toMatchObject({ kind: "mismatch", reason: "invalid" });
    expect(classifyTerminalAmount(552_000, -5)).toMatchObject({ kind: "mismatch", reason: "invalid" });
  });

  it("defaults: 30 % y $200.000", () => {
    expect(DEFAULT_TERMINAL_EXTRA_CAP).toEqual({ maxPercent: 30, maxCents: 20_000_000 });
  });
});

describe("pesosToCents", () => {
  it("pesos (enteros o con dos decimales) a centavos", () => {
    expect(pesosToCents(5525)).toBe(552_500);
    expect(pesosToCents("5525")).toBe(552_500);
    expect(pesosToCents(438.9)).toBe(43_890);
  });
  it("lo que no es un monto → null", () => {
    for (const v of [0, -1, "abc", "", null, undefined, Number.NaN, 1.234, {}]) expect(pesosToCents(v)).toBeNull();
  });
});

describe("adjustedTerminalPayment", () => {
  it("de más: toda la diferencia es propina (la comida no cambia)", () => {
    expect(adjustedTerminalPayment({ amountCents: 552_000, tipCents: 0 }, 552_500)).toEqual({ amountCents: 552_500, tipCents: 500 });
    expect(adjustedTerminalPayment({ amountCents: 1_100_000, tipCents: 100_000 }, 1_150_000)).toEqual({ amountCents: 1_150_000, tipCents: 150_000 });
  });
  it("de menos: se conserva la propina elegida y falta comida", () => {
    expect(adjustedTerminalPayment({ amountCents: 1_100_000, tipCents: 100_000 }, 900_000)).toEqual({ amountCents: 900_000, tipCents: 100_000 });
    expect(adjustedTerminalPayment({ amountCents: 1_100_000, tipCents: 100_000 }, 50_000)).toEqual({ amountCents: 50_000, tipCents: 50_000 });
  });
});

describe("toTerminalAmountView", () => {
  it("sólo con un amountCheck conocido", () => {
    expect(toTerminalAmountView({ amountCents: 552_000, authorizedCents: 552_500, amountCheck: "tip" })).toEqual({ check: "tip", expectedCents: 552_000, authorizedCents: 552_500 });
    expect(toTerminalAmountView({ amountCents: 552_000, authorizedCents: null, amountCheck: "invalid" })).toEqual({ check: "invalid", expectedCents: 552_000, authorizedCents: null });
    expect(toTerminalAmountView({ amountCents: 552_000, authorizedCents: null, amountCheck: null })).toBeNull();
    expect(toTerminalAmountView({ amountCents: 552_000, authorizedCents: null, amountCheck: "tip" })).toBeNull();
    expect(toTerminalAmountView({ amountCents: 552_000, amountCheck: "otra" })).toBeNull();
    expect(toTerminalAmountView(null)).toBeNull();
  });
});

describe("toTerminalAmountView con BIGINT", () => {
  it("un ×100 de una cuenta grande (no cabe en INT4) llega como número", () => {
    expect(toTerminalAmountView({ amountCents: 50_000_000, authorizedCents: BigInt(5_000_000_000), amountCheck: "units" })).toEqual({
      check: "units",
      expectedCents: 50_000_000,
      authorizedCents: 5_000_000_000,
    });
  });
});
