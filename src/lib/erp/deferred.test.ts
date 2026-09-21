// Diferidos: cronograma (mes de inicio inclusive, redondeo en la última
// cuota), cuota del mes con baja, progreso, validación del alta (prefijos,
// mes cerrado) y el asiento inicial por tipo.
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  cfg: vi.fn(),
  accounts: vi.fn(),
  centers: vi.fn(),
  items: vi.fn(),
  findFirst: vi.fn(),
  update: vi.fn(),
  createItem: vi.fn(),
  createEntry: vi.fn(),
}));

vi.mock("@/lib/db", () => {
  const tx = {
    deferredItem: { create: m.createItem },
    journalEntry: { create: m.createEntry },
  };
  return {
    db: {
      ledgerAccount: { findMany: m.accounts },
      costCenter: { findMany: m.centers },
      deferredItem: { findMany: m.items, findFirst: m.findFirst, update: m.update },
      $transaction: async (fn: (t: typeof tx) => unknown) => fn(tx),
    },
  };
});
vi.mock("./cierre", async (orig) => ({
  ...(await orig<typeof import("./cierre")>()),
  getAccountingConfig: m.cfg,
}));

import {
  amortizationForMonth,
  closeDeferredItem,
  createDeferredItem,
  deferredAmortizationLinesForMonth,
  deferredProgress,
  deferredSchedule,
  initialEntryLines,
  monthlyQuotaCents,
  validateDeferredInput,
  type DeferredContext,
  type DeferredInput,
} from "./deferred";

const twelve = { totalCents: 1_200_000, startDate: "2026-01-15T12:00:00.000Z", months: 12 };

describe("deferredSchedule", () => {
  it("la primera cuota cae en el MISMO mes de inicio y la vida cubre months meses", () => {
    const rows = deferredSchedule(twelve);
    expect(rows).toHaveLength(12);
    expect(rows[0]).toEqual({ month: "2026-01", amountCents: 100_000 });
    expect(rows[11]).toEqual({ month: "2026-12", amountCents: 100_000 });
    expect(rows.reduce((s, r) => s + r.amountCents, 0)).toBe(1_200_000);
  });

  it("cruza el año sin problemas", () => {
    const rows = deferredSchedule({ totalCents: 300, startDate: new Date("2026-11-20T12:00:00Z"), months: 3 });
    expect(rows.map((r) => r.month)).toEqual(["2026-11", "2026-12", "2027-01"]);
  });

  it("la ÚLTIMA cuota absorbe el residuo de redondeo (100000 / 3)", () => {
    const rows = deferredSchedule({ totalCents: 100_000, startDate: "2026-03-01T12:00:00Z", months: 3 });
    expect(monthlyQuotaCents({ totalCents: 100_000, startDate: "2026-03-01", months: 3 })).toBe(33_333);
    expect(rows.map((r) => r.amountCents)).toEqual([33_333, 33_333, 33_334]);
    expect(rows.reduce((s, r) => s + r.amountCents, 0)).toBe(100_000);
  });

  it("cuando la cuota redondea hacia arriba, la última lleva lo que falta", () => {
    // 100 / 3 → cuota 33; 33+33+34. 200 / 3 → cuota 67; 67+67+66.
    expect(deferredSchedule({ totalCents: 200, startDate: "2026-01-01", months: 3 }).map((r) => r.amountCents))
      .toEqual([67, 67, 66]);
  });

  it("nunca amortiza más del total aunque la cuota redondeada lo supere", () => {
    // 10 / 4 → cuota 3 (2.5 redondea a 3): 3+3+3+1.
    const rows = deferredSchedule({ totalCents: 10, startDate: "2026-01-01", months: 4 });
    expect(rows.map((r) => r.amountCents)).toEqual([3, 3, 3, 1]);
  });

  it("un solo mes: todo el total en el mes de inicio", () => {
    expect(deferredSchedule({ totalCents: 5_000, startDate: "2026-05-31", months: 1 }))
      .toEqual([{ month: "2026-05", amountCents: 5_000 }]);
  });

  it("sin meses o sin total no hay cronograma", () => {
    expect(deferredSchedule({ totalCents: 0, startDate: "2026-01-01", months: 12 })).toEqual([]);
    expect(deferredSchedule({ totalCents: 100, startDate: "2026-01-01", months: 0 })).toEqual([]);
  });
});

