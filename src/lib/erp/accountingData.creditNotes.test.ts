// Libro de ventas: las notas crédito aceptadas del mes (por fecha FISCAL,
// día colombiano) entran como documentos que restan; las que no cuadran al
// centavo se excluyen igual que en contabilidad e impuestos.
import { describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ findMany: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: { creditNote: { findMany: m.findMany } } }));

import { loadSalesBookCreditNotes } from "./accountingData";

const row = (id: string, issuedAt: string, over: Partial<{ totalCents: number }> = {}) => ({
  id,
  documentNumber: `NC${id}`,
  subtotalCents: 10_000,
  taxCents: 800,
  totalCents: over.totalCents ?? 10_800,
  createdAt: new Date(issuedAt),
  dianDocument: { issuedAt: new Date(issuedAt) },
  snapshot: {
    original: { invoiceNumber: "FE9", customer: { name: "ACME S.A.S." } },
    lines: [{ lineTotalCents: 10_000, taxCents: 800, grossCents: 10_800, taxPct: "8.00", taxSchemeId: "04" }],
  },
});

describe("loadSalesBookCreditNotes", () => {
  it("toma la fecha fiscal colombiana, filtra el mes y excluye la nota que no cuadra", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    m.findMany.mockResolvedValue([
      row("1", "2026-10-01T03:00:00Z"), // 30-sep en Bogotá: septiembre
      row("2", "2026-09-15T15:00:00Z"),
      row("3", "2026-09-16T15:00:00Z", { totalCents: 10_801 }), // no cuadra
      row("4", "2026-08-31T15:00:00Z"), // agosto
    ]);
    const notes = await loadSalesBookCreditNotes("r1", {
      from: new Date("2026-09-01T00:00:00Z"),
      to: new Date("2026-10-01T00:00:00Z"),
    });
    expect(notes).toEqual([
      expect.objectContaining({ id: "2", date: "2026-09-15", invoiceNumber: "FE9", customerName: "ACME S.A.S.", totalCents: 10_800 }),
      expect.objectContaining({ id: "1", date: "2026-09-30", documentNumber: "NC1" }),
    ]);
    expect(m.findMany.mock.calls[0]![0].where).toMatchObject({
      restaurantId: "r1",
      abandonedAt: null,
      dianDocument: { is: { state: "accepted" } },
    });
    spy.mockRestore();
  });
});
