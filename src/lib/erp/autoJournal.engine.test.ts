// Corrida automática contra el motor REAL (posting.ts) sobre un libro en
// memoria: regenera los meses abiertos, deja intactos los meses cerrados
// (numerados) y nunca toca los comprobantes manuales.
import { beforeEach, describe, expect, it, vi } from "vitest";

type Entry = {
  id: string;
  restaurantId: string;
  date: Date;
  source: string;
  sourceRef: string | null;
  memo: string | null;
  voucherNumber: number | null;
  annulledAt: Date | null;
  createdAt: Date;
  lines: Array<{ accountCode: string; debitCents: number; creditCents: number }>;
};

const m = vi.hoisted(() => ({
  entries: [] as Entry[],
  closedThrough: null as string | null,
  /** Cobros del mes (efectivo) por mes "YYYY-MM". */
  cashByMonth: {} as Record<string, number>,
  seq: 0,
}));

vi.mock("@/lib/db", () => {
  const matches = (e: Entry, where: Record<string, unknown>): boolean => {
    for (const [k, v] of Object.entries(where)) {
      if (k === "OR") {
        if (!(v as Array<Record<string, unknown>>).some((w) => matches(e, w))) return false;
        continue;
      }
      const field = (e as unknown as Record<string, unknown>)[k];
      if (v && typeof v === "object" && !(v instanceof Date)) {
        const op = v as { in?: unknown[]; not?: unknown };
        if ("in" in op && !op.in!.includes(field)) return false;
        if ("not" in op && op.not === null && field == null) return false;
        continue;
      }
      if (field !== v) return false;
    }
    return true;
  };
  const journalEntry = {
    deleteMany: async ({ where }: { where: Record<string, unknown> }) => {
      const before = m.entries.length;
      m.entries = m.entries.filter((e) => !matches(e, where));
      return { count: before - m.entries.length };
    },
    create: async ({ data }: { data: Omit<Entry, "id" | "createdAt" | "voucherNumber" | "annulledAt" | "lines"> & { lines: { create: Entry["lines"] } } }) => {
      const entry: Entry = {
        ...data,
        id: `new-${++m.seq}`,
        voucherNumber: null,
        annulledAt: null,
        createdAt: new Date(),
        lines: data.lines.create,
      };
      m.entries.push(entry);
      return entry;
    },
    findMany: async ({ where }: { where: Record<string, unknown> }) =>
      m.entries.filter((e) => matches(e, where)),
  };
  const none = { aggregate: async () => ({ _min: {} }) };
  const tx = {
    journalEntry,
    creditNote: { updateMany: async () => ({ count: 0 }) },
    // El lock contable (siempre libre en este test).
    $queryRaw: async () => [{ locked: true }],
  };
  return {
    db: {
      journalEntry,
      accountingConfig: {
        upsert: async () => ({ uvtCents: 5_237_400, closedThrough: m.closedThrough, nextVoucherNumber: 3 }),
      },
      // Primera actividad: el cobro más antiguo.
      order: {
        aggregate: async () => {
          const months = Object.keys(m.cashByMonth).sort();
          return { _min: { paidAt: months[0] ? new Date(`${months[0]}-05T15:00:00Z`) : null } };
        },
      },
      purchaseOrder: none,
      purchasePayment: { ...none, findMany: async () => [] },
      expense: { ...none, findMany: async () => [] },
      expensePayment: { ...none, findMany: async () => [] },
      customerCreditPayment: { ...none, findMany: async () => [] },
      stockMovement: none,
      payrollRun: none,
      fixedAsset: none,
      deferredItem: { ...none, findMany: async () => [] },
      kushkiTransaction: { aggregate: async () => ({ _sum: { amountCents: 0 } }) },
      payment: {
        groupBy: async ({ where }: { where: { order: { paidAt: { gte: Date } } } }) => {
          const month = where.order.paidAt.gte.toISOString().slice(0, 7);
          const cents = m.cashByMonth[month] ?? 0;
          return cents ? [{ method: "cash", _sum: { amountCents: cents } }] : [];
        },
      },
      $transaction: async (fn: (t: unknown) => unknown) => fn(tx),
    },
  };
});
vi.mock("./accountingData", () => ({
  loadSalesBook: async () => ({ totals: { tipCents: 0 } }),
  loadPurchasesBook: async () => ({
    totals: {
      receivedCents: 0, incCents: 0, nonInventoryReceivedCents: 0, nonInventoryIncCents: 0,
      nonInventoryNonDeductibleTaxCents: 0, ivaCents: 0, retefuenteCents: 0, reteIvaCents: 0, reteIcaCents: 0,
    },
  }),
  computeTaxSummary: async () => ({ sales: { kind: "none", pct: 0, taxCents: 0, byRate: [] } }),
  computeMonthPnl: async () => ({ consumptionCents: 0, wasteCents: 0, labor: null }),
}));
vi.mock("./ledger", () => ({
  ensureChartOfAccounts: vi.fn(),
  loadAccountIndex: async () =>
    new Map(["110505", "413505"].map((c) => [c, { id: `id-${c}`, postable: true, active: true }])),
}));
vi.mock("./activos", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./activos")>()),
  depreciationLinesForMonth: async () => [],
}));
vi.mock("./payrollData", () => ({ payrollTotalsForPosting: async () => null }));
vi.mock("./creditNoteAccounting", () => ({
  loadCreditNoteMonthPosting: async () => ({ notes: [], noteIds: [] }),
  loadRefundMonthPosting: async () => ({ totalCents: 0, liabilityCents: 0 }),
}));

