// Cuentas por pagar: un gasto con impuestos se le debe al proveedor por su
// TOTAL A PAGAR (base + IVA + INC − retenciones), no por su costo; uno viejo
// (payable 0) por su valor, como siempre.
import { describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ expenses: vi.fn() }));
vi.mock("@/lib/db", () => ({
  db: {
    purchaseOrder: { findMany: async () => [] },
    expense: { findMany: m.expenses },
  },
}));

import { loadPayablesDocs } from "./carteraQueries";

const row = (over: Record<string, unknown>) => ({
  id: "e1",
  category: "Mantenimiento",
  description: null,
  documentNumber: null,
  amountCents: 1_000_000,
  payableCents: 1_000_000,
  date: new Date("2026-10-10T17:00:00Z"),
  dueAt: null,
  supplier: { id: "s1", name: "Refrigeración Andina", taxId: "900123456-7" },
  payments: [],
  ...over,
});

describe("loadPayablesDocs — gastos", () => {
  it("total y saldo salen del total a pagar; el número es el del documento soporte", async () => {
    m.expenses.mockResolvedValue([
      row({ documentNumber: "FE-901", payableCents: 1_121_500, payments: [{ id: "p1", amountCents: 1_000_000, paidAt: new Date("2026-10-12T17:00:00Z"), note: null }] }),
      row({ id: "e2", category: "Arriendo", amountCents: 3_000_000, payableCents: 0 }),
    ]);
    const docs = await loadPayablesDocs("r1", "2026-10-31");
    expect(docs).toEqual([
      expect.objectContaining({ id: "e1", number: "FE-901", totalCents: 1_121_500, outstandingCents: 121_500 }),
      expect.objectContaining({ id: "e2", number: "Arriendo", totalCents: 3_000_000, outstandingCents: 3_000_000 }),
    ]);
    const select = m.expenses.mock.calls[0]![0].select;
    expect(select).toMatchObject({ payableCents: true, documentNumber: true });
  });
});
