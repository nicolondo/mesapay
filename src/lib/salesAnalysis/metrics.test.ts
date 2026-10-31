import { describe, expect, it } from "vitest";
import { dashboardOrderNetSalesCents } from "@/lib/reports/dashboardSales";
import {
  allocateLines,
  deltaTone,
  deriveKpis,
  reliableDuration,
  saleFacts,
  share,
  sumSaleFacts,
  summarizeReturns,
  variation,
  type SaleLineInput,
  type SaleOrderInput,
} from "./metrics";

const INC8 = { kind: "inc" as const, pct: 8 };
const NONE = { kind: "none" as const, pct: 0 };

function line(price: number, patch: Partial<SaleLineInput> = {}): SaleLineInput {
  return { priceCentsSnapshot: price, qty: 1, taxKind: null, menuItemId: "m", live: true, comp: false, ...patch };
}

/** Cuenta coherente con `recomputeOrderTotalsInTx`: total = máx(0, sub + encima − desc) + propina. */
function order(lines: SaleLineInput[], patch: Partial<SaleOrderInput> = {}): SaleOrderInput {
  const live = lines.filter((l) => l.live);
  const subtotalCents = live.reduce((s, l) => s + l.priceCentsSnapshot * l.qty, 0);
  const taxCents = patch.taxCents ?? 0;
  const discountCents = patch.discountCents ?? 0;
  const tipCents = patch.tipCents ?? 0;
  return {
    subtotalCents, taxCents, tipCents, discountCents,
    totalCents: Math.max(0, subtotalCents + taxCents - discountCents) + tipCents,
    diners: 1, compedAt: null, compAmountCents: null, invoice: null, lines,
    ...patch,
  };
}

describe("venta neta, bruta, impuestos y propinas", () => {
  it("sin factura: quita el INC incluido con la tarifa actual y la propina", () => {
    const o = order([line(3_000_000, { qty: 2 }), line(800_000)], { tipCents: 500_000, diners: 2 });
    const f = saleFacts(o, INC8);
    // 6.000.000 → base 5.555.556 + INC 444.444; 800.000 → 740.741 + 59.259
    expect(f).toEqual({
      isSale: true,
      grossCents: 6_800_000,
      discountCents: 0,
      taxCents: 503_703,
      netCents: 6_296_297,
      tipCents: 500_000,
      compsCents: 0,
      diners: 2,
      units: 3,
    });
    expect(f.grossCents - f.discountCents - f.taxCents).toBe(f.netCents);
  });

  it("con factura: usa el impuesto CONGELADO y no vuelve a restar el descuento", () => {
    const o = order([line(3_000_000), line(1_200_000, { qty: 2 })], {
      discountCents: 500_000,
      invoice: { salesTaxKind: "inc", embeddedTaxCents: 370_370 },
    });
    const f = saleFacts(o, NONE);
    expect(f.grossCents).toBe(5_400_000);
    expect(f.discountCents).toBe(500_000);
    expect(f.taxCents).toBe(370_370);
    expect(f.netCents).toBe(5_400_000 - 500_000 - 370_370);
  });

  it("una factura vieja sin impuesto guardado vale cero, aunque hoy haya INC", () => {
    const f = saleFacts(order([line(2_500_000)], { invoice: {} }), INC8);
    expect(f.taxCents).toBe(0);
    expect(f.netCents).toBe(2_500_000);
  });

  it("línea libre: su IVA va encima, entra en bruta e impuestos y sale de la neta", () => {
    const o = order([line(10_000_000, { taxKind: "iva", menuItemId: null }), line(2_000_000)], { taxCents: 1_900_000 });
    const f = saleFacts(o, INC8);
    expect(f.grossCents).toBe(13_900_000);
    expect(f.taxCents).toBe(1_900_000 + 148_148);
    expect(f.netCents).toBe(10_000_000 + 1_851_852);
    expect(f.units).toBe(1); // las líneas libres no son productos de la carta
  });

  it("es la misma venta neta del Resumen, cuenta por cuenta", () => {
    const cases = [
      order([line(1_234_500, { qty: 3 })], { tipCents: 100_000 }),
      order([line(999_900)], { discountCents: 99_990, invoice: { salesTaxKind: "iva", embeddedTaxCents: 143_684 } }),
      order([line(500_000, { taxKind: "inc", menuItemId: null })], { taxCents: 40_000 }),
    ];
    for (const o of cases) {
      const dashboard = dashboardOrderNetSalesCents({
        totalCents: o.totalCents, tipCents: o.tipCents, taxCents: o.taxCents, invoice: o.invoice,
        menuItems: o.lines.filter((l) => l.taxKind === null && l.live),
      }, INC8);
      expect(saleFacts(o, INC8).netCents).toBe(dashboard);
    }
  });
});