import { regenerateOpenMonths } from "./autoJournal";

const NOW = new Date("2026-10-20T10:30:00Z");
const OLD = new Date("2026-09-01T00:00:00Z");

function seed(e: Partial<Entry> & Pick<Entry, "id" | "source" | "sourceRef" | "date">): Entry {
  return {
    restaurantId: "r1",
    memo: null,
    voucherNumber: null,
    annulledAt: null,
    createdAt: OLD,
    lines: [],
    ...e,
  };
}

const ids = () => m.entries.map((e) => e.id).sort();

beforeEach(() => {
  m.seq = 0;
  m.closedThrough = "2026-08";
  m.cashByMonth = { "2026-08": 100_000, "2026-09": 200_000, "2026-10": 300_000 };
  m.entries = [
    // Agosto: CERRADO, numerado (motor + manual).
    seed({ id: "aug-sale", source: "sale", sourceRef: "2026-08", date: new Date("2026-08-31T23:59:59Z"), voucherNumber: 1 }),
    seed({ id: "aug-manual", source: "manual", sourceRef: "a1b2c3", date: new Date("2026-08-15T12:00:00Z"), voucherNumber: 2 }),
    // Septiembre: abierto, con un asiento del motor viejo y un manual.
    seed({ id: "sep-sale-stale", source: "sale", sourceRef: "2026-09", date: new Date("2026-09-30T23:59:59Z") }),
    seed({ id: "sep-manual", source: "manual", sourceRef: "d4e5f6", date: new Date("2026-09-10T12:00:00Z") }),
    // Un asiento de otro comercio, mismo mes y fuente.
    seed({ id: "other-sale", restaurantId: "r2", source: "sale", sourceRef: "2026-09", date: new Date("2026-09-30T23:59:59Z") }),
  ];
});

