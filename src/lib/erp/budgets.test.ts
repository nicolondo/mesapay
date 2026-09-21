// Presupuestos por cuenta y mes: la fila mensual gana sobre la anual, lo real
// se suma por PREFIJO y en NATURALEZA, el filtro por centro sólo aplica a los
// presupuestos por centro, semáforo con un decimal y unicidad por alcance.
import { beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({
  findFirst: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  deleteMany: vi.fn(),
}));
vi.mock("@/lib/db", () => ({
  db: {
    ledgerAccount: {
      findMany: async () => [
        { code: "51", name: "Operacionales de administración", nature: "debito", active: true },
        { code: "513505", name: "Aseo y vigilancia", nature: "debito", active: true },
        { code: "41", name: "Operacionales", nature: "credito", active: true },
        { code: "99", name: "Inactiva", nature: "debito", active: false },
      ],
    },
    costCenter: {
      findMany: async () => [
        { id: "cc-cocina", active: true },
        { id: "cc-off", active: false },
      ],
    },
    budget: { findFirst: m.findFirst, create: m.create, update: m.update, deleteMany: m.deleteMany },
  },
}));
import { Prisma } from "@prisma/client";
import {
  budgetStatus,
  budgetVsActual,
  budgetsForMonth,
  deleteBudget,
  pctExecution,
  upsertBudget,
  validateBudgetInput,
  type BudgetRow,
} from "./budgets";

const row = (over: Partial<BudgetRow> & { id: string }): BudgetRow => ({
  accountCode: "51",
  costCenterId: null,
  month: null,
  year: 2026,
  monthlyCents: 1_000_000,
  ...over,
});

const accounts = new Map([
  ["51", { name: "Operacionales de administración", nature: "debito" as const }],
  ["41", { name: "Operacionales", nature: "credito" as const }],
]);
const centers = new Map([
  ["cc-cocina", "Cocina"],
  ["cc-bar", "Bar"],
]);

describe("budgetsForMonth", () => {
  it("la fila mensual gana sobre la anual de la misma cuenta/centro", () => {
    const anual = row({ id: "a", month: null, monthlyCents: 100 });
    const sep = row({ id: "s", month: 9, monthlyCents: 200 });
    expect(budgetsForMonth([anual, sep], 9)).toEqual([sep]);
    expect(budgetsForMonth([sep, anual], 9)).toEqual([sep]);
    // En otro mes aplica la anual.
    expect(budgetsForMonth([anual, sep], 10)).toEqual([anual]);
  });

  it("descarta los meses ajenos y conserva alcances distintos", () => {
    const general = row({ id: "g", month: 9 });
    const cocina = row({ id: "c", month: 9, costCenterId: "cc-cocina" });
    const otraCuenta = row({ id: "o", month: 9, accountCode: "41" });
    const octubre = row({ id: "x", month: 10 });
    expect(budgetsForMonth([general, cocina, otraCuenta, octubre], 9).map((b) => b.id)).toEqual([
      "g",
      "c",
      "o",
    ]);
  });
});