describe("descuentos y cortesías", () => {
  it("el plato regalado no vende: va a cortesías a precio de lista", () => {
    const o = order([line(2_500_000), line(1_000_000, { live: false, comp: true }), line(700_000, { live: false })]);
    const f = saleFacts(o, NONE);
    expect(f.grossCents).toBe(2_500_000);
    expect(f.compsCents).toBe(1_000_000);
  });

  it("la cortesía de cuenta completa no es cuenta vendida ni comensal", () => {
    const o = order([line(1_500_000, { qty: 2, live: false, comp: true })], {
      compedAt: new Date("2026-10-14T21:00:00Z"), compAmountCents: 3_000_000, diners: 4,
    });
    const f = saleFacts(o, INC8);
    expect(f).toMatchObject({ isSale: false, netCents: 0, grossCents: 0, diners: 0, compsCents: 3_000_000 });
  });

  it("una cortesía completa vieja sin detalle usa el valor guardado", () => {
    const o = order([], { compedAt: new Date(), compAmountCents: 1_800_000 });
    expect(saleFacts(o, NONE).compsCents).toBe(1_800_000);
  });
});

describe("indicadores derivados", () => {
  const facts = [
    saleFacts(order([line(6_000_000)], { tipCents: 600_000, diners: 2 }), NONE),
    saleFacts(order([line(3_000_000), line(1_000_000)], { discountCents: 400_000, diners: 3 }), NONE),
    saleFacts(order([line(900_000, { live: false, comp: true })], { compedAt: new Date(), compAmountCents: 900_000, diners: 2 }), NONE),
  ];
  const totals = sumSaleFacts(facts);

  it("suma los hechos de las cuentas", () => {
    expect(totals).toEqual({
      orders: 2, diners: 5, units: 3, grossCents: 10_000_000, discountCents: 400_000,
      taxCents: 0, netCents: 9_600_000, tipCents: 600_000, compsCents: 900_000,
    });
  });

  it("ticket por cuenta, por comensal, productos por cuenta, descuentos + cortesías", () => {
    const k = deriveKpis(totals, null, null);
    expect(k.avgTicketCents).toBe(4_800_000);
    expect(k.avgPerDinerCents).toBe(1_920_000);
    expect(k.unitsPerOrder).toBe(1.5);
    expect(k.discountsAndCompsCents).toBe(1_300_000);
    expect(k.returnsCents).toBeNull();
  });

  it("sin cuentas los promedios quedan vacíos, no en cero", () => {
    const k = deriveKpis(sumSaleFacts([]), null, null);
    expect(k.avgTicketCents).toBeNull();
    expect(k.avgPerDinerCents).toBeNull();
    expect(k.unitsPerOrder).toBeNull();
  });

  it("la venta neta después de devoluciones resta la base de notas y reembolsos", () => {
    const k = deriveKpis(totals, {
      creditNotes: { count: 1, baseCents: 1_000_000, taxCents: 80_000, totalCents: 1_080_000 },
      refunds: { count: 1, totalCents: 540_000, unlinkedCents: 540_000 },
      baseCents: 1_500_000,
    }, null);
    expect(k.returnsCents).toBe(1_500_000);
    expect(k.netAfterReturnsCents).toBe(8_100_000);
  });

  it("la duración de mesa sólo se muestra con muestra y cobertura suficientes", () => {
    expect(reliableDuration({ medianMinutes: 75, measured: 30, eligible: 33 })).toBe(75);
    expect(reliableDuration({ medianMinutes: 75, measured: 3, eligible: 3 })).toBeNull();
    expect(reliableDuration({ medianMinutes: 75, measured: 10, eligible: 30 })).toBeNull();
    expect(reliableDuration({ medianMinutes: null, measured: 0, eligible: 0 })).toBeNull();
  });
});