describe("regenerateOpenMonths contra el motor real", () => {
  it("regenera los meses abiertos, respeta el mes cerrado y no toca los comprobantes manuales", async () => {
    const run = await regenerateOpenMonths("r1", NOW);
    expect(run.status).toBe("done");
    expect(run.status === "done" && run.months.map((x) => [x.month, x.status])).toEqual([
      ["2026-09", "ok"],
      ["2026-10", "ok"],
    ]);
    // Agosto (cerrado) intacto con sus números; manuales intactos; el viejo
    // de septiembre reemplazado; el del otro comercio intacto.
    expect(ids()).toEqual(["aug-manual", "aug-sale", "new-1", "new-2", "other-sale", "sep-manual"]);
    const aug = m.entries.find((e) => e.id === "aug-sale")!;
    expect(aug.voucherNumber).toBe(1);
    const sep = m.entries.find((e) => e.id === "new-1")!;
    expect(sep).toMatchObject({ source: "sale", sourceRef: "2026-09", restaurantId: "r1" });
    expect(sep.lines).toEqual(
      expect.arrayContaining([expect.objectContaining({ accountCode: "110505", debitCents: 200_000 })]),
    );
    const oct = m.entries.find((e) => e.id === "new-2")!;
    expect(oct).toMatchObject({ source: "sale", sourceRef: "2026-10" });
  });

  it("idempotente: correrla dos veces deja un solo asiento por mes y fuente", async () => {
    await regenerateOpenMonths("r1", NOW);
    await regenerateOpenMonths("r1", NOW);
    const engineR1 = m.entries.filter((e) => e.restaurantId === "r1" && e.source === "sale");
    expect(engineR1.map((e) => e.sourceRef).sort()).toEqual(["2026-08", "2026-09", "2026-10"]);
    expect(m.entries.filter((e) => e.source === "manual")).toHaveLength(2);
  });

  it("un mes reabierto con comprobantes del motor numerados queda para el botón", async () => {
    // Se reabrió agosto: el candado retrocede a julio, los números siguen.
    m.closedThrough = "2026-07";
    const run = await regenerateOpenMonths("r1", NOW);
    expect(run.status === "done" && run.months.map((x) => [x.month, x.status])).toEqual([
      ["2026-08", "numbered"],
      ["2026-09", "ok"],
      ["2026-10", "ok"],
    ]);
    const aug = m.entries.find((e) => e.id === "aug-sale")!;
    expect(aug.voucherNumber).toBe(1);
  });
});

describe("montos de un comercio grande (BIGINT)", () => {
  /** Rango de la columna según el schema de Prisma (INT4 vs BIGINT). */
  async function fitsColumn(model: string, field: string, value: number): Promise<boolean> {
    const { Prisma } = await import("@prisma/client");
    const type = Prisma.dmmf.datamodel.models.find((x) => x.name === model)?.fields.find((f) => f.name === field)?.type;
    if (type === "BigInt") return Number.isSafeInteger(value);
    if (type === "Int") return Number.isInteger(value) && value >= -2_147_483_648 && value <= 2_147_483_647;
    return false;
  }

  it("las ventas de Son y Melona ($92 M y $241 M al mes) quedan en la línea con el monto exacto", async () => {
    m.cashByMonth = { "2026-08": 100_000, "2026-09": 9_208_811_100, "2026-10": 24_179_580_000 };
    const run = await regenerateOpenMonths("r1", NOW);
    expect(run.status === "done" && run.months.map((x) => [x.month, x.status])).toEqual([
      ["2026-09", "ok"],
      ["2026-10", "ok"],
    ]);
    for (const [month, cents] of [["2026-09", 9_208_811_100], ["2026-10", 24_179_580_000]] as const) {
      const entry = m.entries.find((e) => e.restaurantId === "r1" && e.source === "sale" && e.sourceRef === month)!;
      expect(entry.lines).toEqual(
        expect.arrayContaining([expect.objectContaining({ accountCode: "110505", debitCents: cents })]),
      );
      const debit = entry.lines.reduce((s, l) => s + l.debitCents, 0);
      const credit = entry.lines.reduce((s, l) => s + l.creditCents, 0);
      expect(debit).toBe(cents);
      expect(credit).toBe(cents);
      for (const l of entry.lines) {
        expect(await fitsColumn("JournalLine", "debitCents", l.debitCents)).toBe(true);
        expect(await fitsColumn("JournalLine", "creditCents", l.creditCents)).toBe(true);
      }
    }
  });
});
