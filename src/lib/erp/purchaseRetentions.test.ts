import { describe, expect, it } from "vitest";
import {
  pickPurchaseRetefuenteConcept,
  purchasePayableCents,
  purchaseRetentionError,
  purchaseRetentionTotals,
  suggestPurchaseRetentions,
} from "./purchaseRetentions";
import { UVT_DEFAULT_CENTS } from "./retencionesCore";
import { purchaseOrderTotals } from "./purchaseTax";

const UVT = UVT_DEFAULT_CENTS; // $52.374
const concept = (id: string, over: Record<string, unknown>) => ({
  id,
  kind: "retefuente",
  name: id,
  rateBps: 250,
  base: "subtotal",
  thresholdUvt: 27,
  accountCode: "236505",
  active: true,
  ...over,
});
const COMPRAS = concept("compras", { name: "Compras (2,5%) — umbral 27 UVT" });
const SERVICIOS = concept("servicios", { name: "Servicios (4%) — umbral 4 UVT", rateBps: 400, thresholdUvt: 4 });
const RETEIVA = concept("reteiva", { kind: "reteiva", name: "ReteIVA (15% del IVA)", rateBps: 1500, base: "tax", accountCode: "236705" });
const RETEICA = concept("reteica", { kind: "reteica", name: "ReteICA (7×1.000)", rateBps: 70, thresholdUvt: 0, accountCode: "236805" });

describe("suggestPurchaseRetentions", () => {
  // 27 UVT = $1.414.098.
  const above = { baseCents: 200_000_000, ivaCents: 38_000_000 };
  const below = { baseCents: 100_000_000, ivaCents: 19_000_000 };

  it("a una compra de insumos le aplica la retefuente de compras aunque servicios también esté activo", () => {
    expect(pickPurchaseRetefuenteConcept([SERVICIOS, COMPRAS])?.id).toBe("compras");
    const lines = suggestPurchaseRetentions([SERVICIOS, COMPRAS, RETEIVA, RETEICA], above, UVT);
    expect(lines.map((l) => [l.conceptId, l.amountCents])).toEqual([
      ["compras", 5_000_000], // 2,5 % de $2.000.000
      ["reteiva", 5_700_000], // 15 % del IVA $380.000
      ["reteica", 1_400_000], // 7 × 1.000 de $2.000.000
    ]);
    expect(lines[1]).toMatchObject({ base: "tax", baseCents: 38_000_000 });
  });

  it("bajo el umbral en UVT solo queda lo que no tiene umbral", () => {
    const lines = suggestPurchaseRetentions([COMPRAS, RETEIVA, RETEICA], below, UVT);
    expect(lines.map((l) => l.conceptId)).toEqual(["reteica"]);
    expect(lines[0]!.amountCents).toBe(700_000);
  });

  it("el umbral es justo en 27 UVT: desde ahí retiene", () => {
    const at = { baseCents: 27 * UVT, ivaCents: 0 };
    expect(suggestPurchaseRetentions([COMPRAS], at, UVT).map((l) => l.amountCents)).toEqual([Math.round((27 * UVT * 250) / 10_000)]);
    expect(suggestPurchaseRetentions([COMPRAS], { baseCents: 27 * UVT - 1, ivaCents: 0 }, UVT)).toEqual([]);
  });

  it("sin conceptos activos no sugiere nada; uno inactivo no cuenta", () => {
    expect(suggestPurchaseRetentions([], above, UVT)).toEqual([]);
    expect(suggestPurchaseRetentions([{ ...COMPRAS, active: false }], above, UVT)).toEqual([]);
  });

  it("sin IVA no hay reteIVA", () => {
    expect(suggestPurchaseRetentions([RETEIVA], { baseCents: 200_000_000, ivaCents: 0 }, UVT)).toEqual([]);
  });

  it("la base es la neta: el impuesto al consumo no la sube", () => {
    // Una compra de $1.400.000 con $112.000 de consumo sigue bajo 27 UVT.
    expect(suggestPurchaseRetentions([COMPRAS], { baseCents: 140_000_000, ivaCents: 0 }, UVT)).toEqual([]);
  });
});