describe("amortizationForMonth", () => {
  const active = { ...twelve, status: "active", closedAt: null };

  it("devuelve la cuota dentro de la vida y 0 fuera de rango", () => {
    expect(amortizationForMonth(active, "2025-12")).toBe(0);
    expect(amortizationForMonth(active, "2026-01")).toBe(100_000);
    expect(amortizationForMonth(active, "2026-12")).toBe(100_000);
    expect(amortizationForMonth(active, "2027-01")).toBe(0);
  });

  it("dado de baja: amortiza hasta el mes de la baja inclusive y después 0", () => {
    const closed = { ...twelve, status: "closed", closedAt: new Date("2026-04-10T15:00:00Z") };
    expect(amortizationForMonth(closed, "2026-03")).toBe(100_000);
    expect(amortizationForMonth(closed, "2026-04")).toBe(100_000);
    expect(amortizationForMonth(closed, "2026-05")).toBe(0);
  });
});

describe("deferredProgress", () => {
  const active = { ...twelve, status: "active", closedAt: null };

  it("acumula hasta el mes pedido inclusive", () => {
    expect(deferredProgress(active, "2026-03")).toEqual({
      amortizedCents: 300_000,
      balanceCents: 900_000,
      postedMonths: 3,
      months: 12,
    });
  });

  it("antes del inicio nada; después del final todo", () => {
    expect(deferredProgress(active, "2025-06").amortizedCents).toBe(0);
    expect(deferredProgress(active, "2027-06")).toMatchObject({
      amortizedCents: 1_200_000,
      balanceCents: 0,
      postedMonths: 12,
    });
  });

  it("dado de baja: el saldo queda congelado desde el mes siguiente a la baja", () => {
    const closed = { ...twelve, status: "closed", closedAt: new Date("2026-04-10T15:00:00Z") };
    expect(deferredProgress(closed, "2026-09")).toEqual({
      amortizedCents: 400_000,
      balanceCents: 800_000,
      postedMonths: 4,
      months: 12,
    });
  });
});

describe("deferredAmortizationLinesForMonth", () => {
  beforeEach(() => vi.resetAllMocks());

  it("agrega por cuenta y centro: expense D destino / C puente; income D puente / C destino", async () => {
    m.items.mockResolvedValue([
      {
        kind: "expense", totalCents: 1_200_000, startDate: new Date("2026-01-15T12:00:00Z"), months: 12,
        deferralAccountCode: "170505", targetAccountCode: "513005", costCenterId: "cc-1",
        status: "active", closedAt: null,
      },
      {
        kind: "expense", totalCents: 600_000, startDate: new Date("2026-02-01T12:00:00Z"), months: 6,
        deferralAccountCode: "170505", targetAccountCode: "513005", costCenterId: "cc-1",
        status: "active", closedAt: null,
      },
      {
        kind: "income", totalCents: 300_000, startDate: new Date("2026-03-01T12:00:00Z"), months: 3,
        deferralAccountCode: "270505", targetAccountCode: "429505", costCenterId: null,
        status: "active", closedAt: null,
      },
      // Fuera de rango este mes.
      {
        kind: "expense", totalCents: 100, startDate: new Date("2026-08-01T12:00:00Z"), months: 1,
        deferralAccountCode: "170595", targetAccountCode: "519505", costCenterId: null,
        status: "active", closedAt: null,
      },
    ]);
    const lines = await deferredAmortizationLinesForMonth("r1", "2026-03");
    expect(lines).toEqual([
      { code: "513005", debit: 200_000, costCenterId: "cc-1" },
      { code: "270505", debit: 100_000, costCenterId: null },
      { code: "170505", credit: 200_000, costCenterId: "cc-1" },
      { code: "429505", credit: 100_000, costCenterId: null },
    ]);
    expect(m.items.mock.calls[0][0].where).toEqual({ restaurantId: "r1" });
  });

  it("sin diferidos que amorticen devuelve lista vacía", async () => {
    m.items.mockResolvedValue([]);
    expect(await deferredAmortizationLinesForMonth("r1", "2026-03")).toEqual([]);
  });
});

const ctx: DeferredContext = {
  closedThrough: "2026-06",
  accounts: new Map([
    ["110505", { id: "a-caja", active: true, postable: true }],
    ["111005", { id: "a-banco", active: true, postable: true }],
    ["1105", { id: "a-madre", active: true, postable: false }],
    ["170505", { id: "a-seguros-ant", active: true, postable: true }],
    ["170595", { id: "a-inactiva", active: false, postable: true }],
    ["270505", { id: "a-ing-ant", active: true, postable: true }],
    ["513005", { id: "a-seguros", active: true, postable: true }],
    ["613505", { id: "a-costo", active: true, postable: true }],
    ["429505", { id: "a-ing-div", active: true, postable: true }],
    ["220505", { id: "a-prov", active: true, postable: true }],
  ]),
  costCenters: new Map([
    ["cc-1", { active: true }],
    ["cc-off", { active: false }],
  ]),
};

const good: DeferredInput = {
  name: "Seguro anual del local",
  kind: "expense",
  totalCents: 1_200_000,
  startDate: "2026-09-15",
  months: 12,
  sourceAccountCode: "111005",
  deferralAccountCode: "170505",
  targetAccountCode: "513005",
  costCenterId: "cc-1",
  notes: "  Póliza 123 ",
};

