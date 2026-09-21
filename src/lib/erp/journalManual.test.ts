// Comprobantes manuales: invariantes del asiento libre, alta con líneas,
// reversa (fecha, líneas invertidas, anulación) y formato del número.
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  cfg: vi.fn(),
  accounts: vi.fn(),
  centers: vi.fn(),
  findFirst: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  updateMany: vi.fn(),
  del: vi.fn(),
  deleteLines: vi.fn(),
}));

vi.mock("@/lib/db", () => {
  const tx = {
    journalEntry: {
      create: m.create,
      update: m.update,
      updateMany: m.updateMany,
      delete: m.del,
    },
    journalLine: { deleteMany: m.deleteLines },
  };
  return {
    db: {
      ledgerAccount: { findMany: m.accounts },
      costCenter: { findMany: m.centers },
      journalEntry: { findFirst: m.findFirst },
      $transaction: async (fn: (t: typeof tx) => unknown) => fn(tx),
    },
  };
});
vi.mock("./cierre", async (orig) => ({
  ...(await orig<typeof import("./cierre")>()),
  getAccountingConfig: m.cfg,
}));

import {
  createManualEntry,
  deleteManualEntry,
  formatVoucherNumber,
  reverseEntry,
  reversalDate,
  reversalMemo,
  updateManualEntry,
  validateManualEntry,
  type ManualEntryContext,
} from "./journalManual";

const ctx: ManualEntryContext = {
  closedThrough: "2026-06",
  accounts: new Map([
    ["110505", { id: "a-caja", active: true, postable: true }],
    ["519505", { id: "a-gasto", active: true, postable: true }],
    ["1105", { id: "a-padre", active: true, postable: false }],
    ["130505", { id: "a-inactiva", active: false, postable: true }],
  ]),
  costCenters: new Map([
    ["cc-1", { active: true }],
    ["cc-off", { active: false }],
  ]),
};

const good = {
  date: "2026-09-10",
  memo: "Ajuste de caja",
  lines: [
    { accountCode: "519505", debitCents: 10000, costCenterId: "cc-1" },
    { accountCode: "110505", creditCents: 10000 },
  ],
};

