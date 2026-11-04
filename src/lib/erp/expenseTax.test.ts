// Impuestos de un gasto: la misma cuenta en pantalla y en el servidor.
import { describe, expect, it } from "vitest";
import {
  expenseAmounts,
  expenseBaseCents,
  expenseHasTaxes,
  expensePayableCents,
  expenseTaxError,
  expenseTaxesImplied,
  pickRetefuenteConcept,
  retentionAmountCents,
  suggestExpenseRetentions,
  uvtCentsForDate,
} from "./expenseTax";
import { expenseOutstandingCents } from "./accounting";
import { UVT_DEFAULT_CENTS } from "./retencionesCore";

const concept = (over: Partial<{ id: string; kind: string; name: string; rateBps: number; base: string; thresholdUvt: number; accountCode: string; active: boolean }>) => ({
  id: "c",
  kind: "retefuente",
  name: "Servicios (4%) — umbral 4 UVT",
  rateBps: 400,
  base: "subtotal",
  thresholdUvt: 4,
  accountCode: "236505",
  active: true,
  ...over,
});

const SERVICIOS = concept({ id: "serv" });
const COMPRAS = concept({ id: "comp", name: "Compras (2,5%) — umbral 27 UVT", rateBps: 250, thresholdUvt: 27 });
const ARRIENDO = concept({ id: "arr", name: "Arrendamientos (3,5%)", rateBps: 350, thresholdUvt: 27 });
const HONORARIOS = concept({ id: "hon", name: "Honorarios (11%)", rateBps: 1100, thresholdUvt: 0, accountCode: "236515" });
const RETEIVA = concept({ id: "riva", kind: "reteiva", name: "ReteIVA (15% del IVA)", rateBps: 1500, base: "tax", thresholdUvt: 27, accountCode: "236705" });
const RETEICA = concept({ id: "rica", kind: "reteica", name: "ReteICA (7×1.000)", rateBps: 70, thresholdUvt: 0, accountCode: "236805" });

describe("expenseAmounts", () => {
  it("sin impuestos: base = costo = total a pagar", () => {
    expect(expenseAmounts({ subtotalCents: 450_000, ivaDeductible: false })).toMatchObject({
      baseCents: 450_000,
      ivaCents: 0,
      costCents: 450_000,
      payableCents: 450_000,
    });
  });

  it("IVA descontable: no suma al costo, sí al total a pagar", () => {
    const a = expenseAmounts({ subtotalCents: 1_000_000, ivaPct: 19, ivaDeductible: true });
    expect(a).toMatchObject({ ivaCents: 190_000, deductibleIvaCents: 190_000, nonDeductibleIvaCents: 0, costCents: 1_000_000, payableCents: 1_190_000 });
  });

  it("IVA NO descontable: es mayor valor del gasto", () => {
    const a = expenseAmounts({ subtotalCents: 1_000_000, ivaPct: 19, ivaDeductible: false });
    expect(a).toMatchObject({ deductibleIvaCents: 0, nonDeductibleIvaCents: 190_000, costCents: 1_190_000, payableCents: 1_190_000 });
  });

  it("el IVA impreso manda sobre la tarifa (y un cero explícito es cero)", () => {
    expect(expenseAmounts({ subtotalCents: 1_000_000, ivaPct: 19, ivaCents: 189_990, ivaDeductible: true }).ivaCents).toBe(189_990);
    expect(expenseAmounts({ subtotalCents: 1_000_000, ivaPct: 19, ivaCents: 0, ivaDeductible: true }).ivaCents).toBe(0);
  });

  it("INC siempre es costo, también cuando el IVA es descontable", () => {
    const a = expenseAmounts({ subtotalCents: 200_000, incCents: 16_000, ivaDeductible: true });
    expect(a).toMatchObject({ costCents: 216_000, payableCents: 216_000 });
  });

  it("el descuento baja la base y el IVA se calcula sobre la base neta", () => {
    const a = expenseAmounts({ subtotalCents: 1_000_000, discountCents: 100_000, ivaPct: 19, ivaDeductible: true });
    expect(a).toMatchObject({ discountCents: 100_000, baseCents: 900_000, ivaCents: 171_000, payableCents: 1_071_000 });
    // Un descuento mayor que el subtotal no deja la base negativa.
    expect(expenseAmounts({ subtotalCents: 50_000, discountCents: 80_000, ivaDeductible: false }).baseCents).toBe(0);
  });

  it("las retenciones restan del total a pagar, no del costo", () => {
    const a = expenseAmounts({
      subtotalCents: 1_000_000,
      ivaPct: 19,
      ivaDeductible: true,
      retentions: [
        { kind: "retefuente", amountCents: 40_000 },
        { kind: "reteiva", amountCents: 28_500 },
        { kind: "reteica", amountCents: 7_000 },
      ],
    });
    expect(a).toMatchObject({ retefuenteCents: 40_000, reteIvaCents: 28_500, reteIcaCents: 7_000, retentionsCents: 75_500 });
    expect(a.payableCents).toBe(1_190_000 - 75_500);
    expect(a.costCents).toBe(1_000_000);
  });

  it("redondeo al centavo con el mismo criterio de las compras (half-up de Math.round)", () => {
    // 19 % de $1.234,57 = 234,5683 → 234,57
    expect(expenseAmounts({ subtotalCents: 123_457, ivaPct: 19, ivaDeductible: true }).ivaCents).toBe(23_457);
    expect(retentionAmountCents(400, 123_457)).toBe(4_938); // 49,3828 → 49,38
    expect(retentionAmountCents(70, 150)).toBe(1); // 1,05 → 1
  });

  it("expenseHasTaxes", () => {
    expect(expenseHasTaxes(expenseAmounts({ subtotalCents: 10_000, ivaDeductible: false }))).toBe(false);
    expect(expenseHasTaxes(expenseAmounts({ subtotalCents: 10_000, incCents: 800, ivaDeductible: false }))).toBe(true);
  });
});

