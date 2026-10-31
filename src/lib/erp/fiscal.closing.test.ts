// Cierre del ejercicio: un comprobante NUMERADO nunca se borra. Antes,
// regenerar el cierre con diciembre cerrado borraba el comprobante ya
// numerado y creaba otro sin número (hueco en el consecutivo).
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  findFirst: vi.fn(),
  groupBy: vi.fn(),
  entryDeleteMany: vi.fn(),
  entryCreate: vi.fn(),
  entryUpdate: vi.fn(),
  lineDeleteMany: vi.fn(),
  cfg: vi.fn(),
}));

vi.mock("@/lib/db", () => {
  const tx = {
    journalEntry: { deleteMany: m.entryDeleteMany, create: m.entryCreate, update: m.entryUpdate },
    journalLine: { deleteMany: m.lineDeleteMany },
  };
  return {
    db: {
      journalEntry: { findFirst: m.findFirst, deleteMany: m.entryDeleteMany },
      journalLine: { groupBy: m.groupBy },
      $transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
    },
  };
});
vi.mock("./ledger", () => ({
  ensureChartOfAccounts: async () => undefined,
  loadAccountMap: async () =>
    new Map(["413505", "510506", "360505", "361005"].map((c) => [c, `acc-${c}`])),
}));
vi.mock("./cierre", async (orig) => ({
  ...(await orig<typeof import("./cierre")>()),
  getAccountingConfig: m.cfg,
}));

import { closingLinesFrom, generateYearClosing, sameClosingLines } from "./fiscal";

/** Año con $1.000.000 de ingresos y $600.000 de gastos: utilidad $400.000. */
const BALANCES = [
  { accountCode: "413505", _sum: { debitCents: 0, creditCents: 1_000_000 } },
  { accountCode: "510506", _sum: { debitCents: 600_000, creditCents: 0 } },
  { accountCode: "110505", _sum: { debitCents: 400_000, creditCents: 0 } },
];
/** Lo que el asiento de cierre lleva para esos saldos. */
const CLOSING_LINES = [
  { accountCode: "413505", debitCents: 1_000_000, creditCents: 0 },
  { accountCode: "510506", debitCents: 0, creditCents: 600_000 },
  { accountCode: "360505", debitCents: 0, creditCents: 400_000 },
];

function existing(over: Partial<{ voucherNumber: number | null; status: string; lines: typeof CLOSING_LINES }> = {}) {
  return { id: "close-2026", voucherNumber: 57, status: "posted", lines: CLOSING_LINES, ...over };
}

beforeEach(() => {
  vi.resetAllMocks();
  m.groupBy.mockResolvedValue(BALANCES);
  m.cfg.mockResolvedValue({ uvtCents: 0, closedThrough: "2026-12", nextVoucherNumber: 58 });
  m.entryCreate.mockResolvedValue({});
  m.entryUpdate.mockResolvedValue({});
});

describe("closingLinesFrom", () => {
  it("cancela 4/5/6 con lo opuesto a su saldo y lleva el neto a utilidad o pérdida", () => {
    const { lines, netCents } = closingLinesFrom(
      BALANCES.map((b) => ({ accountCode: b.accountCode, ...b._sum })),
    );
    expect(netCents).toBe(400_000);
    expect(sameClosingLines(CLOSING_LINES, lines)).toBe(true);
    const loss = closingLinesFrom([{ accountCode: "510506", debitCents: 50_000, creditCents: 0 }]);
    expect(loss.lines).toEqual([
      { code: "510506", credit: 50_000 },
      { code: "361005", debit: 50_000 },
    ]);
  });
});

describe("generateYearClosing — comprobante numerado", () => {
  it("diciembre cerrado y saldos iguales: no toca nada (regenerar es inocuo)", async () => {
    m.findFirst.mockResolvedValueOnce(existing()).mockResolvedValueOnce({
      date: new Date("2026-12-31T23:59:59.999Z"),
      lines: CLOSING_LINES,
    });
    const res = await generateYearClosing("r1", "2026");
    expect(res).toMatchObject({ ok: true, closing: { exists: true, resultCents: 400_000, kind: "utilidad" } });
    expect(m.entryDeleteMany).not.toHaveBeenCalled();
    expect(m.lineDeleteMany).not.toHaveBeenCalled();
    expect(m.entryCreate).not.toHaveBeenCalled();
  });

  it("diciembre cerrado y saldos distintos: bloquea con el número, sin borrar", async () => {
    m.findFirst.mockResolvedValue(
      existing({ lines: [{ accountCode: "413505", debitCents: 900_000, creditCents: 0 }] }),
    );
    const res = await generateYearClosing("r1", "2026");
    expect(res).toEqual({ ok: false, error: "closing_locked", voucherNumber: 57 });
    expect(m.entryDeleteMany).not.toHaveBeenCalled();
    expect(m.lineDeleteMany).not.toHaveBeenCalled();
    expect(m.entryUpdate).not.toHaveBeenCalled();
  });

  it("diciembre reabierto: reescribe el MISMO comprobante y conserva su número", async () => {
    m.cfg.mockResolvedValue({ uvtCents: 0, closedThrough: "2026-11", nextVoucherNumber: 58 });
    m.findFirst
      .mockResolvedValueOnce(existing({ lines: [{ accountCode: "413505", debitCents: 900_000, creditCents: 0 }] }))
      .mockResolvedValueOnce({ date: new Date("2026-12-31T23:59:59.999Z"), lines: CLOSING_LINES });
    const res = await generateYearClosing("r1", "2026");
    expect(res.ok).toBe(true);
    expect(m.entryDeleteMany).not.toHaveBeenCalled();
    expect(m.entryCreate).not.toHaveBeenCalled();
    expect(m.lineDeleteMany).toHaveBeenCalledWith({ where: { entryId: "close-2026" } });
    const update = m.entryUpdate.mock.calls[0]![0];
    expect(update.where).toEqual({ id: "close-2026" });
    // No se toca el número: el update no lleva voucherNumber.
    expect(update.data).not.toHaveProperty("voucherNumber");
    expect(update.data.status).toBe("posted");
    expect(update.data.lines.create).toHaveLength(3);
  });

  it("diciembre reabierto y el año quedó sin resultado: el comprobante queda ANULADO, no borrado", async () => {
    m.cfg.mockResolvedValue({ uvtCents: 0, closedThrough: "2026-11", nextVoucherNumber: 58 });
    m.groupBy.mockResolvedValue([]);
    m.findFirst.mockResolvedValueOnce(existing()).mockResolvedValueOnce(null);
    const res = await generateYearClosing("r1", "2026");
    expect(res).toMatchObject({ ok: true, closing: { exists: false } });
    expect(m.entryDeleteMany).not.toHaveBeenCalled();
    expect(m.entryUpdate.mock.calls[0]![0].data).toMatchObject({ status: "annulled" });
  });
});

describe("generateYearClosing — sin número", () => {
  it("se reemplaza como siempre, pero el borrado sólo alcanza al que sigue sin número", async () => {
    m.findFirst.mockResolvedValue(existing({ voucherNumber: null }));
    const res = await generateYearClosing("r1", "2026");
    expect(res).toMatchObject({ ok: true, closing: { exists: true, resultCents: 400_000 } });
    expect(m.entryDeleteMany).toHaveBeenCalledWith({
      where: { restaurantId: "r1", source: "closing", sourceRef: "2026", voucherNumber: null },
    });
    expect(m.entryCreate).toHaveBeenCalledTimes(1);
  });
});
