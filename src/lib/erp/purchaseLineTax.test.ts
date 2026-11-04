import { describe, expect, it } from "vitest";
import {
  decodeLineTax,
  encodeLineTax,
  lineIncCents,
  lineIncForReception,
  lineTaxEditable,
  lineTaxOptions,
  receptionLineTax,
  type ReceptionLineTaxItem,
} from "./purchaseLineTax";
import { purchaseLineAmounts, purchaseOrderTotals, receivedPurchaseLineAmounts } from "./purchaseTax";

describe("control «Impuesto» de la línea", () => {
  it("ofrece sin impuesto, cada tarifa, consumo y tarifa + consumo", () => {
    expect(lineTaxOptions([0, 5, 19]).map(encodeLineTax)).toEqual([
      "none",
      "iva:5",
      "iva:19",
      "inc",
      "iva:5+inc",
      "iva:19+inc",
    ]);
  });

  it("conserva una tarifa guardada que ya no está en la lista del país", () => {
    expect(lineTaxOptions([0, 5, 19], { ivaPct: 16, inc: false }).map(encodeLineTax)).toContain("iva:16");
  });

  it("codifica y decodifica sin perder nada", () => {
    for (const c of [
      { ivaPct: 0, inc: false },
      { ivaPct: 19, inc: false },
      { ivaPct: 0, inc: true },
      { ivaPct: 5, inc: true },
    ]) {
      expect(decodeLineTax(encodeLineTax(c))).toEqual(c);
    }
    expect(decodeLineTax("basura")).toEqual({ ivaPct: 0, inc: false });
  });
});

describe("lineIncCents", () => {
  it("en % va sobre la base neta (ya descontada)", () => {
    expect(lineIncCents(100_000, { pct: 8 })).toBe(8_000);
    expect(lineIncCents(12_345, { pct: 8 })).toBe(988);
  });
  it("en valor es el valor fijo de la línea", () => {
    expect(lineIncCents(100_000, { cents: 4_550 })).toBe(4_550);
  });
  it("sin valor, o con base negativa, es cero", () => {
    expect(lineIncCents(100_000, {})).toBe(0);
    expect(lineIncCents(-5, { pct: 8 })).toBe(0);
  });
});

describe("lineIncForReception", () => {
  it("recibir todo deja el consumo tal cual", () => {
    expect(lineIncForReception(8_000, 24, 24)).toBe(8_000);
  });

  it("en una recepción parcial el reparto por cantidad devuelve exactamente lo digitado", () => {
    for (const ordered of [3, 7, 24, 1_000, 12_500]) {
      for (const received of [1, 2, Math.floor(ordered / 3) || 1, ordered - 1]) {
        if (received <= 0 || received >= ordered) continue;
        for (const inc of [1, 99, 333, 8_000, 123_457]) {
          const total = lineIncForReception(inc, received, ordered);
          const item = { expectedCostCents: 100_000, expectedIncCents: total, qtyOrderedBase: ordered, taxPct: 0 };
          expect(purchaseLineAmounts(item, 0, received).incCents).toBe(inc);
        }
      }
    }
  });

  it("cero borra el consumo", () => {
    expect(lineIncForReception(0, 5, 10)).toBe(0);
  });
});

const item = (over: Partial<ReceptionLineTaxItem> = {}): ReceptionLineTaxItem => ({
  expectedCostCents: 240_000,
  qtyOrderedBase: 24,
  taxPct: 19,
  expectedTaxCents: null,
  expectedIncCents: 0,
  receivedQtyBase: 0,
  receivedCostCents: 0,
  ...over,
});

describe("receptionLineTax", () => {
  it("sin cambio no toca la línea", () => {
    expect(receptionLineTax(item(), {}, 24, 240_000).changed).toBe(false);
    expect(receptionLineTax(item(), { taxPct: 19, incCents: 0 }, 24, 240_000).changed).toBe(false);
  });

  it("el consumo que ya le tocaba a la entrega no reescribe el de la línea (sin centavos de más)", () => {
    const it8 = item({ expectedIncCents: 8_000 });
    // 10 de 24: le tocan round(8000 × 10 / 24) = 3333.
    expect(receptionLineTax(it8, { taxPct: 19, incCents: 3_333 }, 10, 100_000)).toMatchObject({ changed: false, expectedIncCents: 8_000 });
  });

  it("otra tarifa descarta el IVA documental; la misma lo conserva", () => {
    const documentary = item({ expectedTaxCents: 45_000 });
    expect(receptionLineTax(documentary, { taxPct: 5 }, 24, 240_000)).toMatchObject({ changed: true, taxPct: 5, expectedTaxCents: null });
    expect(receptionLineTax(documentary, { taxPct: 19, incCents: 2_000 }, 24, 240_000)).toMatchObject({ taxPct: 19, expectedTaxCents: 45_000 });
  });

  it("consumo en vez de IVA, para una entrega parcial: el total escala y la entrega lleva lo digitado", () => {
    const next = receptionLineTax(item(), { taxPct: 0, incCents: 8_000 }, 10, 100_000);
    expect(next).toMatchObject({ changed: true, taxPct: 0, expectedTaxCents: null, expectedIncCents: 19_200 });
    const updated = { ...item(), ...next };
    const afterFirst = { ...updated, receivedQtyBase: 10, receivedCostCents: 100_000 };
    expect(receivedPurchaseLineAmounts(afterFirst)).toMatchObject({ taxCents: 0, incCents: 8_000 });
    // El resto llega después con el mismo reparto: la línea completa lleva 19.200.
    const complete = { ...afterFirst, receivedQtyBase: 24, receivedCostCents: 240_000 };
    expect(receivedPurchaseLineAmounts(complete).incCents).toBe(19_200);
    expect(purchaseOrderTotals({ incCents: 19_200, items: [complete] }, "received")).toMatchObject({ incCents: 19_200, totalCents: 259_200 });
  });

  it("solo se edita una línea sin nada recibido", () => {
    expect(lineTaxEditable(item())).toBe(true);
    expect(lineTaxEditable(item({ receivedQtyBase: 1 }))).toBe(false);
    expect(lineTaxEditable(item({ receivedCostCents: 1 }))).toBe(false);
  });
});
