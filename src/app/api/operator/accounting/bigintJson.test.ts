// Las columnas contables son BIGINT y Prisma las devuelve como `bigint`;
// `JSON.stringify` revienta con un `bigint` ("Do not know how to serialize a
// BigInt"). Estas rutas devolvían la fila de Prisma tal cual: el db mockeado
// entrega `bigint` como el real, y cada respuesta tiene que salir en JSON con
// centavos `number` exactos (montos de Son y Melona, > INT4).
import { beforeEach, describe, expect, it, vi } from "vitest";

const OCT = 24_179_580_000;

const m = vi.hoisted(() => ({
  cfg: vi.fn(),
  findFirst: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  deleteLines: vi.fn(),
  bankLines: vi.fn(),
  filings: vi.fn(),
  filingFirst: vi.fn(),
  filingCreate: vi.fn(),
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
vi.mock("@/lib/erp/ledger", async (orig) => ({
  ...(await orig<typeof import("@/lib/erp/ledger")>()),
  loadAccountMap: async () => new Map([["24080501", "a-iva"], ["241205", "a-inc"], ["111005", "a-banco"]]),
  loadAccountIndex: async () => new Map([["111005", { id: "a-banco", postable: true, active: true }]]),
}));
vi.mock("@/lib/db", () => {
  const tx = {
    journalEntry: { create: m.create, update: m.update },
    journalLine: { deleteMany: m.deleteLines },
    taxFiling: { create: m.filingCreate },
  };
  return {
    db: {
      ledgerAccount: {
        findMany: async () => [
          { id: "a-caja", code: "110505", active: true, postable: true },
          { id: "a-ing", code: "413505", active: true, postable: true },
        ],
      },
      costCenter: { findMany: async () => [] },
      journalEntry: { findFirst: m.findFirst },
      bankStatementLine: { findMany: m.bankLines },
      bankRecRule: { findMany: async () => [] },
      taxFiling: { findMany: m.filings, findFirst: m.filingFirst },
      $transaction: async (fn: (t: unknown) => unknown) => fn(tx),
    },
  };
});

import { POST as postEntry } from "./entries/route";
import { PUT as putEntry } from "./entries/[id]/route";
import { POST as reverseEntry } from "./entries/[id]/reverse/route";
import { GET as getBank } from "./bank/route";
import { GET as getFilings, POST as postFiling } from "./declaraciones/route";

type Handler = (req: Request, ctx?: unknown) => Promise<Response>;
const call = (h: unknown, req: Request, ctx?: unknown) => (h as Handler)(req, ctx);
const json = (url: string, method: string, body: unknown) =>
  new Request(`http://localhost${url}`, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const params = (id: string) => ({ params: Promise.resolve({ id }) });

/** Lo que devuelve Prisma al crear/actualizar: las líneas con centavos bigint. */
function prismaEntry({ data }: { data: Record<string, unknown> }) {
  const lines = (data.lines as { create: Array<Record<string, unknown>> }).create;
  return {
    id: "e-new",
    restaurantId: "r1",
    source: "manual",
    voucherNumber: null,
    annulledAt: null,
    reversalOfId: null,
    createdAt: new Date("2026-10-31T12:00:00Z"),
    ...data,
    lines: lines.map((l, i) => ({
      id: `l${i}`,
      entryId: "e-new",
      memo: null,
      costCenterId: null,
      ...l,
      debitCents: BigInt(Number(l.debitCents ?? 0)),
      creditCents: BigInt(Number(l.creditCents ?? 0)),
    })),
  };
}

const manual = {
  id: "e-1",
  restaurantId: "r1",
  source: "manual",
  sourceRef: "uuid-1",
  date: new Date("2026-10-15T12:00:00Z"),
  memo: "Aporte",
  status: "posted",
  voucherNumber: null,
  thirdPartyName: null,
  thirdPartyTaxId: null,
  createdById: null,
  annulledAt: null,
  reversalOfId: null,
  createdAt: new Date("2026-10-15T12:00:00Z"),
  lines: [
    { id: "l1", entryId: "e-1", accountId: "a-caja", accountCode: "110505", debitCents: BigInt(OCT), creditCents: BigInt(0), costCenterId: null, memo: null },
    { id: "l2", entryId: "e-1", accountId: "a-ing", accountCode: "413505", debitCents: BigInt(0), creditCents: BigInt(OCT), costCenterId: null, memo: null },
  ],
};

const bigLines = [
  { accountCode: "110505", debitCents: OCT },
  { accountCode: "413505", creditCents: OCT },
];

beforeEach(() => {
  vi.resetAllMocks();
  m.cfg.mockResolvedValue({ closedThrough: "2026-08", nextVoucherNumber: 1, uvtCents: 1 });
  m.create.mockImplementation(async (args: { data: Record<string, unknown> }) => prismaEntry(args));
  // PUT reemplaza las líneas; la reversa sólo marca el original como anulado.
  m.update.mockImplementation(async (args: { data: Record<string, unknown> }) =>
    args.data.lines ? prismaEntry(args) : { id: "e-1", ...args.data },
  );
});

describe("comprobantes manuales con montos > INT4", () => {
  it("POST crea y responde el comprobante en JSON con centavos number", async () => {
    const res = await call(postEntry, json("/api/operator/accounting/entries", "POST", { date: "2026-10-15", memo: "Aporte", lines: bigLines }));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.entry.lines.map((l: { debitCents: number; creditCents: number }) => [l.debitCents, l.creditCents])).toEqual([
      [OCT, 0],
      [0, OCT],
    ]);
    // Prisma recibe number (lo acepta para BigInt) con el monto exacto.
    expect(m.create.mock.calls[0]![0].data.lines.create).toEqual([
      expect.objectContaining({ debitCents: OCT, creditCents: 0 }),
      expect.objectContaining({ debitCents: 0, creditCents: OCT }),
    ]);
  });

  it("PUT reemplaza y responde en JSON", async () => {
    m.findFirst.mockResolvedValue(manual);
    const res = await call(putEntry, json("/api/operator/accounting/entries/e-1", "PUT", { date: "2026-10-16", memo: "Aporte", lines: bigLines }), params("e-1"));
    expect(res.status).toBe(200);
    expect((await res.json()).entry.lines[0].debitCents).toBe(OCT);
  });

  it("la reversa invierte los montos bigint del original y responde en JSON", async () => {
    m.findFirst.mockResolvedValue(manual);
    const res = await call(reverseEntry, new Request("http://localhost/x", { method: "POST" }), params("e-1"));
    expect(res.status).toBe(201);
    expect((await res.json()).entry.lines.map((l: { debitCents: number; creditCents: number }) => [l.debitCents, l.creditCents])).toEqual([
      [0, OCT],
      [OCT, 0],
    ]);
  });
});

describe("bancos y declaraciones con montos > INT4", () => {
  it("GET del extracto bancario responde las líneas pendientes en number", async () => {
    m.bankLines.mockResolvedValue([
      { id: "s1", restaurantId: "r1", date: new Date("2026-10-31T00:00:00Z"), description: "Abono datáfono", amountCents: BigInt(OCT), status: "pending", entryId: null, importBatch: "b", createdAt: new Date() },
    ]);
    const res = await call(getBank, new Request("http://localhost/api/operator/accounting/bank"));
    expect(res.status).toBe(200);
    expect((await res.json()).lines[0].amountCents).toBe(OCT);
  });

  it("GET de declaraciones responde el monto declarado en number", async () => {
    m.filings.mockResolvedValue([
      { id: "t1", restaurantId: "r1", form: "inc", period: "2026-10", declaredCents: BigInt(2_670_000_000), paidAt: new Date(), entryId: "e-t", notes: null, createdAt: new Date() },
    ]);
    const res = await call(getFilings, new Request("http://localhost/api/operator/accounting/declaraciones?year=2026"));
    expect((await res.json()).filings[0].declaredCents).toBe(2_670_000_000);
  });

  it("POST registra un bimestre de INC de más de $21 M y lo contabiliza exacto", async () => {
    m.filingFirst.mockResolvedValue(null);
    m.create.mockResolvedValue({ id: "e-t" });
    m.filingCreate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      id: "t1",
      createdAt: new Date(),
      ...data,
      declaredCents: BigInt(Number(data.declaredCents)),
    }));
    const res = await call(
      postFiling,
      json("/api/operator/accounting/declaraciones", "POST", { form: "inc", period: "2026-10", declaredCents: 2_670_000_000, paidDate: "2026-11-10" }),
    );
    expect(res.status).toBe(201);
    expect((await res.json()).filing.declaredCents).toBe(2_670_000_000);
    expect(m.create.mock.calls[0]![0].data.lines.create).toEqual([
      expect.objectContaining({ accountCode: "241205", debitCents: 2_670_000_000 }),
      expect.objectContaining({ accountCode: "111005", creditCents: 2_670_000_000 }),
    ]);
  });
});