describe("validateDeferredInput", () => {
  it("acepta un alta válida y la normaliza", () => {
    const r = validateDeferredInput(good, ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.normalized).toMatchObject({
      name: "Seguro anual del local",
      kind: "expense",
      totalCents: 1_200_000,
      month: "2026-09",
      months: 12,
      sourceAccount: { code: "111005", id: "a-banco" },
      deferralAccount: { code: "170505", id: "a-seguros-ant" },
      targetAccount: { code: "513005", id: "a-seguros" },
      costCenterId: "cc-1",
      notes: "Póliza 123",
    });
    expect(r.normalized.startDate.toISOString()).toBe("2026-09-15T12:00:00.000Z");
  });

  it.each<[Partial<DeferredInput>, string]>([
    [{ name: "x" }, "invalid_name"],
    [{ name: "x".repeat(121) }, "invalid_name"],
    [{ kind: "other" as never }, "invalid_kind"],
    [{ totalCents: 0 }, "invalid_total"],
    [{ totalCents: 10.5 }, "invalid_total"],
    [{ months: 0 }, "invalid_months"],
    [{ months: 121 }, "invalid_months"],
    [{ months: 2.5 }, "invalid_months"],
    [{ startDate: "2026-02-31" }, "invalid_date"],
    [{ startDate: "2026-06-30" }, "period_closed"],
    // Origen: debe ser 11xx imputable.
    [{ sourceAccountCode: "220505" }, "source_account_invalid"],
    [{ sourceAccountCode: "1105" }, "source_account_invalid"],
    [{ sourceAccountCode: "119999" }, "source_account_invalid"],
    // Puente: 17 para gasto; inactiva no vale.
    [{ deferralAccountCode: "270505" }, "deferral_account_invalid"],
    [{ deferralAccountCode: "170595" }, "deferral_account_invalid"],
    // Destino: 5/6 para gasto.
    [{ targetAccountCode: "429505" }, "target_account_invalid"],
    [{ costCenterId: "cc-off" }, "cost_center_not_found"],
    [{ costCenterId: "cc-nope" }, "cost_center_not_found"],
  ])("rechaza %o con %s", (patch, error) => {
    expect(validateDeferredInput({ ...good, ...patch }, ctx)).toEqual({ ok: false, error });
  });

  it("para un ingreso exige puente 27 y destino 4", () => {
    const income: DeferredInput = {
      ...good,
      kind: "income",
      sourceAccountCode: "110505",
      deferralAccountCode: "270505",
      targetAccountCode: "429505",
      costCenterId: null,
    };
    expect(validateDeferredInput(income, ctx).ok).toBe(true);
    expect(validateDeferredInput({ ...income, deferralAccountCode: "170505" }, ctx))
      .toEqual({ ok: false, error: "deferral_account_invalid" });
    expect(validateDeferredInput({ ...income, targetAccountCode: "513005" }, ctx))
      .toEqual({ ok: false, error: "target_account_invalid" });
  });

  it("el destino de un gasto puede ser un costo (clase 6)", () => {
    expect(validateDeferredInput({ ...good, targetAccountCode: "613505" }, ctx).ok).toBe(true);
  });

  it("sin candado de cierre cualquier mes vale", () => {
    expect(validateDeferredInput({ ...good, startDate: "2024-01-01" }, { ...ctx, closedThrough: null }).ok)
      .toBe(true);
  });
});

describe("initialEntryLines", () => {
  it("expense: Debe puente / Haber origen, con el centro en ambas", () => {
    const v = validateDeferredInput(good, ctx);
    if (!v.ok) throw new Error("válido");
    expect(initialEntryLines(v.normalized)).toEqual([
      { accountId: "a-seguros-ant", accountCode: "170505", debitCents: 1_200_000, creditCents: 0, costCenterId: "cc-1" },
      { accountId: "a-banco", accountCode: "111005", debitCents: 0, creditCents: 1_200_000, costCenterId: "cc-1" },
    ]);
  });

  it("income: Debe origen / Haber puente", () => {
    const v = validateDeferredInput(
      { ...good, kind: "income", deferralAccountCode: "270505", targetAccountCode: "429505", costCenterId: null },
      ctx,
    );
    if (!v.ok) throw new Error("válido");
    expect(initialEntryLines(v.normalized)).toEqual([
      { accountId: "a-banco", accountCode: "111005", debitCents: 1_200_000, creditCents: 0, costCenterId: null },
      { accountId: "a-ing-ant", accountCode: "270505", debitCents: 0, creditCents: 1_200_000, costCenterId: null },
    ]);
  });
});

