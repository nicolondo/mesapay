// Gastos con impuestos en la exógena: el 1001 lleva el IVA y las
// retenciones del gasto (como las compras), el 1005 su IVA descontable y el
// 1009 el saldo del TOTAL A PAGAR.
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ db: {} }));

import { aggregate1001, aggregate1005, aggregate1009, buildExogenaReport, type ExogenaInputs } from "./sources";
import { expenseExogenaInput } from "./queries";

const acme = { id: "s1", name: "ACME S.A.S.", taxId: "900.123.456-8", address: "Cra 1 # 2-3" };
const ana = { id: "s2", name: "Ana María Pérez Gómez", taxId: "1020304050", address: null };
const empty: ExogenaInputs = {
  purchases: [], expenses: [], sales: [], receivables: [], payables: [], filings: [], payroll: [], shareholders: [], holdings: [],
};

describe("gastos con impuestos en la exógena", () => {
  it("de la fila del gasto: pago = base + INC; IVA aparte (descontable o no); retenciones", () => {
    const base = { category: "Mantenimiento", amountCents: 1_000_000, baseCents: 1_000_000, ivaCents: 190_000, ivaDeductible: true, incCents: 0, retefuenteCents: 40_000, reteIvaCents: 28_500 };
    expect(expenseExogenaInput(base, acme)).toEqual({
      supplier: acme,
      category: "Mantenimiento",
      amountCents: 1_000_000,
      ivaCents: 190_000,
      indedCents: 0,
      retefuenteCents: 40_000,
      reteIvaCents: 28_500,
    });
    // IVA no descontable (comercio de INC) e INC: el costo del gasto es 1.190.000 + 80.000.
    expect(expenseExogenaInput({ ...base, amountCents: 1_270_000, ivaDeductible: false, incCents: 80_000 }, acme)).toMatchObject({
      amountCents: 1_080_000,
      indedCents: 190_000,
    });
    // Gasto viejo (base 0): pago = su valor.
    expect(
      expenseExogenaInput({ category: "Arriendo", amountCents: 3_000_000, baseCents: 0, ivaCents: 0, ivaDeductible: false, incCents: 0, retefuenteCents: 0, reteIvaCents: 0 }, acme),
    ).toMatchObject({ amountCents: 3_000_000, ivaCents: 0 });
  });

  it("1001: pago, IVA y retenciones del gasto; uno viejo sin impuestos queda igual", () => {
    const rows = aggregate1001({
      purchases: [],
      expenses: [
        { supplier: acme, category: "Mantenimiento", amountCents: 1_000_000, ivaCents: 190_000, indedCents: 0, retefuenteCents: 40_000, reteIvaCents: 28_500 },
        { supplier: ana, category: "Honorarios contador", amountCents: 800_000 },
      ],
    });
    expect(rows.map((r) => [r.tercero.name, r.pagoCents, r.idedCents, r.indedCents, r.retpCents, r.retaCents])).toEqual([
      ["ACME S.A.S.", 1_000_000, 190_000, 0, 40_000, 28_500],
      ["Ana María Pérez Gómez", 800_000, 0, 0, 0, 0],
    ]);
  });

  it("1005: el IVA DESCONTABLE de los gastos suma al del proveedor; el no descontable no", () => {
    const rows = aggregate1005(
      [{ supplier: acme, netCents: 1, ivaCents: 100_000, indedCents: 0, retefuenteCents: 0, reteIvaCents: 0 }],
      [],
      [
        { supplier: acme, category: "Mantenimiento", amountCents: 1_000_000, ivaCents: 190_000, indedCents: 0 },
        { supplier: ana, category: "Aseo", amountCents: 100_000, ivaCents: 19_000, indedCents: 19_000 },
      ],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ vimpCents: 290_000 });
    const report = buildExogenaReport({
      ...empty,
      expenses: [{ supplier: acme, category: "Mantenimiento", amountCents: 1_000_000, ivaCents: 190_000, indedCents: 0 }],
    });
    expect(report.formats["1005"]).toEqual([expect.objectContaining({ vimpCents: 190_000 })]);
  });

  it("1009: el saldo con el proveedor es el total a pagar menos lo abonado", () => {
    // Total a pagar 1.121.500 (base + IVA − retenciones); abonado 1.000.000.
    expect(aggregate1009([{ supplier: acme, totalCents: 1_121_500, paidCents: 1_000_000 }])).toEqual([
      expect.objectContaining({ saldoCents: 121_500 }),
    ]);
  });
});
