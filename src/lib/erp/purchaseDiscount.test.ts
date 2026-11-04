import { describe, expect, it } from "vitest";
import {
  discountAmountCents,
  discountsReproduceNet,
  parseDiscountInput,
  prorateDiscount,
  resolveOrderDiscounts,
  toPersistedDiscount,
} from "./purchaseDiscount";

describe("discountAmountCents", () => {
  it("aplica porcentaje", () => {
    expect(discountAmountCents(100_000, { pct: 10 })).toBe(10_000);
  });
  it("aplica valor fijo", () => {
    expect(discountAmountCents(100_000, { cents: 2_500 })).toBe(2_500);
  });
  it("el porcentaje manda sobre el valor fijo", () => {
    expect(discountAmountCents(100_000, { pct: 10, cents: 99_999 })).toBe(10_000);
  });
  it("nunca deja la línea bajo cero", () => {
    expect(discountAmountCents(1_000, { cents: 5_000 })).toBe(1_000);
    expect(discountAmountCents(1_000, { pct: 500 })).toBe(1_000);
  });
  it("sin descuento es cero", () => {
    expect(discountAmountCents(100_000, {})).toBe(0);
    expect(discountAmountCents(0, { pct: 10 })).toBe(0);
  });
});

describe("prorateDiscount", () => {
  it("reparte proporcional", () => {
    expect(prorateDiscount(300, [1000, 2000])).toEqual([100, 200]);
  });

  it("el reparto SIEMPRE suma el descuento pedido", () => {
    // 100 entre tres bases iguales no divide exacto: 33,33 c/u.
    const parts = prorateDiscount(100, [1000, 1000, 1000]);
    expect(parts.reduce((s, x) => s + x, 0)).toBe(100);
    expect(parts).toEqual([34, 33, 33]);
  });

  it("aguanta bases dispares sin perder centavos", () => {
    const bases = [7, 11, 13, 17, 19, 23];
    for (const total of [1, 7, 13, 99, 1234]) {
      const parts = prorateDiscount(total, bases);
      expect(parts.reduce((s, x) => s + x, 0)).toBe(
        Math.min(total, bases.reduce((s, x) => s + x, 0)),
      );
    }
  });

  it("no reparte más que la base total", () => {
    expect(prorateDiscount(10_000, [100, 200])).toEqual([100, 200]);
  });

  it("casos vacíos", () => {
    expect(prorateDiscount(100, [])).toEqual([]);
    expect(prorateDiscount(0, [100, 200])).toEqual([0, 0]);
    expect(prorateDiscount(100, [0, 0])).toEqual([0, 0]);
  });
});

describe("resolveOrderDiscounts", () => {
  it("descuento de línea y después el global sobre lo ya descontado", () => {
    const r = resolveOrderDiscounts(
      [
        { listCents: 100_000, discount: { pct: 10 } }, // → 90.000
        { listCents: 100_000, discount: {} }, // → 100.000
      ],
      { pct: 5 }, // 5% de 190.000 = 9.500
    );
    expect(r.subtotalCents).toBe(200_000);
    expect(r.lines[0]!.lineDiscountCents).toBe(10_000);
    expect(r.lines[0]!.orderDiscountCents + r.lines[1]!.orderDiscountCents).toBe(9_500);
    expect(r.netCents).toBe(200_000 - 10_000 - 9_500);
  });

  it("el neto de las líneas suma siempre el total", () => {
    const r = resolveOrderDiscounts(
      [
        { listCents: 33_333, discount: { cents: 1 } },
        { listCents: 66_667, discount: { pct: 7 } },
        { listCents: 1, discount: {} },
      ],
      { cents: 777 },
    );
    const sum = r.lines.reduce((s, l) => s + l.netCents, 0);
    expect(sum).toBe(r.netCents);
    expect(r.subtotalCents - r.discountCents).toBe(sum);
  });

  it("sin descuentos no cambia nada", () => {
    const r = resolveOrderDiscounts(
      [{ listCents: 5_000, discount: {} }, { listCents: 7_000, discount: {} }],
      {},
    );
    expect(r.discountCents).toBe(0);
    expect(r.lines.map((l) => l.netCents)).toEqual([5_000, 7_000]);
  });
});

describe("parseDiscountInput", () => {
  it.each([
    ["10", true, { pct: 10, cents: null }],
    ["12,5", true, { pct: 12.5, cents: null }],
    ["12.5", true, { pct: 12.5, cents: null }],
    ["250", true, { pct: 100, cents: null }],
    ["2500", false, { pct: null, cents: 250_000 }],
    ["2500,55", false, { pct: null, cents: 250_055 }],
    [",5", true, { pct: 0.5, cents: null }],
  ])("lee %s (pct=%s)", (raw, isPct, expected) => {
    expect(parseDiscountInput(raw, isPct)).toEqual(expected);
  });
  it.each(["", "0", "0,0", "abc", "-5", "1.2.3", " "])("ignora %j", (raw) => {
    expect(parseDiscountInput(raw, true)).toEqual({ pct: null, cents: null });
  });
});

describe("toPersistedDiscount", () => {
  it("guarda el % entero tal cual", () => {
    expect(toPersistedDiscount(100_000, { pct: 10 })).toEqual({ pct: 10, cents: null });
  });
  it("un % con decimales viaja como su valor (la columna es entera)", () => {
    expect(toPersistedDiscount(99_999, { pct: 12.5 })).toEqual({ pct: null, cents: 12_500 });
    // Y el servidor llega al mismo neto que la pantalla.
    const screen = 99_999 - discountAmountCents(99_999, { pct: 12.5 });
    const server = resolveOrderDiscounts([{ listCents: 99_999, discount: toPersistedDiscount(99_999, { pct: 12.5 }) }], {});
    expect(server.lines[0]!.netCents).toBe(screen);
  });
  it("valor fijo y vacío", () => {
    expect(toPersistedDiscount(100_000, { cents: 2_500 })).toEqual({ pct: null, cents: 2_500 });
    expect(toPersistedDiscount(100_000, {})).toEqual({ pct: null, cents: null });
  });
});

describe("discountsReproduceNet", () => {
  it("acepta lista + descuentos que llevan exactamente al neto revisado", () => {
    expect(discountsReproduceNet([
      { netCents: 85_500, listCents: 100_000, discount: { pct: 10 } },
      { netCents: 47_500, listCents: 50_000, discount: {} },
    ], { pct: 5 })).toBe(true);
  });
  it("rechaza un neto que ya traía el descuento (se descontaría dos veces)", () => {
    expect(discountsReproduceNet([{ netCents: 90_000, listCents: 90_000, discount: { pct: 10 } }], {})).toBe(false);
    expect(discountsReproduceNet([{ netCents: 90_000, listCents: 100_000, discount: { pct: 10 } }], { cents: 1 })).toBe(false);
  });
  it("sin descuentos, la lista es el neto", () => {
    expect(discountsReproduceNet([{ netCents: 12_345, listCents: 12_345, discount: {} }], {})).toBe(true);
    expect(discountsReproduceNet([{ netCents: 12_345, listCents: 12_346, discount: {} }], {})).toBe(false);
  });
});
