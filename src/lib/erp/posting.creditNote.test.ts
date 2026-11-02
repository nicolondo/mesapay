// Asientos «Notas crédito» (source credit_note, uno por día FISCAL de las
// notas) y el cruce con «Devoluciones» (uno por día del reembolso):
// devoluciones en ventas + IVA/INC por tarifa contra Clientes (lo que
// canceló cartera) y «reintegros por pagar» (lo que se le debe al cliente);
// un reembolso posterior cancela ese pasivo en vez de volver a debitar
// devoluciones.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CreditNoteMonthPosting, RefundMonthPosting, RefundPosting } from "./creditNoteAccounting";

const m = vi.hoisted(() => ({
  createEntry: vi.fn(),
  deleteEntries: vi.fn(),
  noteUpdateMany: vi.fn(),
  creditNotes: vi.fn(),
  refunds: vi.fn(),
}));
vi.mock("@/lib/db", () => ({
  db: {
    // Comercio en INC 8 %: el régimen del mes para las devoluciones sin nota.
    restaurant: {
      findUnique: async () => ({ businessDayCutoffHour: 5, salesTaxKind: "inc", salesTaxPct: 8 }),
    },
    stockMovement: { findMany: async () => [] },
    expense: { findMany: async () => [] },
    expensePayment: { findMany: async () => [] },
    purchasePayment: { findMany: async () => [] },
    customerCreditPayment: { findMany: async () => [] },
    deferredItem: { findMany: async () => [] },
    $transaction: async (fn: (tx: unknown) => unknown) =>
      fn({
        journalEntry: { deleteMany: m.deleteEntries, create: m.createEntry },
        creditNote: { updateMany: m.noteUpdateMany },
      }),
  },
}));
vi.mock("./accountingData", () => ({
  loadSalesPostingOrders: async () => [],
  loadPurchasesBook: async () => ({ rows: [], totals: {} }),
  computeMonthLabor: async () => null,
}));
vi.mock("./ledger", () => ({
  ensureChartOfAccounts: vi.fn(),
  loadAccountIndex: async () =>
    new Map(
      ["112005", "130505", "238020", "241205", "24080501", "24080503", "417505"].map((c) => [
        c,
        { id: `id-${c}`, postable: true, active: true },
      ]),
    ),
}));
vi.mock("./activos", () => ({ depreciationLinesForMonth: async () => [] }));
vi.mock("./payrollData", () => ({ payrollTotalsForPosting: async () => null }));
vi.mock("./creditNoteAccounting", () => ({
  loadCreditNoteMonthPosting: m.creditNotes,
  loadRefundMonthPosting: m.refunds,
}));

import { generateJournalForMonth } from "./posting";

type Line = { accountCode: string; debitCents: number; creditCents: number };
type Created = { source: string; memo: string; sourceRef: string; date: Date; lines: { create: Line[] } };
const range = { from: new Date("2026-10-01"), to: new Date("2026-11-01") };

async function entries(): Promise<Created[]> {
  await generateJournalForMonth("r", "2026-10", range);
  return m.createEntry.mock.calls.map((c) => (c[0] as { data: Created }).data);
}
const debits = (lines: Line[]) => lines.reduce((s, l) => s + l.debitCents, 0);
const credits = (lines: Line[]) => lines.reduce((s, l) => s + l.creditCents, 0);
const posting = (p: Partial<CreditNoteMonthPosting>): CreditNoteMonthPosting => ({ notes: [], noteIds: [], ...p });
/** Reembolsos del mes (con su cruce ya hecho por pedido). */
const refunded = (list: Array<Partial<RefundPosting> & Pick<RefundPosting, "amountCents">>): RefundMonthPosting => {
  const refunds = list.map((r, i) => ({
    id: r.id ?? `k${i}`,
    createdAt: r.createdAt ?? new Date("2026-10-20T15:00:00Z"),
    amountCents: r.amountCents,
    liabilityCents: r.liabilityCents ?? 0,
  }));
  return {
    refunds,
    totalCents: refunds.reduce((s, r) => s + r.amountCents, 0),
    liabilityCents: refunds.reduce((s, r) => s + r.liabilityCents, 0),
  };
};

beforeEach(() => {
  vi.clearAllMocks();
  m.creditNotes.mockResolvedValue(posting({}));
  m.refunds.mockResolvedValue(refunded([]));
});