describe("reparto de la cuenta entre sus líneas", () => {
  it("Σ líneas = venta neta de la cuenta, con o sin factura", () => {
    const cases: SaleOrderInput[] = [
      order([line(3_000_000), line(1_200_000, { qty: 2 })], { discountCents: 500_000, invoice: { salesTaxKind: "inc", embeddedTaxCents: 370_370 } }),
      order([line(10_000_000, { taxKind: "iva", menuItemId: null }), line(2_000_000)], { taxCents: 1_900_000, discountCents: 1_000_000 }),
      order([line(777_700, { qty: 3 }), line(100_000, { live: false, comp: true })], { tipCents: 50_000 }),
    ];
    for (const o of cases) {
      const lines = allocateLines(o, INC8);
      const sum = lines.reduce((s, l) => s + l.netCents, 0);
      expect(sum).toBeCloseTo(saleFacts(o, INC8).netCents, 6);
      expect(lines).toHaveLength(o.lines.filter((l) => l.live).length);
    }
  });

  it("el impuesto incluido sólo cae en los platos; el descuento, en proporción al valor", () => {
    const o = order([line(10_000_000, { taxKind: "iva", menuItemId: null }), line(2_000_000)], { taxCents: 1_900_000 });
    const [free, dish] = allocateLines(o, INC8);
    expect(free.taxCents).toBe(0);
    expect(dish.taxCents).toBe(148_148);
    expect(free.netCents).toBeCloseTo(10_000_000, 6);
    expect(dish.netCents).toBeCloseTo(1_851_852, 6);
  });
});

describe("notas crédito y reembolsos", () => {
  const at = (h: number) => new Date(Date.UTC(2026, 9, 15, h));
  const note = { id: "n1", orderId: "o2", at: at(3), subtotalCents: 1_000_000, taxCents: 80_000, totalCents: 1_080_000, receivableCents: 0, inRange: true };

  it("el reembolso que paga una nota no se cuenta dos veces", () => {
    const r = summarizeReturns([note], [
      { id: "r1", orderId: "o2", at: at(4), amountCents: 1_080_000, inRange: true },
      { id: "r2", orderId: "o3", at: at(1), amountCents: 540_000, inRange: true },
    ], INC8);
    expect(r.creditNotes).toEqual({ count: 1, baseCents: 1_000_000, taxCents: 80_000, totalCents: 1_080_000 });
    expect(r.refunds).toEqual({ count: 2, totalCents: 1_620_000, unlinkedCents: 540_000 });
    // reembolso sin nota sin su INC estimado: 540.000 − 40.000
    expect(r.baseCents).toBe(1_000_000 + 500_000);
  });

  it("un reembolso anterior a la nota queda cubierto por ella", () => {
    const r = summarizeReturns([note], [{ id: "r1", orderId: "o2", at: at(1), amountCents: 1_080_000, inRange: true }], NONE);
    expect(r.refunds.unlinkedCents).toBe(0);
    expect(r.baseCents).toBe(1_000_000);
  });

  it("lo que canceló cartera de crédito no se cruza con reembolsos", () => {
    const credit = { ...note, receivableCents: 1_080_000 };
    const r = summarizeReturns([credit], [{ id: "r1", orderId: "o2", at: at(4), amountCents: 200_000, inRange: true }], NONE);
    expect(r.refunds.unlinkedCents).toBe(200_000);
  });

  it("las filas fuera del rango sólo sirven para el cruce", () => {
    const r = summarizeReturns([{ ...note, inRange: false }], [{ id: "r1", orderId: "o2", at: at(4), amountCents: 1_080_000, inRange: true }], NONE);
    expect(r.creditNotes.count).toBe(0);
    expect(r.refunds.unlinkedCents).toBe(0);
  });
});

describe("variación y tono del delta", () => {
  it("relativa a la comparación; sin base no inventa", () => {
    expect(variation(120, 100)).toBeCloseTo(0.2);
    expect(variation(80, 100)).toBeCloseTo(-0.2);
    expect(variation(100, 0)).toBeNull();
    expect(variation(null, 100)).toBeNull();
    expect(variation(100, null)).toBeNull();
  });

  it("subir es bueno en ventas y malo en descuentos; neutro en impuestos", () => {
    expect(deltaTone(0.1, "up")).toBe("good");
    expect(deltaTone(-0.1, "up")).toBe("bad");
    expect(deltaTone(0.1, "down")).toBe("bad");
    expect(deltaTone(0.1, "neutral")).toBe("neutral");
    expect(deltaTone(null, "up")).toBe("neutral");
  });

  it("participación sobre el total", () => {
    expect(share(25, 100)).toBe(0.25);
    expect(share(1, 0)).toBeNull();
  });
});