describe("validateManualEntry", () => {
  it("acepta un asiento cuadrado y lo normaliza", () => {
    const r = validateManualEntry(
      { ...good, thirdPartyName: "  Proveedor SAS ", thirdPartyTaxId: "900123456-1" },
      ctx,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.normalized.month).toBe("2026-09");
    expect(r.normalized.date.toISOString()).toBe("2026-09-10T12:00:00.000Z");
    expect(r.normalized.totalCents).toBe(10000);
    expect(r.normalized.thirdPartyName).toBe("Proveedor SAS");
    expect(r.normalized.lines[0]).toEqual({
      accountId: "a-gasto",
      accountCode: "519505",
      debitCents: 10000,
      creditCents: 0,
      costCenterId: "cc-1",
      memo: null,
    });
  });

  it("exige al menos dos líneas", () => {
    const r = validateManualEntry({ ...good, lines: [good.lines[0]!] }, ctx);
    expect(r).toEqual({ ok: false, error: "too_few_lines" });
  });

  it("rechaza una línea con débito Y crédito", () => {
    const r = validateManualEntry(
      {
        ...good,
        lines: [
          { accountCode: "519505", debitCents: 5000, creditCents: 5000 },
          { accountCode: "110505", creditCents: 0, debitCents: 0 },
        ],
      },
      ctx,
    );
    expect(r).toEqual({ ok: false, error: "line_both_sides", line: 1 });
  });

  it("rechaza una línea vacía y montos no enteros", () => {
    expect(
      validateManualEntry(
        { ...good, lines: [good.lines[0]!, { accountCode: "110505" }] },
        ctx,
      ),
    ).toEqual({ ok: false, error: "line_empty", line: 2 });
    expect(
      validateManualEntry(
        { ...good, lines: [good.lines[0]!, { accountCode: "110505", creditCents: 10.5 }] },
        ctx,
      ),
    ).toEqual({ ok: false, error: "line_invalid_amount", line: 2 });
  });

  it("rechaza el descuadre", () => {
    const r = validateManualEntry(
      {
        ...good,
        lines: [
          { accountCode: "519505", debitCents: 10000 },
          { accountCode: "110505", creditCents: 9000 },
        ],
      },
      ctx,
    );
    expect(r).toEqual({ ok: false, error: "unbalanced" });
  });

  it("rechaza fechas inválidas o normalizadas por JS", () => {
    expect(validateManualEntry({ ...good, date: "2026-02-31" }, ctx)).toEqual({
      ok: false,
      error: "invalid_date",
    });
    expect(validateManualEntry({ ...good, date: "10/09/2026" }, ctx)).toEqual({
      ok: false,
      error: "invalid_date",
    });
  });

  it("rechaza un mes cerrado (incluido el último cerrado)", () => {
    expect(validateManualEntry({ ...good, date: "2026-06-30" }, ctx)).toEqual({
      ok: false,
      error: "period_closed",
    });
    expect(validateManualEntry({ ...good, date: "2026-07-01" }, ctx).ok).toBe(true);
  });

  it("rechaza cuenta inexistente, no imputable e inactiva", () => {
    const lines = (code: string) => [
      { accountCode: code, debitCents: 100 },
      { accountCode: "110505", creditCents: 100 },
    ];
    expect(validateManualEntry({ ...good, lines: lines("999999") }, ctx)).toEqual({
      ok: false,
      error: "account_not_found",
      line: 1,
    });
    expect(validateManualEntry({ ...good, lines: lines("1105") }, ctx)).toEqual({
      ok: false,
      error: "account_not_postable",
      line: 1,
    });
    expect(validateManualEntry({ ...good, lines: lines("130505") }, ctx)).toEqual({
      ok: false,
      error: "account_inactive",
      line: 1,
    });
  });

  it("rechaza un centro de costos inexistente o inactivo", () => {
    const withCc = (cc: string) => ({
      ...good,
      lines: [{ ...good.lines[0]!, costCenterId: cc }, good.lines[1]!],
    });
    expect(validateManualEntry(withCc("cc-nope"), ctx)).toEqual({
      ok: false,
      error: "cost_center_not_found",
      line: 1,
    });
    expect(validateManualEntry(withCc("cc-off"), ctx)).toEqual({
      ok: false,
      error: "cost_center_not_found",
      line: 1,
    });
  });

  it("valida memo y tercero", () => {
    expect(validateManualEntry({ ...good, memo: "   " }, ctx)).toEqual({
      ok: false,
      error: "invalid_memo",
    });
    expect(validateManualEntry({ ...good, thirdPartyName: "X" }, ctx)).toEqual({
      ok: false,
      error: "invalid_third_party",
    });
    expect(
      validateManualEntry({ ...good, thirdPartyName: "Alguien", thirdPartyTaxId: "ABC" }, ctx),
    ).toEqual({ ok: false, error: "invalid_third_party" });
    // NIT sin nombre no identifica a nadie.
    expect(validateManualEntry({ ...good, thirdPartyTaxId: "900123456" }, ctx)).toEqual({
      ok: false,
      error: "invalid_third_party",
    });
  });
});

describe("formatVoucherNumber", () => {
  it("rellena a seis dígitos y devuelve vacío sin número", () => {
    expect(formatVoucherNumber(123)).toBe("#000123");
    expect(formatVoucherNumber(1234567)).toBe("#1234567");
    expect(formatVoucherNumber(null)).toBe("");
    expect(formatVoucherNumber(undefined)).toBe("");
  });
});

// ── Con DB mockeada ─────────────────────────────────────────────────────────

beforeEach(() => {
  vi.resetAllMocks();
  m.cfg.mockResolvedValue({ closedThrough: "2026-06", nextVoucherNumber: 10, uvtCents: 1 });
  m.accounts.mockResolvedValue(
    [...ctx.accounts.entries()].map(([code, a]) => ({ code, ...a })),
  );
  m.centers.mockResolvedValue([...ctx.costCenters.entries()].map(([id, c]) => ({ id, ...c })));
  m.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
    id: "e-new",
    ...data,
    lines: (data.lines as { create: unknown[] }).create,
  }));
  m.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
    id: "e-1",
    ...data,
  }));
});

