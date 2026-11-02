// Tramos de impuesto de ventas por pedido — el núcleo que comparten la
// tarjeta de impuestos (mes entero) y el asiento «Ventas del día» (los
// mismos pedidos agrupados por día): la suma por día tiene que dar el mes.
import { describe, expect, it } from "vitest";
import type { InvoiceSnapshot } from "@/lib/invoice";
import {
  currentSalesTaxOf,
  orderSalesTaxSlice,
  salesTaxByRate,
  salesTaxLabel,
  salesTaxSlicesFor,
  sumSalesTaxSlices,
} from "./salesTaxSlices";

const snap = (s: Partial<InvoiceSnapshot>) => s as InvoiceSnapshot;
/** Bandeja de $30.000 con INC 8% congelado (mismo reparto que el XML). */
const INC_8 = snap({ subtotalCents: 3_000_000, salesTaxKind: "inc", salesTaxPct: 8, embeddedTaxCents: 222_222, embeddedBaseCents: 2_777_778 });
/** $10.000 con IVA 19% congelado. */
const IVA_19 = snap({ subtotalCents: 1_000_000, salesTaxKind: "iva", salesTaxPct: 19, embeddedTaxCents: 159_664, embeddedBaseCents: 840_336 });
/** Emitida antes de que se congelara la tarifa: no tiene los campos. */
const OLD = snap({ subtotalCents: 500_000 });
/** Emitida con el comercio en "none", a propósito. */
const NONE = snap({ subtotalCents: 700_000, salesTaxKind: "none", salesTaxPct: 0, embeddedTaxCents: 0, embeddedBaseCents: 700_000 });

const INC = { kind: "inc" as const, pct: 8 };

describe("orderSalesTaxSlice", () => {
  it("un pedido facturado usa lo que congeló su factura, no la tarifa actual", () => {
    expect(orderSalesTaxSlice({ subtotalCents: 3_000_000, invoiceSnapshot: INC_8 }, { kind: "none", pct: 0 })).toEqual({
      kind: "inc", pct: 8, grossCents: 3_000_000, taxCents: 222_222, baseCents: 2_777_778,
    });
    expect(orderSalesTaxSlice({ subtotalCents: 700_000, invoiceSnapshot: NONE }, INC)).toMatchObject({ kind: "none", taxCents: 0 });
    // Snapshot viejo: tramo none por el subtotal entero.
    expect(orderSalesTaxSlice({ subtotalCents: 500_000, invoiceSnapshot: OLD }, INC)).toEqual({
      kind: "none", pct: 0, grossCents: 500_000, taxCents: 0, baseCents: 500_000,
    });
  });

  it("un pedido sin factura lleva la tarifa actual, redondeada por pedido", () => {
    expect(orderSalesTaxSlice({ subtotalCents: 250_000, invoiceSnapshot: null }, INC)).toEqual({
      kind: "inc", pct: 8, grossCents: 250_000, taxCents: 18_519, baseCents: 231_481,
    });
    expect(orderSalesTaxSlice({ subtotalCents: 250_000, invoiceSnapshot: null }, { kind: "none", pct: 0 })).toMatchObject({ kind: "none", taxCents: 0 });
  });
});

describe("salesTaxSlicesFor / salesTaxByRate / salesTaxLabel", () => {
  it("suma por tarifa y expone sólo los tramos que causaron impuesto, el mayor primero", () => {
    const orders = [
      { subtotalCents: 3_000_000, invoiceSnapshot: INC_8 },
      { subtotalCents: 1_000_000, invoiceSnapshot: IVA_19 },
      { subtotalCents: 500_000, invoiceSnapshot: OLD },
      { subtotalCents: 700_000, invoiceSnapshot: NONE },
      { subtotalCents: 250_000, invoiceSnapshot: null },
    ];
    const byRate = salesTaxByRate(salesTaxSlicesFor(orders, INC));
    expect(byRate).toEqual([
      { kind: "inc", pct: 8, grossCents: 3_250_000, taxCents: 240_741, baseCents: 3_009_259 },
      { kind: "iva", pct: 19, grossCents: 1_000_000, taxCents: 159_664, baseCents: 840_336 },
    ]);
    expect(salesTaxLabel(byRate, { kind: "none", pct: 0 })).toEqual({ kind: "inc", pct: 8 });
    // Sin impuesto causado, la etiqueta es la configuración actual.
    expect(salesTaxLabel([], INC)).toEqual(INC);
  });

  it("Σ por día == mes: agrupar los pedidos de cualquier forma da los mismos tramos", () => {
    const day1 = [
      { subtotalCents: 3_000_000, invoiceSnapshot: INC_8 },
      { subtotalCents: 123_457, invoiceSnapshot: null },
    ];
    const day2 = [
      { subtotalCents: 1_000_000, invoiceSnapshot: IVA_19 },
      { subtotalCents: 98_765, invoiceSnapshot: null },
      { subtotalCents: 11_111, invoiceSnapshot: null },
    ];
    const month = salesTaxByRate(salesTaxSlicesFor([...day1, ...day2], INC));
    const byDays = salesTaxByRate(
      sumSalesTaxSlices([...salesTaxSlicesFor(day1, INC), ...salesTaxSlicesFor(day2, INC)]),
    );
    expect(byDays).toEqual(month);
  });
});

describe("currentSalesTaxOf", () => {
  it("normaliza la configuración del comercio", () => {
    expect(currentSalesTaxOf({ salesTaxKind: "inc", salesTaxPct: 8 })).toEqual({ kind: "inc", pct: 8 });
    expect(currentSalesTaxOf({ salesTaxKind: "none", salesTaxPct: 8 })).toEqual({ kind: "none", pct: 0 });
    expect(currentSalesTaxOf(null)).toEqual({ kind: "none", pct: 0 });
  });
});
