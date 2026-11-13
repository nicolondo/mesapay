import { describe, expect, it, vi } from "vitest";

// `computeOrderTotals` vive junto a funciones con DB; acá sólo se usa la pura.
vi.mock("./db", () => ({ db: {} }));

import {
  FREE_LINE_TIP_MARGIN_PCT,
  SAFE_ORDER_TOTAL_CENTS,
  freeLineChargeableRoomCents,
  freeLineFits,
  maxFreeLineCents,
  maxFreeLineDisplayCents,
  orderRoomFromLines,
  type OrderRoomInput,
} from "./freeLineLimit";
import { lineTaxOnTopCents, orderTaxTotals, type TaxedLine } from "./salesTax";
import { MAX_TIP_PCT } from "./tips";
import { computeOrderTotals } from "./orderTotals";
import { computeDiscountCents } from "./dinerDiscount";
import { saleLines } from "./dian/discountedLines";
import { amountCentsSchema, tipCentsSchema } from "./payments/validation";

/** Techo del `Int` de Postgres: lo que NINGUNA columna de plata puede pasar. */
const PG_INT_MAX = 2_147_483_647;
const pesos = (n: number) => n * 100;

const EMPTY: OrderRoomInput = { subtotalCents: 0, taxCents: 0, tipCents: 0 };
const INCLUDED = { taxKind: null, taxPct: null } as const;
const IVA19 = { taxKind: "iva", taxPct: 19 } as const;
const INC8_ON_TOP = { taxKind: "inc", taxPct: 8 } as const;

// Lo cobrable más alto que deja el techo con la propina máxima.
const MAX_CHARGEABLE = Math.floor(
  (SAFE_ORDER_TOTAL_CENTS * 100) / (100 + MAX_TIP_PCT),
);