describe("createDeferredItem", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    m.cfg.mockResolvedValue({ closedThrough: "2026-06", nextVoucherNumber: 1, uvtCents: 1 });
    m.accounts.mockResolvedValue(
      [...ctx.accounts].map(([code, a]) => ({ code, ...a })),
    );
    m.centers.mockResolvedValue([...ctx.costCenters].map(([id, c]) => ({ id, ...c })));
    m.createItem.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      id: "def-1",
      ...data,
      status: "active",
      closedAt: null,
      createdAt: new Date("2026-09-20T00:00:00Z"),
    }));
    m.createEntry.mockResolvedValue({ id: "entry-1" });
  });

  it("crea el ítem y el asiento inicial por el total en la misma transacción", async () => {
    const r = await createDeferredItem({ restaurantId: "r1", actorId: "user-1", input: good });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.entryId).toBe("entry-1");
    expect(r.item.id).toBe("def-1");
    expect(m.createItem.mock.calls[0][0].data).toMatchObject({
      restaurantId: "r1",
      name: "Seguro anual del local",
      kind: "expense",
      totalCents: 1_200_000,
      months: 12,
      sourceAccountCode: "111005",
      deferralAccountCode: "170505",
      targetAccountCode: "513005",
      costCenterId: "cc-1",
      notes: "Póliza 123",
      createdById: "user-1",
    });
    const entry = m.createEntry.mock.calls[0][0].data;
    expect(entry).toMatchObject({
      restaurantId: "r1",
      source: "deferred_item",
      sourceRef: "def-1",
      memo: "Registro diferido Seguro anual del local",
      status: "posted",
      createdById: "user-1",
    });
    expect(entry.date.toISOString()).toBe("2026-09-15T12:00:00.000Z");
    expect(entry.lines.create).toEqual([
      expect.objectContaining({ accountCode: "170505", debitCents: 1_200_000, costCenterId: "cc-1" }),
      expect.objectContaining({ accountCode: "111005", creditCents: 1_200_000, costCenterId: "cc-1" }),
    ]);
  });

  it("income: el asiento inicial debita el origen y acredita la puente 27", async () => {
    const r = await createDeferredItem({
      restaurantId: "r1",
      actorId: null,
      input: { ...good, kind: "income", deferralAccountCode: "270505", targetAccountCode: "429505", costCenterId: null },
    });
    expect(r.ok).toBe(true);
    const lines = m.createEntry.mock.calls[0][0].data.lines.create;
    expect(lines).toEqual([
      expect.objectContaining({ accountCode: "111005", debitCents: 1_200_000, creditCents: 0 }),
      expect.objectContaining({ accountCode: "270505", debitCents: 0, creditCents: 1_200_000 }),
    ]);
  });

  it("mes de inicio cerrado → period_closed sin escribir nada", async () => {
    const r = await createDeferredItem({
      restaurantId: "r1",
      actorId: null,
      input: { ...good, startDate: "2026-05-01" },
    });
    expect(r).toEqual({ ok: false, error: "period_closed" });
    expect(m.createItem).not.toHaveBeenCalled();
    expect(m.createEntry).not.toHaveBeenCalled();
  });

  it("cuenta puente con prefijo equivocado → deferral_account_invalid", async () => {
    const r = await createDeferredItem({
      restaurantId: "r1",
      actorId: null,
      input: { ...good, deferralAccountCode: "513005" },
    });
    expect(r).toEqual({ ok: false, error: "deferral_account_invalid" });
    expect(m.createItem).not.toHaveBeenCalled();
  });
});

describe("closeDeferredItem", () => {
  beforeEach(() => vi.resetAllMocks());

  it("marca closed con closedAt y no toca el libro", async () => {
    m.findFirst.mockResolvedValue({ id: "def-1", restaurantId: "r1", status: "active" });
    m.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      id: "def-1",
      ...data,
    }));
    const r = await closeDeferredItem({ restaurantId: "r1", id: "def-1" });
    expect(r.ok).toBe(true);
    expect(m.findFirst.mock.calls[0][0].where).toEqual({ id: "def-1", restaurantId: "r1" });
    expect(m.update.mock.calls[0][0].data.status).toBe("closed");
    expect(m.update.mock.calls[0][0].data.closedAt).toBeInstanceOf(Date);
    expect(m.createEntry).not.toHaveBeenCalled();
  });

  it("ya cerrado → already_closed; de otro comercio → not_found", async () => {
    m.findFirst.mockResolvedValueOnce({ id: "def-1", status: "closed" });
    expect(await closeDeferredItem({ restaurantId: "r1", id: "def-1" }))
      .toEqual({ ok: false, error: "already_closed" });
    m.findFirst.mockResolvedValueOnce(null);
    expect(await closeDeferredItem({ restaurantId: "r1", id: "def-x" }))
      .toEqual({ ok: false, error: "not_found" });
    expect(m.update).not.toHaveBeenCalled();
  });
});