describe("createManualEntry", () => {
  it("crea entrada + líneas en una transacción con source manual", async () => {
    const r = await createManualEntry({ restaurantId: "r1", actorId: "u1", input: good });
    expect(r.ok).toBe(true);
    expect(m.create).toHaveBeenCalledOnce();
    const data = m.create.mock.calls[0][0].data;
    expect(data).toMatchObject({
      restaurantId: "r1",
      source: "manual",
      memo: "Ajuste de caja",
      status: "posted",
      createdById: "u1",
      thirdPartyName: null,
    });
    // El sourceRef NUNCA tiene forma de mes: es lo que lo protege del
    // deleteMany({ source, sourceRef: month }) del motor (posting.ts).
    expect(typeof data.sourceRef).toBe("string");
    expect(data.sourceRef).not.toMatch(/^\d{4}-\d{2}$/);
    expect(data.lines.create).toEqual([
      expect.objectContaining({ accountId: "a-gasto", debitCents: 10000, costCenterId: "cc-1" }),
      expect.objectContaining({ accountId: "a-caja", creditCents: 10000, costCenterId: null }),
    ]);
  });

  it("devuelve el error de validación sin escribir", async () => {
    const r = await createManualEntry({
      restaurantId: "r1",
      actorId: null,
      input: { ...good, date: "2026-05-01" },
    });
    expect(r).toEqual({ ok: false, error: "period_closed" });
    expect(m.create).not.toHaveBeenCalled();
  });
});

const manualEntry = {
  id: "e-1",
  restaurantId: "r1",
  source: "manual",
  sourceRef: "uuid-1",
  date: new Date("2026-09-10T12:00:00.000Z"),
  memo: "Ajuste",
  status: "posted",
  voucherNumber: null,
  thirdPartyName: "Proveedor SAS",
  thirdPartyTaxId: "900123456",
  createdById: "u1",
  annulledAt: null,
  reversalOfId: null,
  createdAt: new Date("2026-09-10T15:00:00.000Z"),
  lines: [
    { id: "l1", entryId: "e-1", accountId: "a-gasto", accountCode: "519505", debitCents: 10000, creditCents: 0, costCenterId: "cc-1", memo: "x" },
    { id: "l2", entryId: "e-1", accountId: "a-caja", accountCode: "110505", debitCents: 0, creditCents: 10000, costCenterId: null, memo: null },
  ],
};

describe("updateManualEntry / deleteManualEntry", () => {
  it("reemplaza las líneas de un manual con el mes abierto", async () => {
    m.findFirst.mockResolvedValue(manualEntry);
    const r = await updateManualEntry({
      restaurantId: "r1",
      entryId: "e-1",
      input: { ...good, memo: "Ajuste corregido" },
    });
    expect(r.ok).toBe(true);
    expect(m.deleteLines).toHaveBeenCalledWith({ where: { entryId: "e-1" } });
    expect(m.update.mock.calls[0][0].data).toMatchObject({ memo: "Ajuste corregido" });
  });

  it("no toca asientos automáticos ni de meses cerrados", async () => {
    m.findFirst.mockResolvedValue({ ...manualEntry, source: "sale" });
    expect(await updateManualEntry({ restaurantId: "r1", entryId: "e-1", input: good })).toEqual({
      ok: false,
      error: "not_manual",
    });
    m.findFirst.mockResolvedValue({ ...manualEntry, date: new Date("2026-06-15T12:00:00Z") });
    expect(await deleteManualEntry({ restaurantId: "r1", entryId: "e-1" })).toEqual({
      ok: false,
      error: "period_closed",
    });
    expect(m.del).not.toHaveBeenCalled();
  });

  it("al borrar una reversa, el original vuelve a posted", async () => {
    m.findFirst.mockResolvedValue({ ...manualEntry, reversalOfId: "e-orig" });
    const r = await deleteManualEntry({ restaurantId: "r1", entryId: "e-1" });
    expect(r).toEqual({ ok: true });
    expect(m.del).toHaveBeenCalledWith({ where: { id: "e-1" } });
    expect(m.updateMany).toHaveBeenCalledWith({
      where: { id: "e-orig", restaurantId: "r1" },
      data: { annulledAt: null, status: "posted" },
    });
  });
});