describe("freeLineLimit — tope dinámico de un cargo o servicio", () => {
  it("el margen de propina es la propina máxima que deja elegir el cobro", () => {
    expect(FREE_LINE_TIP_MARGIN_PCT).toBe(MAX_TIP_PCT);
    // El techo es el de UN pago, por debajo del Int.
    expect(SAFE_ORDER_TOTAL_CENTS).toBeLessThan(PG_INT_MAX);
    expect(amountCentsSchema.safeParse(SAFE_ORDER_TOTAL_CENTS).success).toBe(true);
  });

  it("cuenta vacía, impuesto incluido: cabe todo el espacio libre (~$15,38 millones)", () => {
    expect(freeLineChargeableRoomCents(EMPTY)).toBe(MAX_CHARGEABLE);
    expect(maxFreeLineCents(EMPTY, INCLUDED)).toBe(MAX_CHARGEABLE);
    expect(maxFreeLineDisplayCents(MAX_CHARGEABLE)).toBe(pesos(15_384_615));
  });

  it("cuenta vacía: el cargo de $12.219.480 con impoconsumo incluido cabe (antes el tope fijo de $10M lo bloqueaba)", () => {
    const line = { amountCents: pesos(12_219_480), ...INCLUDED };
    expect(freeLineFits(EMPTY, line)).toBe(true);
    expect(line.amountCents).toBeGreaterThan(1_000_000_000);
  });

  it("cuenta vacía: un cargo de $19 millones ya no cabe (con la propina máxima pasaría el techo)", () => {
    expect(freeLineFits(EMPTY, { amountCents: pesos(19_000_000), ...INCLUDED })).toBe(false);
  });

  it("con consumos: el máximo baja exactamente lo que la cuenta ya tiene", () => {
    const withDishes = orderRoomFromLines([
      { amountCents: pesos(300_000), taxKind: null, taxPct: null },
      { amountCents: pesos(200_000), taxKind: null, taxPct: null },
    ]);
    expect(withDishes).toEqual({ subtotalCents: pesos(500_000), taxCents: 0, tipCents: 0 });
    expect(maxFreeLineCents(withDishes, INCLUDED)).toBe(MAX_CHARGEABLE - pesos(500_000));
  });

  it("los cargos con impuesto encima ya cargados también consumen el espacio (base + impuesto)", () => {
    const room = orderRoomFromLines([{ amountCents: pesos(1_000_000), ...IVA19 }]);
    expect(room).toEqual({ subtotalCents: pesos(1_000_000), taxCents: pesos(190_000), tipCents: 0 });
    expect(maxFreeLineCents(room, INCLUDED)).toBe(MAX_CHARGEABLE - pesos(1_190_000));
  });

  it("impuesto SUMADO encima: el máximo es el espacio / (1 + tarifa) y su borde es exacto al centavo", () => {
    for (const tax of [IVA19, INC8_ON_TOP, { taxKind: "iva", taxPct: 5 }] as const) {
      const max = maxFreeLineCents(EMPTY, tax);
      const room = freeLineChargeableRoomCents(EMPTY);
      expect(max + lineTaxOnTopCents({ amountCents: max, ...tax })).toBeLessThanOrEqual(room);
      expect(freeLineFits(EMPTY, { amountCents: max, ...tax })).toBe(true);
      expect(freeLineFits(EMPTY, { amountCents: max + 1, ...tax })).toBe(false);
      // Más chico que con el impuesto incluido: el impuesto también ocupa lugar.
      expect(max).toBeLessThan(maxFreeLineCents(EMPTY, INCLUDED));
    }
    // ≈ espacio / 1,19 (± 1 centavo por el redondeo del impuesto): $12.928.248.
    expect(
      Math.abs(maxFreeLineCents(EMPTY, IVA19) - Math.floor((MAX_CHARGEABLE * 100) / 119)),
    ).toBeLessThanOrEqual(1);
    expect(maxFreeLineDisplayCents(maxFreeLineCents(EMPTY, IVA19))).toBe(pesos(12_928_248));
  });

  it("incluido vs. sumado: $12.219.480 cabe incluido y también con impoconsumo 8% encima", () => {
    expect(freeLineFits(EMPTY, { amountCents: pesos(12_219_480), ...INCLUDED })).toBe(true);
    expect(freeLineFits(EMPTY, { amountCents: pesos(12_219_480), ...INC8_ON_TOP })).toBe(true);
    // Con IVA 19% encima son $14.541.181: también cabe. El borde con IVA es
    // $12.928.248 (+19% = $15.384.615).
    expect(freeLineFits(EMPTY, { amountCents: pesos(12_219_480), ...IVA19 })).toBe(true);
    expect(freeLineFits(EMPTY, { amountCents: pesos(12_928_248), ...IVA19 })).toBe(true);
    expect(freeLineFits(EMPTY, { amountCents: pesos(12_928_249), ...IVA19 })).toBe(false);
  });

  it("'ninguno' o tarifa 0 no suman nada: el máximo es el espacio entero", () => {
    expect(maxFreeLineCents(EMPTY, { taxKind: "none", taxPct: 0 })).toBe(MAX_CHARGEABLE);
    expect(maxFreeLineCents(EMPTY, { taxKind: "iva", taxPct: 0 })).toBe(MAX_CHARGEABLE);
  });

  it("con propina ya cobrada el espacio se achica", () => {
    const tipped = { ...EMPTY, tipCents: pesos(1_000_000) };
    expect(maxFreeLineCents(tipped, INCLUDED)).toBe(
      Math.floor(((SAFE_ORDER_TOTAL_CENTS - pesos(1_000_000)) * 100) / (100 + MAX_TIP_PCT)),
    );
    expect(maxFreeLineCents(tipped, INCLUDED)).toBeLessThan(MAX_CHARGEABLE);
  });

  it("el descuento del comensal NO agranda el tope (se puede quitar y el subtotal bruto también es Int)", () => {
    // `OrderRoomInput` usa el subtotal ANTES del descuento: una cuenta de
    // $5M con 50% de descuento tiene el mismo tope que una de $5M sin él.
    const room = orderRoomFromLines([{ amountCents: pesos(5_000_000), taxKind: null, taxPct: null }]);
    expect(maxFreeLineCents(room, INCLUDED)).toBe(MAX_CHARGEABLE - pesos(5_000_000));
  });

  it("cuenta llena: el máximo es 0 y nada cabe", () => {
    const full = { subtotalCents: MAX_CHARGEABLE, taxCents: 0, tipCents: 0 };
    expect(maxFreeLineCents(full, INCLUDED)).toBe(0);
    expect(freeLineFits(full, { amountCents: 1, ...INCLUDED })).toBe(false);
    const over = { subtotalCents: SAFE_ORDER_TOTAL_CENTS, taxCents: 0, tipCents: 0 };
    expect(maxFreeLineCents(over, IVA19)).toBe(0);
  });

  it("el máximo que se muestra es en pesos enteros y nunca más que el real", () => {
    expect(maxFreeLineDisplayCents(1_538_461_538)).toBe(1_538_461_500);
    expect(maxFreeLineDisplayCents(1_538_461_500)).toBe(1_538_461_500);
    expect(maxFreeLineDisplayCents(-5)).toBe(0);
  });

  it("rechaza montos que no son enteros seguros", () => {
    expect(freeLineFits(EMPTY, { amountCents: Number.NaN, ...INCLUDED })).toBe(false);
    expect(freeLineFits(EMPTY, { amountCents: -1, ...INCLUDED })).toBe(false);
  });
});

/**
 * Con el tope nuevo, ¿algún `Int` de los que tocan la línea revienta?
 * Se recorre la cuenta como la recorre la app: totales de la orden
 * (`recomputeOrderLinesInTx` / `syncOrderSubtotalFromLiveItems`), el pago
 * con la propina MÁXIMA (`Payment.amountCents/tipCents`, schema de los
 * cobros), el total con propina (`Order.totalCents`, `SimpleInvoice.
 * totalCents`), la factura electrónica (`saleLines`, de donde salen el XML y
 * el snapshot) y el descuento del comensal. Las notas crédito y la cartera
 * nunca superan lo facturado/cobrado, así que quedan acotadas por lo mismo.
 */
