// Líneas LIBRES (servicios, alquileres, cargos sueltos) que suman su IVA/INC
// ENCIMA del precio: el tramo que comparten el asiento «Ventas del día», la
// tarjeta de impuestos y el documental de «Impuestos del período».
import { describe, expect, it } from "vitest";
import type { InvoiceSnapshot } from "@/lib/invoice";
import {
  type FreeLine,
  freeLineTaxSlicesFor,
  orderFreeLineTaxSlices,
  orderSalesTaxSlice,
  salesTaxByRate,
  sumSalesTaxSlices,
} from "./salesTaxSlices";

const snap = (s: Partial<InvoiceSnapshot>) => s as InvoiceSnapshot;
const INC = { kind: "inc" as const, pct: 8 };

/** Bandeja de $30.000 (carta, INC 8 % embebido) + alquiler IVA 19 % + 2 meseros INC 8 % + cargo sin impuesto. */
const ITEMS: InvoiceSnapshot["items"] = [
  { qty: 1, name: "Bandeja", priceCents: 3_000_000, menuItemId: "m1", taxKind: null, taxPct: null },
  { qty: 1, name: "Alquiler", priceCents: 10_000_000, menuItemId: null, taxKind: "iva", taxPct: 19 },
  { qty: 2, name: "Meseros", priceCents: 1_250_000, menuItemId: null, taxKind: "inc", taxPct: 8 },
  { qty: 1, name: "Cargo", priceCents: 500_000, menuItemId: null, taxKind: "none", taxPct: 0 },
];
/** Lo que congela `issueSimpleInvoice` para esa cuenta. */
const INVOICE = snap({
  items: ITEMS,
  subtotalCents: 16_000_000,
  taxCents: 2_100_000,
  taxByKind: { inc: 200_000, iva: 1_900_000 },
  salesTaxKind: "inc",
  salesTaxPct: 8,
  embeddedTaxCents: 222_222,
  embeddedBaseCents: 2_777_778,
});
/** Las mismas líneas libres, como las lee el motor de `OrderItem`. */
const FREE: FreeLine[] = [
  { amountCents: 10_000_000, taxKind: "iva", taxPct: 19 },
  { amountCents: 2_500_000, taxKind: "inc", taxPct: 8 },
  { amountCents: 500_000, taxKind: "none", taxPct: 0 },
];