describe("reversalDate / reversalMemo", () => {
  it("conserva la fecha si el mes está abierto; si no, primer día del mes abierto", () => {
    const open = new Date("2026-09-10T12:00:00.000Z");
    expect(reversalDate(open, "2026-06")).toBe(open);
    const closed = new Date("2026-03-15T12:00:00.000Z");
    expect(reversalDate(closed, "2026-06").toISOString()).toBe("2026-07-01T12:00:00.000Z");
    // Diciembre cerrado → enero del año siguiente.
    expect(reversalDate(closed, "2026-12").toISOString()).toBe("2027-01-01T12:00:00.000Z");
    expect(reversalDate(closed, null)).toBe(closed);
  });

  it("referencia el número o, sin número, la fecha", () => {
    expect(
      reversalMemo({ voucherNumber: 123, date: new Date("2026-03-15T12:00:00Z"), memo: "Ventas del mes" }),
    ).toBe("Reversa del comprobante #000123 — Ventas del mes");
    expect(reversalMemo({ voucherNumber: null, date: new Date("2026-09-10T12:00:00Z"), memo: null })).toBe(
      "Reversa del comprobante 2026-09-10",
    );
  });
});

describe("reverseEntry", () => {
  it("invierte las líneas, copia tercero y centros, y anula el original", async () => {
    const original = {
      ...manualEntry,
      id: "e-sale",
      source: "sale",
      date: new Date("2026-03-31T23:59:59.999Z"),
      voucherNumber: 7,
    };
    m.findFirst.mockResolvedValue(original);
    const r = await reverseEntry({ restaurantId: "r1", entryId: "e-sale", actorId: "u2" });
    expect(r.ok).toBe(true);
    const data = m.create.mock.calls[0][0].data;
    expect(data).toMatchObject({
      source: "manual",
      reversalOfId: "e-sale",
      createdById: "u2",
      thirdPartyName: "Proveedor SAS",
      thirdPartyTaxId: "900123456",
      memo: "Reversa del comprobante #000007 — Ajuste",
    });
    // Marzo está cerrado (closedThrough 2026-06) → 1 de julio.
    expect(data.date.toISOString()).toBe("2026-07-01T12:00:00.000Z");
    expect(data.lines.create).toEqual([
      { accountId: "a-gasto", accountCode: "519505", debitCents: 0, creditCents: 10000, costCenterId: "cc-1", memo: "x" },
      { accountId: "a-caja", accountCode: "110505", debitCents: 10000, creditCents: 0, costCenterId: null, memo: null },
    ]);
    expect(m.update).toHaveBeenCalledWith({
      where: { id: "e-sale" },
      data: { annulledAt: expect.any(Date), status: "annulled" },
    });
  });

  it("un manual de mes abierto se reversa con la misma fecha", async () => {
    m.findFirst.mockResolvedValue(manualEntry);
    const r = await reverseEntry({ restaurantId: "r1", entryId: "e-1", actorId: null });
    expect(r.ok).toBe(true);
    expect(m.create.mock.calls[0][0].data.date).toBe(manualEntry.date);
  });

  it("no reversa dos veces, ni una reversa, ni un automático de mes abierto", async () => {
    m.findFirst.mockResolvedValue({ ...manualEntry, annulledAt: new Date() });
    expect(await reverseEntry({ restaurantId: "r1", entryId: "e-1", actorId: null })).toEqual({
      ok: false,
      error: "already_annulled",
    });
    m.findFirst.mockResolvedValue({ ...manualEntry, reversalOfId: "e-0" });
    expect(await reverseEntry({ restaurantId: "r1", entryId: "e-1", actorId: null })).toEqual({
      ok: false,
      error: "is_reversal",
    });
    m.findFirst.mockResolvedValue({ ...manualEntry, source: "sale" });
    expect(await reverseEntry({ restaurantId: "r1", entryId: "e-1", actorId: null })).toEqual({
      ok: false,
      error: "not_manual",
    });
    m.findFirst.mockResolvedValue(null);
    expect(await reverseEntry({ restaurantId: "r1", entryId: "nope", actorId: null })).toEqual({
      ok: false,
      error: "not_found",
    });
    expect(m.create).not.toHaveBeenCalled();
  });
});
