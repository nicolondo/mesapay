// Reglas del plan de cuentas: jerarquía por código, validación de altas,
// resolución de auxiliares para el motor, export reimportable y el alta con
// traslado de movimientos cuando la madre era imputable.
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  findMany: vi.fn(),
  findUnique: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  count: vi.fn(),
  lineUpdateMany: vi.fn(),
  lineCount: vi.fn(),
  refs: {
    expense: vi.fn(),
    expensePayment: vi.fn(),
    purchasePayment: vi.fn(),
    retentionConcept: vi.fn(),
    bankRecRule: vi.fn(),
    budget: vi.fn(),
    fixedAsset: vi.fn(),
  },
}));
vi.mock("@/lib/db", () => ({
  db: {
    $transaction: async (fn: (tx: unknown) => unknown) =>
      fn({
        ledgerAccount: {
          findMany: m.findMany,
          findUnique: m.findUnique,
          create: m.create,
          update: m.update,
          count: m.count,
        },
        journalLine: { updateMany: m.lineUpdateMany, count: m.lineCount },
        expense: { updateMany: m.refs.expense },
        expensePayment: { updateMany: m.refs.expensePayment },
        purchasePayment: { updateMany: m.refs.purchasePayment },
        retentionConcept: { updateMany: m.refs.retentionConcept },
        bankRecRule: { updateMany: m.refs.bankRecRule },
        budget: { updateMany: m.refs.budget },
        fixedAsset: { updateMany: m.refs.fixedAsset },
      }),
  },
}));

import {
  chartToCsv,
  createAccount,
  levelForCode,
  natureForType,
  parentCodeFor,
  resolvePostableCode,
  typeForCode,
  updateAccount,
  validateNewAccount,
  type PlanAccount,
} from "./chart";
import { parseChartCsv } from "./chartImport";

const acc = (
  code: string,
  over: Partial<PlanAccount> = {},
): PlanAccount => ({
  code,
  name: `Cuenta ${code}`,
  type: "activo",
  nature: "debito",
  postable: code.length >= 6,
  active: true,
  ...over,
});

const PLAN: PlanAccount[] = [
  acc("1"),
  acc("11"),
  acc("1110"),
  acc("111005", { name: "Bancos" }),
  acc("1105"),
  acc("110505", { name: "Caja general" }),
  acc("2", { type: "pasivo", nature: "credito" }),
  acc("23", { type: "pasivo", nature: "credito" }),
  acc("2380", { type: "pasivo", nature: "credito" }),
  acc("238030", { type: "pasivo", nature: "credito", name: "Propinas por pagar" }),
];

describe("jerarquía por código", () => {
  it("levelForCode: 1/2/4/6/8+ → 1..5", () => {
    expect(levelForCode("1")).toBe(1);
    expect(levelForCode("11")).toBe(2);
    expect(levelForCode("1110")).toBe(3);
    expect(levelForCode("111005")).toBe(4);
    expect(levelForCode("11100501")).toBe(5);
    expect(levelForCode("1110050101")).toBe(5);
  });

  it("parentCodeFor: prefijo de la longitud inmediata inferior", () => {
    expect(parentCodeFor("1")).toBeNull();
    expect(parentCodeFor("11")).toBe("1");
    expect(parentCodeFor("1110")).toBe("11");
    expect(parentCodeFor("111005")).toBe("1110");
    expect(parentCodeFor("11100501")).toBe("111005");
    expect(parentCodeFor("1110050101")).toBe("11100501");
  });

  it("typeForCode: por clase; 7 es costo; 8/9 no se permiten", () => {
    expect(typeForCode("110505")).toBe("activo");
    expect(typeForCode("2205")).toBe("pasivo");
    expect(typeForCode("3105")).toBe("patrimonio");
    expect(typeForCode("4135")).toBe("ingreso");
    expect(typeForCode("5135")).toBe("gasto");
    expect(typeForCode("6135")).toBe("costo");
    expect(typeForCode("7105")).toBe("costo");
    expect(typeForCode("8105")).toBeNull();
    expect(typeForCode("9105")).toBeNull();
  });

  it("natureForType", () => {
    expect(natureForType("activo")).toBe("debito");
    expect(natureForType("gasto")).toBe("debito");
    expect(natureForType("costo")).toBe("debito");
    expect(natureForType("pasivo")).toBe("credito");
    expect(natureForType("patrimonio")).toBe("credito");
    expect(natureForType("ingreso")).toBe("credito");
  });
});

