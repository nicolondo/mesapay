// Reparto del IVA de compras entre descontable (2408) y mayor valor del
// costo (inventario o gasto). Lo decide `Restaurant.purchaseIvaDeductible`
// AL RECIBIR y queda congelado: en el kardex (las líneas inventariables
// entran al bruto sin descontable) y en la línea (las no inventariables).
// Es la única definición: la usan el libro de compras (y con él el asiento),
// el documental de impuestos, la exógena y la declaración.
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ orders: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: { purchaseOrder: { findMany: m.orders } } }));

import { loadPurchasesBook } from "./accountingData";
import { capitalizedInventoryVatByLine, receivedNonDeductibleTaxByLine } from "./purchaseTax";

/** Insumo de inventario: 100.000 neto con IVA 19 %, recibido completo. */
const cheese = { ingredientId: "queso", expectedCostCents: 100_000, qtyOrderedBase: 2_000, taxPct: 19, receivedCostCents: 100_000, receivedQtyBase: 2_000 };
/** Servicio no inventariable: 50.000 neto, IVA 19 % congelado al recibir sin descontable. */
const fumigation = {
  ingredientId: "fumigacion",
  expectedCostCents: 50_000,
  qtyOrderedBase: 1,
  taxPct: 19,
  receivedCostCents: 50_000,
  receivedQtyBase: 1,
  nonInventoryReceivedCostCents: 50_000,
  nonInventoryReceivedNonDeductibleTaxCents: 9_500,
};
/** Kardex de la compra recibida SIN IVA descontable (al bruto) y CON (al neto). */
const GROSS = [{ ingredientId: "queso", valueCents: 59_500 }, { ingredientId: "queso", valueCents: 59_500 }];
const NET = [{ ingredientId: "queso", valueCents: 100_000 }];

describe("IVA de compras capitalizado en el inventario", () => {
  it("sin descontable al recibir: el IVA de la línea inventariable quedó en el costo", () => {
    expect(capitalizedInventoryVatByLine([cheese, fumigation], GROSS)).toEqual([19_000, 0]);
    expect(receivedNonDeductibleTaxByLine([cheese, fumigation], GROSS)).toEqual([19_000, 9_500]);
  });

  it("con descontable al recibir: nada quedó en el costo; lo congelado de siempre", () => {
    expect(capitalizedInventoryVatByLine([cheese], NET)).toEqual([0]);
    expect(receivedNonDeductibleTaxByLine([cheese, { ...fumigation, nonInventoryReceivedNonDeductibleTaxCents: 0 }], NET)).toEqual([0, 0]);
  });

  it("el consumo (INC) que entró al kardex no se confunde con IVA", () => {
    const withInc = { ...cheese, expectedIncCents: 8_000 };
    expect(capitalizedInventoryVatByLine([withInc], [{ ingredientId: "queso", valueCents: 108_000 }])).toEqual([0]);
    expect(capitalizedInventoryVatByLine([withInc], [{ ingredientId: "queso", valueCents: 127_000 }])).toEqual([19_000]);
  });

  it("recepción parcial: el IVA de lo recibido hasta hoy, con el IVA documental prorrateado", () => {
    // Factura de 3 unidades por 3 con IVA 2 y consumo 2 (como la de
    // purchase-invoice-totals): llegó 1 → kardex 1 neto + 1 consumo + 1 IVA.
    const partial = { ingredientId: "x", expectedCostCents: 3, expectedTaxCents: 2, expectedIncCents: 2, qtyOrderedBase: 3, taxPct: 19, receivedCostCents: 1, receivedQtyBase: 1 };
    expect(capitalizedInventoryVatByLine([partial], [{ ingredientId: "x", valueCents: 3 }])).toEqual([1]);
    // Las tres entregas (kardex 3, 1, 3 = 7): todo el IVA documental.
    const full = { ...partial, receivedCostCents: 3, receivedQtyBase: 3 };
    expect(capitalizedInventoryVatByLine([full], [3, 1, 3].map((valueCents) => ({ ingredientId: "x", valueCents })))).toEqual([2]);
  });

  it("cambiar hoy el ajuste del comercio no reescribe lo recibido: manda el kardex", () => {
    // Mismo kardex, misma respuesta: la función no recibe el ajuste actual.
    expect(capitalizedInventoryVatByLine([cheese], GROSS)).toEqual([19_000]);
  });

  it("nunca capitaliza más IVA que el de la línea; dos líneas del mismo insumo se llenan en orden", () => {
    expect(capitalizedInventoryVatByLine([cheese], [{ ingredientId: "queso", valueCents: 500_000 }])).toEqual([19_000]);
    const half = { ...cheese, expectedCostCents: 50_000, receivedCostCents: 50_000 };
    expect(capitalizedInventoryVatByLine([half, half], [{ ingredientId: "queso", valueCents: 119_000 }])).toEqual([9_500, 9_500]);
    // Sin kardex (línea no inventariable o compra vieja sin movimiento): nada.
    expect(capitalizedInventoryVatByLine([cheese], [])).toEqual([0]);
  });
});

describe("libro de compras", () => {
  const base = {
    receivedAt: new Date("2026-09-12T15:00:00Z"),
    supplierInvoiceNumber: null,
    invoiceDueAt: null,
    paidAt: null,
    paidCents: 0,
    incCents: 0,
    retefuenteCents: 0,
    reteIvaCents: 0,
    reteIcaCents: 0,
    supplier: { name: "Proveedor" },
  };
  const items = [
    { ...cheese, nonInventoryReceivedCostCents: 0, nonInventoryReceivedNonDeductibleTaxCents: 0, nonInventoryReceivedIncCents: 0 },
    { ...fumigation, nonInventoryReceivedIncCents: 0 },
  ];
  beforeEach(() => vi.clearAllMocks());

  it.each([
    { label: "sin descontable", movements: GROSS, frozen: 9_500, inventoryVat: 19_000 },
    { label: "con descontable", movements: NET, frozen: 0, inventoryVat: 0 },
  ])("lee del kardex lo que quedó en el costo ($label)", async ({ movements, frozen, inventoryVat }) => {
    const lines = items.map((i) => (i.ingredientId === "fumigacion" ? { ...i, nonInventoryReceivedNonDeductibleTaxCents: frozen } : i));
    m.orders.mockResolvedValue([{ ...base, id: "a", number: 1, items: lines, movements }]);
    const { rows, totals } = await loadPurchasesBook("r", { from: new Date("2026-09-01"), to: new Date("2026-10-01") });
    expect(rows[0]).toMatchObject({ ivaCents: 28_500, nonInventoryNonDeductibleTaxCents: frozen, inventoryNonDeductibleTaxCents: inventoryVat });
    expect(totals).toMatchObject({ ivaCents: 28_500, inventoryNonDeductibleTaxCents: inventoryVat });
    const query = m.orders.mock.calls[0]![0];
    expect(query.select.movements).toEqual({ where: { kind: "purchase_in" }, select: { ingredientId: true, valueCents: true } });
    expect(query.select.items.select.ingredientId).toBe(true);
  });
});
