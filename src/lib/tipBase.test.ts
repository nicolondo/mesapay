import { describe, expect, it } from "vitest";
import { saleLines, type OrderItemForInvoice } from "./dian/discountedLines";
import { tipBaseOfItems, tipBaseOfSale } from "./tipBase";
import { tipCentsFor } from "./tips";

/**
 * La base de la propina sale del MISMO reparto por línea que la factura
 * electrónica: lo que el comensal ve como «valor antes de impuestos» es la
 * suma de las bases que declara el XML.
 */

const plate = (priceCents: number, qty = 1, over: Partial<OrderItemForInvoice> = {}): OrderItemForInvoice => ({
  nameSnapshot: "Plato",
  qty,
  priceCentsSnapshot: priceCents,
  cancelledAt: null,
  taxKind: null,
  taxPct: null,
  ...over,
});
const freeLine = (priceCents: number, taxKind: "inc" | "iva" | "none", taxPct: number): OrderItemForInvoice =>
  plate(priceCents, 1, { nameSnapshot: "Servicio", taxKind, taxPct });

const INC8 = { kind: "inc" as const, pct: 8 };
const IVA19 = { kind: "iva" as const, pct: 19 };
const NONE = { kind: "none" as const, pct: 0 };

describe("tipBaseOfItems", () => {
  it("INC 8 %: $108.000 → base $100.000 → propina 10 % $10.000", () => {
    const base = tipBaseOfItems([plate(10_800_000)], INC8);
    expect(base).toEqual({ chargeableCents: 10_800_000, preTaxCents: 10_000_000 });
    expect(tipCentsFor(10_800_000, 10, base)).toBe(1_000_000);
  });

  it("IVA 19 % del comercio: $119.000 → base $100.000", () => {
    expect(tipBaseOfItems([plate(11_900_000)], IVA19)).toEqual({ chargeableCents: 11_900_000, preTaxCents: 10_000_000 });
  });

  it("comercio sin impuesto: base = total", () => {
    expect(tipBaseOfItems([plate(10_800_000)], NONE)).toEqual({ chargeableCents: 10_800_000, preTaxCents: 10_800_000 });
    // Una tarifa cargada con el tipo en "none" tampoco inventa impuesto.
    expect(tipBaseOfItems([plate(10_800_000)], { kind: "none", pct: 8 }).preTaxCents).toBe(10_800_000);
  });

  it("cada línea con su tarifa: platos con INC embebido + línea libre con IVA 19 % ENCIMA + línea libre sin impuesto", () => {
    const base = tipBaseOfItems(
      [plate(5_400_000), freeLine(10_000_000, "iva", 19), freeLine(2_000_000, "none", 0)],
      INC8,
    );
    // Cobrable: $54.000 + ($100.000 + IVA $19.000) + $20.000 = $193.000.
    // Sin impuesto: $50.000 + $100.000 + $20.000 = $170.000.
    expect(base).toEqual({ chargeableCents: 19_300_000, preTaxCents: 17_000_000 });
    expect(tipCentsFor(19_300_000, 10, base)).toBe(1_700_000);
  });

  it("el redondeo es POR LÍNEA, como el XML (no sobre el total)", () => {
    // Tres platos de $30.000: cada uno $27.777,78 de base.
    const items = [plate(3_000_000), plate(3_000_000), plate(3_000_000)];
    const base = tipBaseOfItems(items, INC8);
    expect(base.preTaxCents).toBe(3 * 2_777_778);
    expect(base.preTaxCents).toBe(saleLines(items, INC8).lines.reduce((s, l) => s + l.lineTotalCents, 0));
    // 10 % de $83.333,34 → $8.333.
    expect(tipCentsFor(9_000_000, 10, base)).toBe(833_300);
  });

  it("con el descuento del cliente repartido en las líneas: la base neta es la que congela la factura", () => {
    const items = [plate(10_800_000)];
    const base = tipBaseOfItems(items, INC8, 1_080_000);
    // $108.000 − 10 % = $97.200 → sin INC, $90.000 → propina $9.000.
    expect(base).toEqual({ chargeableCents: 9_720_000, preTaxCents: 9_000_000 });
    expect(base.preTaxCents).toBe(saleLines(items, INC8, 1_080_000).embedded.baseCents);
    expect(tipCentsFor(9_720_000, 10, base)).toBe(900_000);
  });

  it("descuento mayor que los platos: la línea libre con impuesto encima absorbe el resto y declara su base neta", () => {
    const items = [plate(1_080_000), freeLine(10_000_000, "iva", 19)];
    const sale = saleLines(items, INC8, 3_080_000);
    const base = tipBaseOfSale(sale);
    // Cobrable: $10.800 + $119.000 − $30.800 = $99.000.
    expect(base.chargeableCents).toBe(9_900_000);
    expect(base.preTaxCents).toBe(sale.lines.reduce((s, l) => s + l.lineTotalCents, 0));
    expect(base.preTaxCents).toBeLessThan(base.chargeableCents);
  });

  it("lo cancelado y lo que vale $0 no entran (como en la factura)", () => {
    const base = tipBaseOfItems(
      [plate(10_800_000), plate(5_000_000, 1, { cancelledAt: new Date() }), plate(0), plate(2_000_000, 0)],
      INC8,
    );
    expect(base).toEqual({ chargeableCents: 10_800_000, preTaxCents: 10_000_000 });
  });

  it("cuenta vacía: base vacía (la propina sale en cero)", () => {
    const base = tipBaseOfItems([], INC8);
    expect(base).toEqual({ chargeableCents: 0, preTaxCents: 0 });
    expect(tipCentsFor(0, 10, base)).toBe(0);
  });

  it("la política «with_tax» (la de antes) deja la base = lo cobrable", () => {
    expect(tipBaseOfItems([plate(10_800_000)], INC8, 0, "with_tax")).toEqual({
      chargeableCents: 10_800_000,
      preTaxCents: 10_800_000,
    });
  });
});
