// POST /accounting/entries/[id]/reverse: no se reversa dos veces, y la
// reversa de un mes cerrado cae en el primer mes abierto.
import { beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({
  cfg: vi.fn(),
  findFirst: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
}));
vi.mock("@/lib/secureApi", () => ({ secureApi: (h: unknown) => h }));
vi.mock("@/lib/erp/access", () => ({
  getErpContext: async () => ({ restaurantId: "r1", userId: "user-1" }),
  isDenied: () => false,
}));
vi.mock("@/lib/erp/cierre", async (orig) => ({
  ...(await orig<typeof import("@/lib/erp/cierre")>()),
  getAccountingConfig: m.cfg,
}));
vi.mock("@/lib/db", () => ({
  db: {
    journalEntry: { findFirst: m.findFirst },
    $transaction: async (fn: (tx: unknown) => unknown) =>
      fn({ journalEntry: { create: m.create, update: m.update } }),
  },
}));
import { POST } from "./route";

const post = (id: string) =>
  POST(
    new Request(`http://localhost/api/operator/accounting/entries/${id}/reverse`, {
      method: "POST",
    }),
    { params: Promise.resolve({ id }) },
  );

const sale = {
  id: "e-sale",
  restaurantId: "r1",
  source: "sale",
  sourceRef: "2026-03",
  date: new Date("2026-03-31T23:59:59.999Z"),
  memo: "Ventas del mes",
  status: "posted",
  voucherNumber: 12,
  thirdPartyName: null,
  thirdPartyTaxId: null,
  createdById: null,
  annulledAt: null,
  reversalOfId: null,
  createdAt: new Date("2026-04-01T00:00:00Z"),
  lines: [
    { id: "l1", entryId: "e-sale", accountId: "a-caja", accountCode: "110505", debitCents: 5000, creditCents: 0, costCenterId: null, memo: null },
    { id: "l2", entryId: "e-sale", accountId: "a-ing", accountCode: "413505", debitCents: 0, creditCents: 5000, costCenterId: null, memo: null },
  ],
};

beforeEach(() => {
  vi.resetAllMocks();
  m.cfg.mockResolvedValue({ closedThrough: "2026-06", nextVoucherNumber: 20, uvtCents: 1 });
  m.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
    id: "e-rev",
    ...data,
    lines: (data.lines as { create: unknown[] }).create,
  }));
});

describe("POST /accounting/entries/[id]/reverse", () => {
  it("409 already_annulled si ya fue reversado", async () => {
    m.findFirst.mockResolvedValue({ ...sale, annulledAt: new Date(), status: "annulled" });
    const res = await post("e-sale");
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "already_annulled" });
    expect(m.create).not.toHaveBeenCalled();
  });

  it("409 is_reversal si es una reversa", async () => {
    m.findFirst.mockResolvedValue({ ...sale, source: "manual", reversalOfId: "e-0" });
    const res = await post("e-sale");
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "is_reversal" });
  });

  it("404 si no es del comercio", async () => {
    m.findFirst.mockResolvedValue(null);
    expect((await post("ajeno")).status).toBe(404);
  });

  it("reversa un automático de mes cerrado en el primer mes abierto (201)", async () => {
    m.findFirst.mockResolvedValue(sale);
    const res = await post("e-sale");
    expect(res.status).toBe(201);
    const data = m.create.mock.calls[0][0].data;
    expect(data).toMatchObject({
      source: "manual",
      reversalOfId: "e-sale",
      createdById: "user-1",
      memo: "Reversa del comprobante #000012 — Ventas del mes",
    });
    expect(data.date.toISOString()).toBe("2026-07-01T12:00:00.000Z");
    expect(data.lines.create).toEqual([
      expect.objectContaining({ accountCode: "110505", debitCents: 0, creditCents: 5000 }),
      expect.objectContaining({ accountCode: "413505", debitCents: 5000, creditCents: 0 }),
    ]);
    expect(m.update).toHaveBeenCalledWith({
      where: { id: "e-sale" },
      data: { annulledAt: expect.any(Date), status: "annulled" },
    });
    expect((await res.json()).entry.id).toBe("e-rev");
  });
});