describe("validateNewAccount", () => {
  it("acepta una auxiliar bien formada y devuelve la madre", () => {
    const v = validateNewAccount(
      { code: "11100501", name: "Bancolombia ahorros", parentCode: "111005" },
      PLAN,
    );
    expect(v).toMatchObject({ ok: true, code: "11100501", parent: { code: "111005" } });
  });

  it("rechaza un código tomado", () => {
    expect(
      validateNewAccount({ code: "111005", name: "Otra", parentCode: "1110" }, PLAN),
    ).toEqual({ ok: false, error: "code_taken" });
  });

  it("rechaza una madre inexistente o inactiva", () => {
    expect(
      validateNewAccount({ code: "11200501", name: "Nueva", parentCode: "112005" }, PLAN),
    ).toEqual({ ok: false, error: "bad_parent" });
    const plan = [...PLAN, acc("112005", { active: false })];
    expect(
      validateNewAccount({ code: "11200501", name: "Nueva", parentCode: "112005" }, plan),
    ).toEqual({ ok: false, error: "bad_parent" });
  });

  it("rechaza un código que no extiende a la madre con dos dígitos", () => {
    expect(
      validateNewAccount({ code: "11050501", name: "Nueva", parentCode: "111005" }, PLAN),
    ).toEqual({ ok: false, error: "bad_prefix" });
    // Nieta directa (salta la subcuenta) tampoco.
    expect(
      validateNewAccount({ code: "11100501", name: "Nueva", parentCode: "1110" }, PLAN),
    ).toEqual({ ok: false, error: "bad_prefix" });
  });

  it("rechaza longitudes inválidas, no numéricos y clases 8/9", () => {
    for (const code of ["11", "1110050", "111005011", "111005010101", "11A005", ""]) {
      expect(
        validateNewAccount({ code, name: "Nueva", parentCode: "1110" }, PLAN),
      ).toEqual({ ok: false, error: "bad_code" });
    }
    expect(
      validateNewAccount({ code: "810505", name: "Nueva", parentCode: "8105" }, PLAN),
    ).toEqual({ ok: false, error: "bad_code" });
  });

  it("rechaza nombres cortos o larguísimos", () => {
    expect(
      validateNewAccount({ code: "11100501", name: "A", parentCode: "111005" }, PLAN),
    ).toEqual({ ok: false, error: "bad_name" });
    expect(
      validateNewAccount(
        { code: "11100501", name: "x".repeat(121), parentCode: "111005" },
        PLAN,
      ),
    ).toEqual({ ok: false, error: "bad_name" });
  });

  it("normaliza espacios y guiones del código", () => {
    const v = validateNewAccount(
      { code: " 1110-05-01 ", name: "Bancolombia", parentCode: "111005" },
      PLAN,
    );
    expect(v).toMatchObject({ ok: true, code: "11100501" });
  });
});

describe("resolvePostableCode (pickLeafDescendant)", () => {
  const idx = (rows: Array<[string, boolean, boolean?]>) =>
    new Map(rows.map(([code, postable, active]) => [code, { postable, active: active ?? true }]));

  it("una cuenta imputable se resuelve a sí misma", () => {
    expect(resolvePostableCode(idx([["111005", true]]), "111005")).toBe("111005");
  });

  it("una madre con una sola hija imputable → la hija", () => {
    const i = idx([["111005", false], ["11100501", true]]);
    expect(resolvePostableCode(i, "111005")).toBe("11100501");
  });

  it("con varias hijas gana la convención código+05, si no la de menor código", () => {
    const i = idx([["111005", false], ["11100510", true], ["11100505", true], ["11100501", true]]);
    expect(resolvePostableCode(i, "111005")).toBe("11100505");
    const j = idx([["111005", false], ["11100510", true], ["11100502", true]]);
    expect(resolvePostableCode(j, "111005")).toBe("11100502");
  });

  it("baja varios niveles y salta las hijas inactivas", () => {
    const i = idx([["111005", false], ["11100501", false], ["1110050101", true], ["11100502", true, false]]);
    expect(resolvePostableCode(i, "111005")).toBe("1110050101");
  });

  it("sin hijas imputables o cuenta inexistente → null", () => {
    expect(resolvePostableCode(idx([["111005", false]]), "111005")).toBeNull();
    expect(resolvePostableCode(idx([]), "111005")).toBeNull();
    // Acepta también la lista plana del plan.
    expect(resolvePostableCode([{ code: "111005", postable: true }], "111005")).toBe("111005");
  });
});

