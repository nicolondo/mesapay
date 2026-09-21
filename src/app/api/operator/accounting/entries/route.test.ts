// POST /accounting/entries: el asiento manual pasa por las invariantes del
// motor (cuadre, cuentas, mes abierto) y se persiste con source "manual".
import { beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({
  cfg: vi.fn(),
  create: vi.fn(),
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
    ledgerAccount: {
      findMany: async () => [
        { id: "a-caja", code: "110505", active: true, postable: true },
        { id: "a-gasto", code: "519505", active: true, postable: true },
      ],
    },
    costCenter: { findMany: async () => [] },
    $transaction: async (fn: (tx: unknown) => unknown) =>
      fn({ journalEntry: { create: m.create } }),
  },
}));
import { POST } from "./route";

const post = (body: unknown) =>
  POST(
    new Request("http://localhost/api/operator/accounting/entries", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

const base = {
  date: "2026-09-10",
  memo: "Ajuste de caja",
  lines: [
    { accountCode: "519505", debitCents: 10000 },
    { accountCode: "110505", creditCents: 10000 },
  ],
};

beforeEach(() => {
  vi.resetAllMocks();
  m.cfg.mockResolvedValue({ closedThrough: "2026-06", nextVoucherNumber: 1, uvtCents: 1 });
  m.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
    id: "e-new",
    ...data,
    lines: (data.lines as { create: unknown[] }).create,
  }));
});

describe("POST /accounting/entries", () => {
  it("rechaza el cuerpo malformado", async () => {
    const res = await post({ memo: "x" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid" });
  });

  it("rechaza el descuadre con 400 unbalanced", async () => {
    const res = await post({
      ...base,
      lines: [
        { accountCode: "519505", debitCents: 10000 },
        { accountCode: "110505", creditCents: 9000 },
      ],
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "unbalanced" });
    expect(m.create).not.toHaveBeenCalled();
  });

  it("devuelve la línea que falla", async () => {
    const res = await post({
      ...base,
      lines: [
        { accountCode: "519505", debitCents: 10000 },
        { accountCode: "999999", creditCents: 10000 },
      ],
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "account_not_found", line: 2 });
  });

  it("rechaza un mes cerrado con 409", async () => {
    const res = await post({ ...base, date: "2026-06-15" });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "period_closed" });
  });

  it("crea el comprobante manual (201)", async () => {
    const res = await post({ ...base, thirdPartyName: "Proveedor SAS", thirdPartyTaxId: "900123456-1" });
    expect(res.status).toBe(201);
    expect(m.create).toHaveBeenCalledOnce();
    expect(m.create.mock.calls[0][0].data).toMatchObject({
      restaurantId: "r1",
      source: "manual",
      status: "posted",
      createdById: "user-1",
      thirdPartyName: "Proveedor SAS",
      thirdPartyTaxId: "900123456-1",
    });
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.entry.id).toBe("e-new");
    expect(body.entry.lines).toHaveLength(2);
  });
});