describe("budgetVsActual", () => {
  const line = (accountCode: string, debit: number, credit = 0, cc: string | null = null) => ({
    accountCode,
    debitCents: debit,
    creditCents: credit,
    costCenterId: cc,
  });

  it("suma por PREFIJO: un presupuesto en 51 cubre todo 51xx y nada más", () => {
    const rows = budgetVsActual({
      budgets: [row({ id: "b", month: 9 })],
      lines: [line("513505", 300), line("519505", 200), line("613505", 900), line("52", 50)],
      accounts,
      centers,
      month: 9,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.actualCents).toBe(500);
    expect(rows[0]!.accountName).toBe("Operacionales de administración");
  });

  it("lleva lo real a NATURALEZA: gasto D−C, ingreso C−D", () => {
    const rows = budgetVsActual({
      budgets: [row({ id: "g", month: 9 }), row({ id: "i", month: 9, accountCode: "41" })],
      lines: [line("513505", 500, 50), line("413505", 100, 1000)],
      accounts,
      centers,
      month: 9,
    });
    const byCode = new Map(rows.map((r) => [r.accountCode, r]));
    expect(byCode.get("41")!.actualCents).toBe(900);
    expect(byCode.get("51")!.actualCents).toBe(450);
  });

  it("sin la cuenta en el plan usa la naturaleza de la clase PUC", () => {
    const rows = budgetVsActual({
      budgets: [row({ id: "i", month: 9, accountCode: "42" })],
      lines: [line("421005", 0, 700)],
      accounts: new Map(),
      centers,
      month: 9,
    });
    expect(rows[0]!.actualCents).toBe(700);
    expect(rows[0]!.accountName).toBe("—");
  });

  it("filtra por centro SÓLO cuando el presupuesto es por centro", () => {
    const rows = budgetVsActual({
      budgets: [
        row({ id: "general", month: 9 }),
        row({ id: "cocina", month: 9, costCenterId: "cc-cocina" }),
      ],
      lines: [line("513505", 300, 0, "cc-cocina"), line("513505", 200, 0, "cc-bar"), line("519505", 100)],
      accounts,
      centers,
      month: 9,
    });
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get("general")!.actualCents).toBe(600);
    expect(byId.get("cocina")!.actualCents).toBe(300);
    expect(byId.get("cocina")!.costCenterName).toBe("Cocina");
    expect(byId.get("general")!.costCenterName).toBeNull();
  });

  it("variación, % con un decimal y semáforo", () => {
    const rows = budgetVsActual({
      budgets: [
        row({ id: "ok", month: 9, monthlyCents: 1000 }),
        row({ id: "warn", month: 9, accountCode: "52", monthlyCents: 1000 }),
        row({ id: "over", month: 9, accountCode: "53", monthlyCents: 1000 }),
        row({ id: "none", month: 9, accountCode: "54", monthlyCents: 0 }),
      ],
      lines: [line("5105", 333), line("5205", 950), line("5305", 1010), line("5405", 10)],
      accounts,
      centers,
      month: 9,
    });
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get("ok")).toMatchObject({ varianceCents: 667, pct: 33.3, status: "ok" });
    expect(byId.get("warn")).toMatchObject({ varianceCents: 50, pct: 95, status: "warn" });
    expect(byId.get("over")).toMatchObject({ varianceCents: -10, pct: 101, status: "over" });
    expect(byId.get("none")).toMatchObject({ varianceCents: -10, pct: null, status: null });
  });

  it("ordena por código de cuenta y, dentro, el general primero y luego por nombre del centro", () => {
    const rows = budgetVsActual({
      budgets: [
        row({ id: "51-cocina", month: 9, costCenterId: "cc-cocina" }),
        row({ id: "41", month: 9, accountCode: "41" }),
        row({ id: "51-bar", month: 9, costCenterId: "cc-bar" }),
        row({ id: "51", month: 9 }),
      ],
      lines: [],
      accounts,
      centers,
      month: 9,
    });
    expect(rows.map((r) => r.id)).toEqual(["41", "51", "51-bar", "51-cocina"]);
  });
});

describe("pctExecution / budgetStatus", () => {
  it("umbrales exactos: 90 ok, 100 warn, 100.1 over", () => {
    expect(budgetStatus(pctExecution(900, 1000))).toBe("ok");
    expect(budgetStatus(pctExecution(1000, 1000))).toBe("warn");
    expect(budgetStatus(pctExecution(1001, 1000))).toBe("over");
    expect(pctExecution(1001, 1000)).toBe(100.1);
    expect(pctExecution(5, 0)).toBeNull();
  });
});