describe("chartToCsv ↔ parseChartCsv", () => {
  it("el export se reimporta sin perder código, nombre, naturaleza ni imputabilidad", () => {
    const plan: PlanAccount[] = [
      ...PLAN,
      acc("159205", { name: "Depreciación acumulada; equipo", nature: "credito" }),
      acc("1110050101", { name: 'Cuenta "especial"' }),
      acc("11100501", { postable: false }),
    ];
    const csv = chartToCsv(plan);
    expect(csv.startsWith("﻿code;name;type;nature;postable;active\r\n")).toBe(true);
    const { rows, issues } = parseChartCsv(csv);
    expect(issues).toEqual([]);
    const back = new Map(rows.map((r) => [r.code, r]));
    for (const a of plan) {
      const r = back.get(a.code);
      expect(r, a.code).toBeDefined();
      expect(r).toMatchObject({
        name: a.name,
        type: a.type,
        nature: a.nature,
        postable: a.postable,
        synthesized: false,
      });
    }
    // 15 y 1592 no están en el plan de prueba: el importador las sintetiza.
    expect(rows.filter((r) => !r.synthesized)).toHaveLength(plan.length);
  });
});

describe("createAccount", () => {
  const rows = (over: Record<string, Partial<PlanAccount>> = {}) =>
    PLAN.map((a) => ({ id: `id-${a.code}`, level: a.code.length, parentCode: parentCodeFor(a.code), ...a, ...(over[a.code] ?? {}) }));

  beforeEach(() => {
    vi.resetAllMocks();
    m.findMany.mockResolvedValue(rows());
    m.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      id: "id-new",
      ...data,
    }));
    m.lineUpdateMany.mockResolvedValue({ count: 7 });
    for (const fn of Object.values(m.refs)) fn.mockResolvedValue({ count: 0 });
  });

  it("madre imputable: crea la auxiliar, degrada a la madre y traslada líneas y referencias", async () => {
    const r = await createAccount("r1", {
      code: "11100501",
      name: "Bancolombia ahorros",
      parentCode: "111005",
    });
    expect(r).toMatchObject({
      ok: true,
      transferredLines: 7,
      account: {
        code: "11100501",
        name: "Bancolombia ahorros",
        type: "activo",
        nature: "debito",
        level: 8,
        parentCode: "111005",
        postable: true,
        active: true,
      },
    });
    expect(m.create.mock.calls[0][0].data).toMatchObject({
      restaurantId: "r1",
      code: "11100501",
      type: "activo",
      nature: "debito",
      postable: true,
    });
    expect(m.lineUpdateMany).toHaveBeenCalledWith({
      where: { accountId: "id-111005" },
      data: { accountId: "id-new", accountCode: "11100501" },
    });
    expect(m.update).toHaveBeenCalledWith({
      where: { id: "id-111005" },
      data: { postable: false },
    });
    for (const key of ["expense", "expensePayment", "purchasePayment", "retentionConcept", "bankRecRule", "budget"] as const) {
      expect(m.refs[key], key).toHaveBeenCalledWith({
        where: { restaurantId: "r1", accountCode: "111005" },
        data: { accountCode: "11100501" },
      });
    }
    expect(m.refs.fixedAsset).toHaveBeenCalledWith({
      where: { restaurantId: "r1", assetAccountCode: "111005" },
      data: { assetAccountCode: "11100501" },
    });
    // Las cuentas de depreciación por activo también siguen a la hija.
    expect(m.refs.fixedAsset).toHaveBeenCalledWith({
      where: { restaurantId: "r1", depreciationAccountCode: "111005" },
      data: { depreciationAccountCode: "11100501" },
    });
    expect(m.refs.fixedAsset).toHaveBeenCalledWith({
      where: { restaurantId: "r1", expenseAccountCode: "111005" },
      data: { expenseAccountCode: "11100501" },
    });
  });

  it("madre agrupadora: crea la hija sin tocar nada más", async () => {
    const r = await createAccount("r1", {
      code: "111010",
      name: "Cuenta de ahorros",
      parentCode: "1110",
    });
    expect(r).toMatchObject({ ok: true, transferredLines: 0, account: { code: "111010", level: 6 } });
    expect(m.lineUpdateMany).not.toHaveBeenCalled();
    expect(m.update).not.toHaveBeenCalled();
    for (const fn of Object.values(m.refs)) expect(fn).not.toHaveBeenCalled();
  });

  it("hereda tipo y naturaleza de la madre aunque el nombre sugiera otra cosa", async () => {
    const r = await createAccount("r1", {
      code: "23803001",
      name: "Propinas meseros",
      parentCode: "238030",
    });
    expect(r).toMatchObject({ ok: true, account: { type: "pasivo", nature: "credito" } });
  });

  it("devuelve el error de validación sin escribir", async () => {
    expect(
      await createAccount("r1", { code: "111005", name: "Dup", parentCode: "1110" }),
    ).toEqual({ ok: false, error: "code_taken" });
    expect(
      await createAccount("r1", { code: "11050501", name: "Nueva", parentCode: "111005" }),
    ).toEqual({ ok: false, error: "bad_prefix" });
    expect(m.create).not.toHaveBeenCalled();
  });
});