describe("asientos «Notas crédito»", () => {
  it("debita devoluciones por la base e IVA/INC por tarifa; acredita Clientes y reintegros por pagar; cuadra", async () => {
    m.creditNotes.mockResolvedValue(
      posting({
        noteIds: ["n1", "n2"],
        notes: [
          {
            // Nota sobre una cuenta a crédito con saldo: 60.000 cancelan cartera.
            id: "n1",
            fiscalDate: "2026-10-12",
            slices: [{ kind: "iva", pct: 19, baseCents: 100_000, taxCents: 19_000, grossCents: 119_000 }],
            receivableCents: 60_000,
            liabilityCents: 59_000,
          },
          {
            // Nota sobre una cuenta pagada con tarjeta: todo es pasivo con el cliente.
            id: "n2",
            fiscalDate: "2026-10-12",
            slices: [
              { kind: "inc", pct: 8, baseCents: 50_000, taxCents: 4_000, grossCents: 54_000 },
              { kind: "none", pct: 0, baseCents: 5_000, taxCents: 0, grossCents: 5_000 },
            ],
            receivableCents: 0,
            liabilityCents: 59_000,
          },
        ],
      }),
    );
    const entry = (await entries()).find((e) => e.source === "credit_note");
    expect(entry).toBeDefined();
    expect(entry!.memo).toBe("Notas crédito del día");
    expect(entry!.sourceRef).toBe("2026-10");
    expect(entry!.date).toEqual(new Date("2026-10-12T05:00:00.000Z"));
    const lines = entry!.lines.create;
    expect(lines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ accountCode: "417505", debitCents: 155_000, creditCents: 0 }),
        expect.objectContaining({ accountCode: "24080501", debitCents: 19_000, creditCents: 0 }),
        expect.objectContaining({ accountCode: "241205", debitCents: 4_000, creditCents: 0 }),
        expect.objectContaining({ accountCode: "130505", creditCents: 60_000, debitCents: 0 }),
        expect.objectContaining({ accountCode: "238020", creditCents: 118_000, debitCents: 0 }),
      ]),
    );
    expect(lines).toHaveLength(5);
    expect(debits(lines)).toBe(credits(lines));
    expect(debits(lines)).toBe(178_000);
    // Las notas quedan contabilizadas en el mes, en la misma transacción.
    expect(m.noteUpdateMany).toHaveBeenCalledWith({
      where: { restaurantId: "r", id: { in: ["n1", "n2"] }, OR: [{ postedMonth: null }, { postedMonth: "2026-10" }] },
      data: { postedMonth: "2026-10" },
    });
  });

  it("cada nota va al asiento de su día fiscal; una nota de otro mes (cerrado o fijada acá) va al último día", async () => {
    const note = (id: string, fiscalDate: string) => ({
      id,
      fiscalDate,
      slices: [{ kind: "inc" as const, pct: 8, baseCents: 10_000, taxCents: 800, grossCents: 10_800 }],
      receivableCents: 0,
      liabilityCents: 10_800,
    });
    m.creditNotes.mockResolvedValue(
      posting({
        noteIds: ["a", "b", "late"],
        notes: [note("a", "2026-10-03"), note("b", "2026-10-20"), note("late", "2026-09-28")],
      }),
    );
    const all = (await entries()).filter((e) => e.source === "credit_note");
    expect(all.map((e) => e.date.toISOString())).toEqual([
      "2026-10-03T05:00:00.000Z",
      "2026-10-20T05:00:00.000Z",
      "2026-10-31T05:00:00.000Z",
    ]);
    // Σ días == mes.
    expect(all.reduce((s, e) => s + debits(e.lines.create), 0)).toBe(3 * 10_800);
    // Todas marcadas en el mes, en una sola transacción de la fuente.
    expect(m.noteUpdateMany).toHaveBeenCalledTimes(1);
    expect(m.noteUpdateMany.mock.calls[0]![0].where.id.in).toEqual(["a", "b", "late"]);
  });

  it("sin notas del mes no hay asiento ni se marca nada", async () => {
    const all = await entries();
    expect(all.some((e) => e.source === "credit_note")).toBe(false);
    expect(m.noteUpdateMany).not.toHaveBeenCalled();
  });

  it("notas que ya cubrieron reembolsos anteriores: sin asiento, pero quedan contabilizadas en el mes", async () => {
    m.creditNotes.mockResolvedValue(
      posting({ noteIds: ["n1"], notes: [{ id: "n1", fiscalDate: "2026-10-05", slices: [], receivableCents: 0, liabilityCents: 0 }] }),
    );
    const all = await entries();
    expect(all.some((e) => e.source === "credit_note")).toBe(false);
    expect(m.deleteEntries).toHaveBeenCalledWith({ where: { restaurantId: "r", source: "credit_note", sourceRef: "2026-10" } });
    expect(m.noteUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { postedMonth: "2026-10" } }),
    );
  });
});

