// Lo que los reportes leen del snapshot de una factura con descuento del
// cliente: las facturas NUEVAS congelan base e impuesto netos (lo que
// declaró el XML) y los reportes los usan tal cual; las VIEJAS (sin la
// marca `discountInLines`) siguen diciendo lo que declararon y
// `undeclaredDiscountOf` calcula cuánto fue de más, para la revisión.
import { describe, expect, it } from "vitest";
import type { InvoiceSnapshot } from "@/lib/invoice";
import { saleLines } from "@/lib/dian/discountedLines";
import { saleFromSnapshot } from "../exogena/queries";
import { orderFreeLineTaxSlices, orderSalesTaxSlice } from "../salesTaxSlices";
import { saleTaxOfSnapshot, undeclaredDiscountOf } from "./saleTaxSnapshot";

const items = [
  { qty: 1, name: "Bandeja paisa", priceCents: 42_000_00, taxKind: null, taxPct: null },
  { qty: 1, name: "Ajiaco", priceCents: 32_000_00, taxKind: null, taxPct: null },
  { qty: 2, name: "Limonada de coco", priceCents: 12_000_00, taxKind: null, taxPct: null },
  { qty: 2, name: "Café", priceCents: 6_000_00, taxKind: null, taxPct: null },
  { qty: 1, name: "Arepa de chócolo", priceCents: 3_400_00, taxKind: null, taxPct: null },
];

function snap(over: Partial<InvoiceSnapshot>): InvoiceSnapshot {
  return {
    restaurantName: "Test",
    logoUrl: null,
    legalName: null,
    taxId: null,
    legalAddress: null,
    legalPhone: null,
    dianResolution: null,
    dianResolutionFrom: null,
    dianResolutionTo: null,
    dianResolutionDate: null,
    invoicePrefix: "FE",
    shortCode: "A1",
    tableLabel: "Mesa 1",
    paidAtIso: "2026-10-05T20:00:00.000Z",
    items,
    subtotalCents: 113_400_00,
    taxCents: 0,
    taxByKind: { inc: 0, iva: 0 },
    salesTaxKind: "inc",
    salesTaxPct: 8,
    discountCents: 22_680_00,
    discountPct: 20,
    tipCents: 9_072_00,
    totalCents: 99_792_00,
    ...over,
  };
}

// Factura VIEJA: congeló la base y el INC del precio de lista.
const OLD = snap({ embeddedTaxCents: 8_400_00, embeddedBaseCents: 105_000_00 });
// Factura NUEVA: la base y el INC netos, con la marca.
const NEW = snap({ embeddedTaxCents: 6_720_00, embeddedBaseCents: 84_000_00, discountInLines: { allowanceCents: 21_000_00 } });

describe("undeclaredDiscountOf — cuánto declaró de más una factura vieja", () => {
  it("el caso reportado: $21.000 de base y $1.680 de INC de más", () => {
    expect(undeclaredDiscountOf(OLD)).toEqual({
      discountCents: 22_680_00,
      valueCents: 21_000_00,
      baseCents: 21_000_00,
      taxCents: 1_680_00,
    });
  });

  it("una factura nueva (con la marca) o sin descuento no tiene nada de más", () => {
    expect(undeclaredDiscountOf(NEW)).toBeNull();
    expect(undeclaredDiscountOf(snap({ discountCents: 0, discountPct: null }))).toBeNull();
  });

  it("un snapshot sin tarifa congelada: el valor declarado de más es el descuento, sin impuesto", () => {
    const u = undeclaredDiscountOf(snap({ salesTaxKind: undefined, salesTaxPct: undefined }));
    expect(u).toMatchObject({ valueCents: 22_680_00, baseCents: 0, taxCents: 0 });
  });
});

describe("los reportes usan lo que declaró cada factura", () => {
  it("impuestos del período: la nueva aporta la base y el INC netos; la vieja, los de lista", () => {
    expect(saleTaxOfSnapshot(NEW)).toEqual({ kind: "inc", pct: 8, baseCents: 84_000_00, taxCents: 6_720_00 });
    expect(saleTaxOfSnapshot(OLD)).toEqual({ kind: "inc", pct: 8, baseCents: 105_000_00, taxCents: 8_400_00 });
  });

  it("libro (motor) y tarjeta: el tramo de la nueva es el neto", () => {
    expect(orderSalesTaxSlice({ subtotalCents: 113_400_00, invoiceSnapshot: NEW }, { kind: "inc", pct: 8 })).toEqual({
      kind: "inc",
      pct: 8,
      grossCents: 90_720_00,
      taxCents: 6_720_00,
      baseCents: 84_000_00,
    });
  });

  it("exógena: base = subtotal − descuento − INC; con la factura nueva cuadra con el XML", () => {
    expect(saleFromSnapshot(NEW, null)).toEqual({ customer: null, baseCents: 84_000_00, ivaCents: 0, incCents: 6_720_00 });
    // La vieja: el INC que declaró y la base que queda (subestimada por el INC de más).
    expect(saleFromSnapshot(OLD, null)).toEqual({ customer: null, baseCents: 82_320_00, ivaCents: 0, incCents: 8_400_00 });
  });

  it("descuento mayor que los platos: las líneas libres con IVA encima declaran lo que dijo el XML", () => {
    const freeItems = [
      { nameSnapshot: "Café", qty: 1, priceCentsSnapshot: 5_000_00, cancelledAt: null, taxKind: null, taxPct: null },
      { nameSnapshot: "Catering", qty: 1, priceCentsSnapshot: 200_000_00, cancelledAt: null, taxKind: "iva", taxPct: 19 },
    ];
    const sale = saleLines(freeItems, { kind: "inc", pct: 8 }, 41_000_00);
    const free = sale.freeLineTax!;
    const s = snap({
      items: [
        { qty: 1, name: "Café", priceCents: 5_000_00, taxKind: null, taxPct: null },
        { qty: 1, name: "Catering", priceCents: 200_000_00, taxKind: "iva", taxPct: 19 },
      ],
      subtotalCents: 205_000_00,
      taxCents: 38_000_00,
      taxByKind: { inc: 0, iva: 38_000_00 },
      discountCents: 41_000_00,
      embeddedTaxCents: sale.embedded.taxCents,
      embeddedBaseCents: sale.embedded.baseCents,
      discountInLines: { allowanceCents: sale.allowanceCents, freeLineTax: free },
    });
    expect(orderFreeLineTaxSlices({ subtotalCents: 205_000_00, invoiceSnapshot: s })).toEqual([
      { kind: "iva", pct: 19, grossCents: free[0]!.baseCents + free[0]!.taxCents, taxCents: free[0]!.taxCents, baseCents: free[0]!.baseCents },
    ]);
    const exo = saleFromSnapshot(s, null);
    expect(exo.ivaCents).toBe(free[0]!.taxCents);
    // Base + impuestos = lo cobrado por la comida (subtotal − descuento + IVA sumado).
    expect(exo.baseCents + exo.ivaCents + exo.incCents).toBe(205_000_00 - 41_000_00 + 38_000_00);
  });
});