describe("updateAccount", () => {
  const current = (over: Record<string, unknown> = {}) => ({
    id: "id-111005",
    code: "111005",
    name: "Bancos",
    type: "activo",
    nature: "debito",
    level: 6,
    parentCode: "1110",
    postable: true,
    active: true,
    ...over,
  });

  beforeEach(() => {
    vi.resetAllMocks();
    m.findUnique.mockResolvedValue(current());
    m.lineCount.mockResolvedValue(0);
    m.count.mockResolvedValue(0);
    m.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => current(data));
  });

  it("renombra", async () => {
    const r = await updateAccount("r1", "111005", { name: "  Bancos nacionales " });
    expect(r).toMatchObject({ ok: true, account: { name: "Bancos nacionales" } });
    expect(m.update.mock.calls[0][0].data).toEqual({ name: "Bancos nacionales" });
  });

  it("no desactiva una cuenta que usa el motor", async () => {
    expect(await updateAccount("r1", "111005", { active: false })).toEqual({
      ok: false,
      error: "engine_account",
    });
    expect(m.update).not.toHaveBeenCalled();
  });

  it("no desactiva una cuenta con movimientos ni una madre con hijas activas", async () => {
    m.findUnique.mockResolvedValue(current({ code: "111010", id: "id-111010" }));
    m.lineCount.mockResolvedValue(3);
    expect(await updateAccount("r1", "111010", { active: false })).toEqual({
      ok: false,
      error: "has_movements",
    });
    m.lineCount.mockResolvedValue(0);
    m.count.mockResolvedValue(2);
    expect(await updateAccount("r1", "111010", { active: false })).toEqual({
      ok: false,
      error: "has_active_children",
    });
    expect(m.update).not.toHaveBeenCalled();
  });

  it("desactiva una cuenta propia sin uso y la reactiva si la madre está activa", async () => {
    m.findUnique.mockResolvedValue(current({ code: "111010", id: "id-111010" }));
    expect(await updateAccount("r1", "111010", { active: false })).toMatchObject({ ok: true });
    m.findUnique
      .mockResolvedValueOnce(current({ code: "111010", id: "id-111010", active: false }))
      .mockResolvedValueOnce({ active: false });
    expect(await updateAccount("r1", "111010", { active: true })).toEqual({
      ok: false,
      error: "parent_inactive",
    });
  });

  it("nombre inválido, nada que actualizar y cuenta inexistente", async () => {
    expect(await updateAccount("r1", "111005", { name: "x" })).toEqual({ ok: false, error: "bad_name" });
    expect(await updateAccount("r1", "111005", {})).toEqual({ ok: false, error: "nothing_to_update" });
    m.findUnique.mockResolvedValue(null);
    expect(await updateAccount("r1", "999999", { name: "Nada" })).toEqual({ ok: false, error: "not_found" });
  });
});