describe("freeLineLimit — ningún total Int se revienta con cargos de $12–19 millones", () => {
  const restaurantTax = { kind: "inc" as const, pct: 8 };

  function walkAccount(lines: TaxedLine[], discountPct = 0) {
    const t = orderTaxTotals(lines, { kind: "none", pct: 0 });
    const discountCents = computeDiscountCents(t.subtotalCents, discountPct);
    const chargeable = Math.max(0, t.subtotalCents - discountCents) + t.taxOnTopCents;
    const tipCents = Math.round((chargeable * MAX_TIP_PCT) / 100);
    const payment = { amountCents: chargeable + tipCents, tipCents };
    const recompute = computeOrderTotals(t.subtotalCents, [payment], t.taxOnTopCents, discountCents);
    const orderTotalCents = chargeable + recompute.tipsTotalCents;
    const fiscal = saleLines(
      lines.map((l) => ({
        nameSnapshot: "Evento",
        qty: 1,
        priceCentsSnapshot: l.amountCents,
        cancelledAt: null,
        taxKind: l.taxKind,
        taxPct: l.taxPct,
      })),
      restaurantTax,
      discountCents,
    );
    const ints = {
      "Order.subtotalCents": t.subtotalCents,
      "Order.taxCents": t.taxOnTopCents,
      "Order.discountCents": discountCents,
      "Order.tipCents": recompute.tipsTotalCents,
      "Order.totalCents / SimpleInvoice.totalCents": orderTotalCents,
      "Payment.amountCents": payment.amountCents,
      "Payment.tipCents": payment.tipCents,
      "OrderItem.priceCentsSnapshot": Math.max(...lines.map((l) => l.amountCents)),
      "DIAN Σ líneas + impuesto": fiscal.lines.reduce((s, l) => s + l.lineTotalCents + l.taxCents, 0),
    };
    return { ints, payment, recompute, fiscal, chargeable };
  }

  const cases: Array<[string, TaxedLine[], number]> = [
    ["$12.219.480 con impoconsumo incluido", [{ amountCents: pesos(12_219_480), taxKind: null, taxPct: null }], 0],
    ["$12.219.480 incluido + $800.000 de platos + 10% de descuento", [
      { amountCents: pesos(12_219_480), taxKind: null, taxPct: null },
      { amountCents: pesos(800_000), taxKind: null, taxPct: null },
    ], 10],
    ["$12.900.000 + IVA 19% encima", [{ amountCents: pesos(12_900_000), taxKind: "iva", taxPct: 19 }], 0],
    ["el máximo exacto de una cuenta vacía (incluido)", [{ amountCents: maxFreeLineCents(EMPTY, INCLUDED), taxKind: null, taxPct: null }], 0],
    ["el máximo exacto de una cuenta vacía (IVA 19% encima)", [{ amountCents: maxFreeLineCents(EMPTY, IVA19), taxKind: "iva", taxPct: 19 }], 0],
  ];

  it.each(cases)("%s: cabe y todo queda bajo el Int, cobrable en UN pago", (_name, lines, discountPct) => {
    // La API lo deja pasar (cada línea sobre lo que la cuenta ya tenía)…
    lines.forEach((l, i) => {
      expect(freeLineFits(orderRoomFromLines(lines.slice(0, i)), l)).toBe(true);
    });
    const { ints, payment, recompute, fiscal, chargeable } = walkAccount(lines, discountPct);
    // …y ninguna columna Int se pasa, ni siquiera con la propina máxima.
    for (const [col, v] of Object.entries(ints)) {
      expect(Number.isSafeInteger(v), col).toBe(true);
      expect(v, col).toBeLessThanOrEqual(PG_INT_MAX);
    }
    // El pago entero (comida + propina máxima) lo acepta el schema de cobro.
    expect(amountCentsSchema.safeParse(payment.amountCents).success).toBe(true);
    expect(tipCentsSchema.safeParse(payment.tipCents).success).toBe(true);
    expect(recompute.fullyPaid).toBe(true);
    // La factura cuadra con lo cobrable (descuento repartido en las líneas).
    expect(fiscal.lines.reduce((s, l) => s + l.lineTotalCents + l.taxCents, 0)).toBe(chargeable);
  });

  it("$19.000.000 incluido: el tope lo rechaza ANTES de escribir (con propina máxima habría pasado el pago máximo)", () => {
    const line = { amountCents: pesos(19_000_000), taxKind: null, taxPct: null };
    expect(freeLineFits(EMPTY, line)).toBe(false);
    const { payment } = walkAccount([line]);
    expect(amountCentsSchema.safeParse(payment.amountCents).success).toBe(false);
  });
});