describe("asientos «Devoluciones» con notas crédito", () => {
  it("sin nota: devoluciones + impuesto embebido del régimen del mes contra pasarela (como antes)", async () => {
    m.refunds.mockResolvedValue(refunded([{ amountCents: 108_000 }]));
    const refund = (await entries()).find((e) => e.source === "refund")!;
    expect(refund.memo).toBe("Devoluciones del día");
    expect(refund.date).toEqual(new Date("2026-10-20T05:00:00.000Z"));
    expect(refund.lines.create).toEqual([
      expect.objectContaining({ accountCode: "417505", debitCents: 100_000 }),
      expect.objectContaining({ accountCode: "241205", debitCents: 8_000 }),
      expect.objectContaining({ accountCode: "112005", creditCents: 108_000 }),
    ]);
  });

  it("reembolso POSTERIOR a una nota: lo que la nota dejó por pagar debita reintegros, no devoluciones otra vez", async () => {
    // 119.000 de una nota del mes anterior + 10.800 de otro pedido sin nota, el mismo día.
    m.refunds.mockResolvedValue(
      refunded([
        { id: "with-note", amountCents: 119_000, liabilityCents: 119_000 },
        { id: "plain", amountCents: 10_800 },
      ]),
    );
    const lines = (await entries()).find((e) => e.source === "refund")!.lines.create;
    expect(lines).toEqual([
      expect.objectContaining({ accountCode: "417505", debitCents: 10_000 }),
      expect.objectContaining({ accountCode: "241205", debitCents: 800 }),
      expect.objectContaining({ accountCode: "238020", debitCents: 119_000 }),
      expect.objectContaining({ accountCode: "112005", creditCents: 129_800 }),
    ]);
    expect(debits(lines)).toBe(credits(lines));
  });

  it("reembolsos de días distintos: un asiento por día de negocio, y la suma es la del mes", async () => {
    m.refunds.mockResolvedValue(
      refunded([
        // 2 a. m. de Bogotá del 21 (07:00Z): con corte 5 sigue siendo el 20.
        { id: "a", amountCents: 50_000, createdAt: new Date("2026-10-21T07:00:00Z") },
        { id: "b", amountCents: 20_000, createdAt: new Date("2026-10-25T15:00:00Z"), liabilityCents: 20_000 },
      ]),
    );
    const all = (await entries()).filter((e) => e.source === "refund");
    expect(all.map((e) => e.date.toISOString())).toEqual(["2026-10-20T05:00:00.000Z", "2026-10-25T05:00:00.000Z"]);
    const pasarela = all.flatMap((e) => e.lines.create).filter((l) => l.accountCode === "112005");
    expect(pasarela.reduce((s, l) => s + l.creditCents, 0)).toBe(70_000);
    expect(all[1]!.lines.create).toEqual([
      expect.objectContaining({ accountCode: "238020", debitCents: 20_000 }),
      expect.objectContaining({ accountCode: "112005", creditCents: 20_000 }),
    ]);
  });

  it("nota + reembolso del mismo monto: devolución una sola vez y el pasivo queda en cero", async () => {
    m.creditNotes.mockResolvedValue(
      posting({
        noteIds: ["n1"],
        notes: [
          {
            id: "n1",
            fiscalDate: "2026-10-10",
            slices: [{ kind: "inc", pct: 8, baseCents: 100_000, taxCents: 8_000, grossCents: 108_000 }],
            receivableCents: 0,
            liabilityCents: 108_000,
          },
        ],
      }),
    );
    m.refunds.mockResolvedValue(refunded([{ amountCents: 108_000, liabilityCents: 108_000 }]));
    const all = await entries();
    const lines = all.flatMap((e) => e.lines.create);
    const net = (code: string) => lines.filter((l) => l.accountCode === code).reduce((s, l) => s + l.debitCents - l.creditCents, 0);
    expect(net("417505")).toBe(100_000); // devoluciones: una sola vez
    expect(net("241205")).toBe(8_000);
    expect(net("238020")).toBe(0); // el pasivo nace con la nota y lo cancela el reembolso
    expect(net("112005")).toBe(-108_000);
  });
});