describe("purchaseRetentionTotals / purchaseRetentionError", () => {
  const doc = { baseCents: 1_000_000, ivaCents: 190_000, incCents: 0 };

  it("suma por tipo, ignorando negativos", () => {
    expect(
      purchaseRetentionTotals([
        { kind: "retefuente", amountCents: 25_000 },
        { kind: "retefuente", amountCents: 1_000 },
        { kind: "reteiva", amountCents: 28_500 },
        { kind: "reteica", amountCents: 7_000 },
        { kind: "reteica", amountCents: -5 },
      ]),
    ).toEqual({ retefuenteCents: 26_000, reteIvaCents: 28_500, reteIcaCents: 7_000 });
  });

  it("cada retención hasta su base; reteIVA hasta el IVA", () => {
    expect(purchaseRetentionError({ retefuenteCents: 1_000_000, reteIvaCents: 0, reteIcaCents: 0 }, doc)).toBeNull();
    expect(purchaseRetentionError({ retefuenteCents: 1_000_001, reteIvaCents: 0, reteIcaCents: 0 }, doc)).toBe("retention_exceeds_base");
    expect(purchaseRetentionError({ retefuenteCents: 0, reteIvaCents: 190_001, reteIcaCents: 0 }, doc)).toBe("retention_exceeds_base");
    expect(purchaseRetentionError({ retefuenteCents: 0, reteIvaCents: 0, reteIcaCents: 1_000_001 }, doc)).toBe("retention_exceeds_base");
  });

  it("entre todas, nunca más que el total de la factura", () => {
    expect(purchaseRetentionError({ retefuenteCents: 1_000_000, reteIvaCents: 190_000, reteIcaCents: 1 }, doc)).toBe("retention_exceeds_total");
  });

  it("total a pagar = base + IVA + consumo − retenciones", () => {
    expect(purchasePayableCents({ ...doc, incCents: 80_000 }, { retefuenteCents: 25_000, reteIvaCents: 28_500, reteIcaCents: 7_000 })).toBe(1_209_500);
  });
});

describe("cuenta por pagar con retenciones practicadas al recibir", () => {
  const items = [
    { expectedCostCents: 1_000_000, qtyOrderedBase: 10, taxPct: 0, receivedQtyBase: 5, receivedCostCents: 500_000 },
  ];

  it("las de una factura importada como borrador siguen el avance de la recepción", () => {
    expect(purchaseOrderTotals({ retefuenteCents: 25_000, items }, "received")).toMatchObject({ retentionsCents: 12_500, totalCents: 487_500 });
  });

  it("las practicadas en la recepción cuentan completas desde esa entrega", () => {
    expect(
      purchaseOrderTotals({ retefuenteCents: 12_500, receptionRetentionCents: 12_500, items }, "received"),
    ).toMatchObject({ retentionsCents: 12_500, totalCents: 487_500 });
  });

  it("mezcla: lo de la factura se reparte y lo de la recepción va entero", () => {
    // 20.000 de la factura (la mitad recibida = 10.000) + 3.500 de la recepción.
    expect(
      purchaseOrderTotals({ retefuenteCents: 20_000, reteIcaCents: 3_500, receptionRetentionCents: 3_500, items }, "received"),
    ).toMatchObject({ retentionsCents: 13_500 });
    // En lo esperado (detalle de la orden) van todas.
    expect(
      purchaseOrderTotals({ retefuenteCents: 20_000, reteIcaCents: 3_500, receptionRetentionCents: 3_500, items }, "expected"),
    ).toMatchObject({ retentionsCents: 23_500 });
  });

  it("una marca mayor que el total no inventa retenciones", () => {
    expect(purchaseOrderTotals({ retefuenteCents: 1_000, receptionRetentionCents: 9_999, items }, "received").retentionsCents).toBe(1_000);
  });
});