describe("orderFreeLineTaxSlices", () => {
  it("facturado: un tramo por tipo y tarifa, base = precio y el impuesto encima", () => {
    expect(orderFreeLineTaxSlices({ subtotalCents: 16_000_000, invoiceSnapshot: INVOICE, freeLines: FREE })).toEqual([
      { kind: "iva", pct: 19, grossCents: 11_900_000, taxCents: 1_900_000, baseCents: 10_000_000 },
      { kind: "inc", pct: 8, grossCents: 2_700_000, taxCents: 200_000, baseCents: 2_500_000 },
    ]);
  });

  it("la factura manda: sus ítems, no las líneas vivas del pedido", () => {
    // Aunque el pedido hoy diga otra cosa, se asienta lo que viajó al XML.
    const drifted: FreeLine[] = [{ amountCents: 99_000_000, taxKind: "iva", taxPct: 19 }];
    expect(orderFreeLineTaxSlices({ subtotalCents: 16_000_000, invoiceSnapshot: INVOICE, freeLines: drifted })).toEqual(
      orderFreeLineTaxSlices({ subtotalCents: 16_000_000, invoiceSnapshot: INVOICE }),
    );
  });

  it("redondea por línea, como el XML y `Order.taxCents`", () => {
    const lines: FreeLine[] = [
      { amountCents: 333, taxKind: "iva", taxPct: 19 },
      { amountCents: 333, taxKind: "iva", taxPct: 19 },
    ];
    // 2 × round(63,27) = 126, no round(126,54) = 127.
    expect(orderFreeLineTaxSlices({ subtotalCents: 666, invoiceSnapshot: null, freeLines: lines })).toEqual([
      { kind: "iva", pct: 19, grossCents: 792, taxCents: 126, baseCents: 666 },
    ]);
  });

  it("tirilla anterior a guardar el impuesto por ítem: tarifa de las líneas del pedido, total de lo declarado", () => {
    const old = snap({
      items: [
        { qty: 1, name: "Almuerzo", priceCents: 1_080_000 },
        { qty: 1, name: "Decoración", priceCents: 2_000_000 },
      ],
      subtotalCents: 3_080_000,
      taxCents: 100_000,
      taxByKind: { inc: 0, iva: 100_000 },
    });
    const lines: FreeLine[] = [{ amountCents: 2_000_000, taxKind: "iva", taxPct: 5 }];
    expect(orderFreeLineTaxSlices({ subtotalCents: 3_080_000, invoiceSnapshot: old, freeLines: lines })).toEqual([
      { kind: "iva", pct: 5, grossCents: 2_100_000, taxCents: 100_000, baseCents: 2_000_000 },
    ]);
    // Si el pedido ya no coincide al centavo, el total declarado gana.
    const drifted: FreeLine[] = [{ amountCents: 2_000_100, taxKind: "iva", taxPct: 5 }];
    expect(orderFreeLineTaxSlices({ subtotalCents: 3_080_000, invoiceSnapshot: old, freeLines: drifted })).toEqual([
      { kind: "iva", pct: 5, grossCents: 2_100_100, taxCents: 100_000, baseCents: 2_000_100 },
    ]);
    // Sin líneas que lo expliquen: tarifa estándar del tipo, con lo declarado.
    expect(orderFreeLineTaxSlices({ subtotalCents: 3_080_000, invoiceSnapshot: old })).toEqual([
      { kind: "iva", pct: 19, grossCents: 100_000, taxCents: 100_000, baseCents: 0 },
    ]);
  });

  it("una tirilla sin impuesto encima no inventa nada; una cuenta sólo de carta tampoco", () => {
    const menuOnly = snap({ items: [ITEMS[0]!], subtotalCents: 3_000_000, taxCents: 0, taxByKind: { inc: 0, iva: 0 } });
    expect(orderFreeLineTaxSlices({ subtotalCents: 3_000_000, invoiceSnapshot: menuOnly })).toEqual([]);
    expect(orderFreeLineTaxSlices({ subtotalCents: 3_000_000, invoiceSnapshot: snap({ subtotalCents: 3_000_000 }) })).toEqual([]);
    expect(orderFreeLineTaxSlices({ subtotalCents: 3_000_000, invoiceSnapshot: null })).toEqual([]);
  });

  it("sin factura: las líneas libres del pedido", () => {
    expect(salesTaxByRate(orderFreeLineTaxSlices({ subtotalCents: 16_000_000, invoiceSnapshot: null, freeLines: FREE }))).toEqual([
      { kind: "iva", pct: 19, grossCents: 11_900_000, taxCents: 1_900_000, baseCents: 10_000_000 },
      { kind: "inc", pct: 8, grossCents: 2_700_000, taxCents: 200_000, baseCents: 2_500_000 },
    ]);
  });

  it("Σ por día == mes también con líneas libres", () => {
    const a = { subtotalCents: 16_000_000, invoiceSnapshot: INVOICE, freeLines: FREE };
    const b = { subtotalCents: 1_000_333, invoiceSnapshot: null, freeLines: [{ amountCents: 333, taxKind: "iva", taxPct: 19 }] };
    const month = freeLineTaxSlicesFor([a, b]);
    const byDays = sumSalesTaxSlices([...freeLineTaxSlicesFor([a]), ...freeLineTaxSlicesFor([b])]);
    expect(byDays).toEqual(month);
    expect(month).toEqual([
      { kind: "iva", pct: 19, grossCents: 11_900_396, taxCents: 1_900_063, baseCents: 10_000_333 },
      { kind: "inc", pct: 8, grossCents: 2_700_000, taxCents: 200_000, baseCents: 2_500_000 },
    ]);
  });
});

describe("orderSalesTaxSlice con líneas libres", () => {
  it("sin factura: el INC embebido sale sólo de lo de la carta", () => {
    // 16.000.000 − 13.000.000 de líneas libres = 3.000.000 de carta.
    expect(orderSalesTaxSlice({ subtotalCents: 16_000_000, invoiceSnapshot: null, freeLines: FREE }, INC)).toEqual({
      kind: "inc", pct: 8, grossCents: 3_000_000, taxCents: 222_222, baseCents: 2_777_778,
    });
    // Sin las líneas (llamadores viejos): todo el subtotal, como antes.
    expect(orderSalesTaxSlice({ subtotalCents: 16_000_000, invoiceSnapshot: null }, INC).taxCents).toBe(1_185_185);
  });

  it("facturado: lo embebido que congeló la factura, que ya excluye las líneas libres", () => {
    expect(orderSalesTaxSlice({ subtotalCents: 16_000_000, invoiceSnapshot: INVOICE, freeLines: FREE }, INC)).toEqual({
      kind: "inc", pct: 8, grossCents: 3_000_000, taxCents: 222_222, baseCents: 2_777_778,
    });
  });
});