describe("expenseTaxError", () => {
  const a = (over: Parameters<typeof expenseAmounts>[0]) => expenseAmounts(over);
  it("con IVA o retenciones el proveedor es obligatorio", () => {
    const withIva = a({ subtotalCents: 100_000, ivaPct: 19, ivaDeductible: true });
    expect(expenseTaxError(withIva, { hasSupplier: false })).toBe("supplier_required");
    expect(expenseTaxError(withIva, { hasSupplier: true })).toBeNull();
    // Sólo INC: no exige proveedor (un almuerzo en otro restaurante).
    expect(expenseTaxError(a({ subtotalCents: 100_000, incCents: 8_000, ivaDeductible: false }), { hasSupplier: false })).toBeNull();
  });
  it("una retención no puede superar su base (reteIVA contra el IVA)", () => {
    const amounts = a({ subtotalCents: 100_000, ivaPct: 19, ivaDeductible: true, retentions: [{ kind: "reteiva", amountCents: 19_001 }] });
    expect(expenseTaxError(amounts, { hasSupplier: true, retentions: [{ kind: "reteiva", amountCents: 19_001 }] })).toBe("retention_exceeds_base");
  });
  it("el total a pagar tiene que quedar positivo, y la base también", () => {
    const amounts = a({ subtotalCents: 100_000, ivaDeductible: false, retentions: [{ kind: "retefuente", amountCents: 100_000 }] });
    expect(expenseTaxError(amounts, { hasSupplier: true, retentions: [{ kind: "retefuente", amountCents: 100_000 }] })).toBe("payable_not_positive");
    expect(expenseTaxError(a({ subtotalCents: 0, ivaDeductible: false }), { hasSupplier: true })).toBe("invalid");
  });
});

