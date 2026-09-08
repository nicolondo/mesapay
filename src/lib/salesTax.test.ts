import { describe, expect, it } from "vitest";
import { lineTaxOnTopCents, orderTaxTotals, type TaxedLine } from "./salesTax";

const INC8 = { kind: "inc" as const, pct: 8 };
const NONE = { kind: "none" as const, pct: 0 };

const menu = (amountCents: number): TaxedLine => ({
  amountCents,
  taxKind: null,
  taxPct: null,
});
const free = (amountCents: number, taxKind: string, taxPct: number): TaxedLine => ({
  amountCents,
  taxKind,
  taxPct,
});

describe("lineTaxOnTopCents", () => {
  it("suma encima en las líneas libres", () => {
    expect(lineTaxOnTopCents(free(2_400_000_00, "iva", 19))).toBe(456_000_00);
  });
  it("los platos del menú no suman nada encima", () => {
    expect(lineTaxOnTopCents(menu(30_000_00))).toBe(0);
  });
  it("excluido no suma", () => {
    expect(lineTaxOnTopCents(free(100_000, "none", 0))).toBe(0);
    expect(lineTaxOnTopCents(free(100_000, "iva", 0))).toBe(0);
  });
});

describe("orderTaxTotals", () => {
  it("una cuenta solo de menú se comporta como antes", () => {
    const t = orderTaxTotals([menu(30_000_00), menu(20_000_00)], INC8);
    expect(t.subtotalCents).toBe(50_000_00);
    // Nada se suma encima: el precio del menú ya lo incluye.
    expect(t.taxOnTopCents).toBe(0);
    expect(t.chargeableCents).toBe(50_000_00);
    // 8% embebido de $50.000 = 50.000 × 8/108
    expect(t.byKind.inc).toBe(3_703_70);
    expect(t.byKind.iva).toBe(0);
  });

  it("mezcla platos con INC embebido y un servicio con IVA encima", () => {
    const t = orderTaxTotals([menu(100_000_00), free(1_000_000_00, "iva", 19)], INC8);
    expect(t.subtotalCents).toBe(1_100_000_00);
    expect(t.taxOnTopCents).toBe(190_000_00);
    expect(t.chargeableCents).toBe(1_290_000_00);
    // Cada uno bajo SU tipo: antes todo caía en el único del comercio.
    expect(t.byKind.inc).toBe(7_407_41);
    expect(t.byKind.iva).toBe(190_000_00);
  });

  it("el comercio sin impuesto no inventa nada, pero la línea libre sí manda", () => {
    const t = orderTaxTotals([menu(50_000), free(100_000, "iva", 19)], NONE);
    expect(t.byKind.inc).toBe(0);
    expect(t.byKind.iva).toBe(19_000);
    expect(t.chargeableCents).toBe(150_000 + 19_000);
  });

  it("cuenta vacía", () => {
    const t = orderTaxTotals([], INC8);
    expect(t).toEqual({
      subtotalCents: 0,
      taxOnTopCents: 0,
      chargeableCents: 0,
      byKind: { inc: 0, iva: 0 },
    });
  });
});