describe("validateBudgetInput", () => {
  const ctx = {
    accounts: new Map([
      ["51", { active: true }],
      ["99", { active: false }],
    ]),
    costCenters: new Map([
      ["cc-cocina", { active: true }],
      ["cc-off", { active: false }],
    ]),
  };
  const good = { accountCode: "51", costCenterId: null, year: 2026, month: 9, amountCents: 1000 };

  it("acepta y normaliza (trim, centro vacío → null)", () => {
    const r = validateBudgetInput({ ...good, accountCode: " 51 ", costCenterId: "" }, ctx);
    expect(r).toEqual({
      ok: true,
      normalized: { accountCode: "51", costCenterId: null, year: 2026, month: 9, amountCents: 1000 },
    });
  });

  it.each([
    [{ year: 1999 }, "invalid_year"],
    [{ month: 13 }, "invalid_month"],
    [{ month: 0 }, "invalid_month"],
    [{ amountCents: -1 }, "invalid_amount"],
    [{ amountCents: 1.5 }, "invalid_amount"],
    [{ accountCode: "77" }, "account_not_found"],
    [{ accountCode: "99" }, "account_not_found"],
    [{ accountCode: "51;drop" }, "account_not_found"],
    [{ costCenterId: "cc-nope" }, "cost_center_not_found"],
    [{ costCenterId: "cc-off" }, "cost_center_not_found"],
  ])("rechaza %o con %s", (patch, error) => {
    expect(validateBudgetInput({ ...good, ...patch }, ctx)).toEqual({ ok: false, error });
  });

  it("mes null = todo el año", () => {
    expect(validateBudgetInput({ ...good, month: null }, ctx)).toMatchObject({
      ok: true,
      normalized: { month: null },
    });
  });
});

describe("upsertBudget (unicidad por alcance)", () => {
  const saved = {
    id: "b1",
    restaurantId: "r1",
    year: 2026,
    month: 9,
    accountCode: "51",
    costCenterId: null,
    monthlyCents: 500,
    updatedAt: new Date(),
    costCenter: null,
  };
  beforeEach(() => {
    vi.resetAllMocks();
    m.update.mockResolvedValue(saved);
    m.create.mockResolvedValue(saved);
  });

  it("si ya existe la fila del alcance, actualiza el valor (no crea otra)", async () => {
    m.findFirst.mockResolvedValue({ id: "b1" });
    const r = await upsertBudget("r1", { accountCode: "51", year: 2026, month: 9, amountCents: 500 });
    expect(r).toMatchObject({ ok: true, created: false, budget: { id: "b1", monthlyCents: 500 } });
    expect(m.findFirst).toHaveBeenCalledWith({
      where: { restaurantId: "r1", year: 2026, month: 9, accountCode: "51", costCenterId: null },
      select: { id: true },
    });
    expect(m.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "b1" }, data: { monthlyCents: 500 } }),
    );
    expect(m.create).not.toHaveBeenCalled();
  });

  it("sin fila previa crea una con el alcance completo (anual + centro)", async () => {
    m.findFirst.mockResolvedValue(null);
    const r = await upsertBudget("r1", {
      accountCode: "51",
      costCenterId: "cc-cocina",
      year: 2026,
      month: null,
      amountCents: 700,
    });
    expect(r).toMatchObject({ ok: true, created: true });
    expect(m.create.mock.calls[0][0].data).toEqual({
      restaurantId: "r1",
      year: 2026,
      month: null,
      accountCode: "51",
      costCenterId: "cc-cocina",
      monthlyCents: 700,
    });
    expect(m.update).not.toHaveBeenCalled();
  });

  it("devuelve el código de validación sin tocar la DB", async () => {
    const r = await upsertBudget("r1", { accountCode: "77", year: 2026, month: 9, amountCents: 1 });
    expect(r).toEqual({ ok: false, error: "account_not_found" });
    expect(m.findFirst).not.toHaveBeenCalled();
  });

  it("carrera contra el índice Budget_scope_key → duplicate", async () => {
    m.findFirst.mockResolvedValue(null);
    m.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("dup", { code: "P2002", clientVersion: "6" }),
    );
    const r = await upsertBudget("r1", { accountCode: "51", year: 2026, month: 9, amountCents: 1 });
    expect(r).toEqual({ ok: false, error: "duplicate" });
  });
});

describe("deleteBudget", () => {
  it("borra sólo del comercio; 0 filas → not_found", async () => {
    m.deleteMany.mockResolvedValue({ count: 0 });
    expect(await deleteBudget("r1", "b9")).toEqual({ ok: false, error: "not_found" });
    expect(m.deleteMany).toHaveBeenCalledWith({ where: { id: "b9", restaurantId: "r1" } });
    m.deleteMany.mockResolvedValue({ count: 1 });
    expect(await deleteBudget("r1", "b1")).toEqual({ ok: true });
  });
});