describe("retenciones sugeridas (mismo motor que compras + umbral UVT)", () => {
  const UVT = UVT_DEFAULT_CENTS; // $52.374
  it("una sola retefuente: la que le queda a la categoría o a la cuenta", () => {
    const all = [COMPRAS, SERVICIOS, ARRIENDO, HONORARIOS];
    expect(pickRetefuenteConcept(all, { category: "Arriendo local" })?.id).toBe("arr");
    expect(pickRetefuenteConcept(all, { category: "Contador", accountCode: null })?.id).toBe("hon");
    expect(pickRetefuenteConcept(all, { category: "Varios", accountCode: "512010" })?.id).toBe("arr");
    expect(pickRetefuenteConcept(all, { category: "Papelería" })?.id).toBe("comp");
    // Sin pista: servicios (lo más común en gastos).
    expect(pickRetefuenteConcept(all, { category: "Mantenimiento nevera" })?.id).toBe("serv");
    expect(pickRetefuenteConcept([COMPRAS], { category: "Mantenimiento" })?.id).toBe("comp");
    expect(pickRetefuenteConcept([], { category: "x" })).toBeNull();
  });

  it("aplica el umbral: debajo de 4 UVT no hay retefuente de servicios; ReteICA sin umbral sí", () => {
    const below = suggestExpenseRetentions([SERVICIOS, RETEICA], { baseCents: 4 * UVT - 1, ivaCents: 0, category: "Mantenimiento" }, UVT);
    expect(below.map((r) => r.conceptId)).toEqual(["rica"]);
    const at = suggestExpenseRetentions([SERVICIOS, RETEICA], { baseCents: 4 * UVT, ivaCents: 0, category: "Mantenimiento" }, UVT);
    expect(at.map((r) => [r.conceptId, r.amountCents])).toEqual([
      ["serv", Math.round((4 * UVT * 400) / 10_000)],
      ["rica", Math.round((4 * UVT * 70) / 10_000)],
    ]);
  });

  it("reteIVA se calcula sobre el IVA, con el umbral sobre la base", () => {
    const base = 30 * UVT;
    const iva = Math.round(base * 0.19);
    const s = suggestExpenseRetentions([RETEIVA], { baseCents: base, ivaCents: iva }, UVT);
    expect(s).toEqual([expect.objectContaining({ conceptId: "riva", baseCents: iva, amountCents: Math.round((iva * 1500) / 10_000), accountCode: "236705" })]);
    expect(suggestExpenseRetentions([RETEIVA], { baseCents: base, ivaCents: 0 }, UVT)).toEqual([]);
  });

  it("los conceptos inactivos no se sugieren (el comercio no es agente retenedor)", () => {
    expect(suggestExpenseRetentions([{ ...SERVICIOS, active: false }], { baseCents: 10_000_000, ivaCents: 0 }, UVT)).toEqual([]);
  });

  it("la UVT es la del año de la fecha (tabla oficial) y, si no está, la del contador", () => {
    expect(uvtCentsForDate(new Date("2025-12-31T17:00:00Z"), 9_900_000)).toBe(4_979_900);
    expect(uvtCentsForDate("2026-03-05", 9_900_000)).toBe(5_237_400);
    expect(uvtCentsForDate("2031-01-05", 6_000_000)).toBe(6_000_000);
  });
});

describe("gastos guardados (compatibilidad)", () => {
  it("un gasto viejo (payable 0) paga su valor; uno nuevo, su total a pagar", () => {
    expect(expensePayableCents({ amountCents: 300_000, payableCents: 0 })).toBe(300_000);
    expect(expensePayableCents({ amountCents: 300_000 })).toBe(300_000);
    expect(expensePayableCents({ amountCents: 1_000_000, payableCents: 1_150_000 })).toBe(1_150_000);
    expect(expenseBaseCents({ amountCents: 300_000, baseCents: 0 })).toBe(300_000);
    expect(expenseBaseCents({ amountCents: 1_190_000, baseCents: 1_000_000 })).toBe(1_000_000);
  });
  it("el saldo por pagar es total a pagar − abonado", () => {
    expect(expenseOutstandingCents({ amountCents: 1_000_000, payableCents: 1_150_000, paidCents: 150_000, recurring: false })).toBe(1_000_000);
    expect(expenseOutstandingCents({ amountCents: 500_000, payableCents: 0, paidCents: 200_000, recurring: false })).toBe(300_000);
    expect(expenseOutstandingCents({ amountCents: 500_000, payableCents: 500_000, recurring: true })).toBe(0);
  });
});

describe("¿abrir «Impuestos y retenciones» solo?", () => {
  it("factura electrónica, cuenta de cobro o proveedor con NIT de persona jurídica", () => {
    expect(expenseTaxesImplied({ documentType: "e_invoice" })).toBe(true);
    expect(expenseTaxesImplied({ documentType: "charge_account" })).toBe(true);
    expect(expenseTaxesImplied({ documentType: "equivalent" })).toBe(false);
    expect(expenseTaxesImplied({ supplierTaxId: "900123456-7" })).toBe(true);
    expect(expenseTaxesImplied({ supplierTaxId: "NIT 800.123.456" })).toBe(true);
    expect(expenseTaxesImplied({ supplierTaxId: "1020304050" })).toBe(false);
    expect(expenseTaxesImplied({})).toBe(false);
  });
});
