import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { db } from "../src/lib/db";
import { GET as listExpenses, POST as createExpense } from "../src/app/api/operator/expenses/route";
import { DELETE as deleteExpense, GET as getExpense, PATCH as patchExpense } from "../src/app/api/operator/expenses/[id]/route";
import { GET as exportCsv } from "../src/app/api/operator/accounting/export/route";
import { POST as runRecurring } from "../src/app/api/cron/recurring-expenses/route";
import { loadExpenseList, parseExpenseListParams } from "../src/lib/erp/expenseList";
import { ensureChartOfAccounts } from "../src/lib/erp/ledger";

/**
 * Consecutivo de gastos (G-0001) y lista filtrada contra PostgreSQL real
 * (migración 20261113160000_expense_number): numeración secuencial y bajo
 * concurrencia, nunca reutilizada, compatible con la versión anterior del
 * código (gastos sin número), el backfill de la migración, y búsqueda,
 * filtros, páginas y totales calculados en el servidor.
 */
const scope = vi.hoisted(() => ({ restaurantId: "" }));
vi.mock("../src/lib/secureApi", () => ({ secureApi: (handler: unknown) => handler }));
vi.mock("../src/auth", () => ({ auth: async () => ({ user: { role: "operator" } }) }));
vi.mock("../src/lib/erp/access", () => ({
  getErpContext: async () => ({ restaurantId: scope.restaurantId, country: "CO", userId: null }),
  isDenied: () => false,
}));
vi.mock("next-intl/server", () => ({ getTranslations: async () => (key: string) => key }));
const database = new URL(process.env.DATABASE_URL ?? "postgresql://localhost/invalid");
if (!["localhost", "127.0.0.1"].includes(database.hostname) || !/^\/mesapay_.*(?:test|validation)$/.test(database.pathname)) {
  throw new Error("Isolated local database required");
}

type IdHandler = (r: Request, c: { params: Promise<{ id: string }> }) => Promise<Response>;
type Expense = { id: string; number: number | null; category: string };
const created: string[] = [];

async function tenant(name: string) {
  const r = await db.restaurant.create({
    data: { name, slug: `gastos-num-${randomUUID()}`, enabledModules: ["accounting"], purchaseIvaDeductible: true },
  });
  created.push(r.id);
  scope.restaurantId = r.id;
  return r.id;
}
async function post(body: Record<string, unknown>) {
  const res = await createExpense(
    new Request("http://localhost/api/operator/expenses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ date: "2026-10-10T17:00:00.000Z", ...body }),
    }),
  );
  expect(res.status).toBe(201);
  return ((await res.json()) as { expense: Expense }).expense;
}
async function list(query: string) {
  const res = await listExpenses(new Request(`http://localhost/api/operator/expenses?${query}`));
  expect(res.status).toBe(200);
  return (await res.json()) as {
    expenses: Array<Expense & { overdue: boolean; supplier: { name: string } | null }>;
    summary: { count: number; costCents: number; payableCents: number; outstandingCents: number; overdueCents: number };
    counts: Record<string, number>;
    page: number;
    pageCount: number;
  };
}
const counter = async (id: string) =>
  (await db.restaurant.findUniqueOrThrow({ where: { id }, select: { expenseNextNumber: true } })).expenseNextNumber;
const numbers = async (id: string) =>
  (await db.expense.findMany({ where: { restaurantId: id, recurring: false }, orderBy: { number: "asc" }, select: { number: true } })).map((e) => e.number);

afterAll(async () => {
  await db.restaurant.deleteMany({ where: { id: { in: created } } });
  await db.$disconnect();
});

describe("consecutivo de gastos", () => {
  let rid = "";
  beforeAll(async () => {
    rid = await tenant("Consecutivo de gastos");
  });

  it("secuencial: el primer gasto del comercio es 1 y cada alta suma uno", async () => {
    const a = await post({ category: "Arriendo", amountCents: 100_000 });
    const b = await post({ category: "Internet", amountCents: 50_000 });
    expect([a.number, b.number]).toEqual([1, 2]);
    expect(await counter(rid)).toBe(3);
  });

  it("concurrente: doce altas a la vez reciben 3…14, sin repetir ni dejar huecos", async () => {
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) => post({ category: `Concurrente ${i}`, amountCents: 1_000 + i })),
    );
    expect(results.map((e) => e.number).sort((x, y) => x! - y!)).toEqual(Array.from({ length: 12 }, (_, i) => i + 3));
    expect(await numbers(rid)).toEqual(Array.from({ length: 14 }, (_, i) => i + 1));
    expect(await counter(rid)).toBe(15);
  });

  it("nunca reutiliza: borrar el último no devuelve su número", async () => {
    const last = await db.expense.findFirstOrThrow({ where: { restaurantId: rid, number: 14 } });
    const del = await (deleteExpense as unknown as IdHandler)(new Request("http://localhost", { method: "DELETE" }), {
      params: Promise.resolve({ id: last.id }),
    });
    expect(del.status).toBe(200);
    expect((await post({ category: "Después de borrar", amountCents: 9_000 })).number).toBe(15);
  });

  it("convive con la versión anterior: sus gastos sin número se numeran en orden de creación al abrir la lista o al crear", async () => {
    // Lo que hace el código viejo: crea el gasto sin conocer la columna.
    const oldA = await db.expense.create({
      data: { restaurantId: rid, category: "Creado por la versión vieja A", amountCents: 1_000, date: new Date("2026-10-11T17:00:00Z") },
    });
    const oldB = await db.expense.create({
      data: { restaurantId: rid, category: "Creado por la versión vieja B", amountCents: 1_000, date: new Date("2026-10-11T17:00:00Z") },
    });
    expect([oldA.number, oldB.number]).toEqual([null, null]);
    const page = await list("month=2026-10&q=vieja");
    expect(page.expenses.map((e) => [e.category, e.number])).toEqual([
      ["Creado por la versión vieja B", 17],
      ["Creado por la versión vieja A", 16],
    ]);
    // Y si el siguiente evento es un alta, también los numera antes que al nuevo.
    const oldC = await db.expense.create({
      data: { restaurantId: rid, category: "Creado por la versión vieja C", amountCents: 1_000, date: new Date("2026-10-12T17:00:00Z") },
    });
    const fresh = await post({ category: "Nuevo después de la vieja", amountCents: 2_000 });
    expect((await db.expense.findUniqueOrThrow({ where: { id: oldC.id } })).number).toBe(18);
    expect(fresh.number).toBe(19);
    expect(await counter(rid)).toBe(20);
  });

  it("las plantillas no llevan número; la que pasa a gasto normal recibe el siguiente, y la copia del cron también", async () => {
    const tpl = await post({ category: "Plan de datos", amountCents: 30_000, recurring: true, recurringDay: 1 });
    expect(tpl.number).toBeNull();
    const tpl2 = await post({ category: "Arriendo bodega", amountCents: 80_000, recurring: true, recurringDay: 1 });

    vi.stubEnv("CRON_SECRET", "s");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-05T12:00:00Z"));
    await db.expense.update({ where: { id: tpl2.id }, data: { createdAt: new Date("2026-10-01T12:00:00Z") } });
    const cron = await runRecurring(new Request("http://localhost/api/cron/recurring-expenses", { method: "POST", headers: { "x-cron-secret": "s" } }));
    vi.useRealTimers();
    vi.unstubAllEnvs();
    expect(cron.status).toBe(200);
    const copy = await db.expense.findFirstOrThrow({ where: { templateId: tpl2.id } });
    expect(copy.number).toBe(20);

    const res = await (patchExpense as unknown as IdHandler)(
      new Request("http://localhost", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ recurring: false, recurringDay: null }) }),
      { params: Promise.resolve({ id: tpl.id }) },
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { expense: Expense }).expense.number).toBe(21);
    // Editar no mueve el número.
    const again = await (patchExpense as unknown as IdHandler)(
      new Request("http://localhost", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ category: "Plan de datos 2" }) }),
      { params: Promise.resolve({ id: tpl.id }) },
    );
    expect(((await again.json()) as { expense: Expense }).expense.number).toBe(21);
    // Y un gasto se abre por id aunque no esté en la página visible.
    const one = await (getExpense as unknown as IdHandler)(new Request("http://localhost"), { params: Promise.resolve({ id: tpl.id }) });
    expect(((await one.json()) as { expense: Expense }).expense).toMatchObject({ id: tpl.id, number: 21 });
  });

  it("el índice único impide dos gastos con el mismo número en el comercio", async () => {
    await expect(
      db.expense.create({ data: { restaurantId: rid, category: "Duplicado", amountCents: 1, date: new Date(), number: 1 } }),
    ).rejects.toMatchObject({ code: "P2002" });
  });
});

describe("backfill de la migración", () => {
  it("numera los existentes 1…n por fecha de creación, deja las plantillas sin número y pone el contador en n+1", async () => {
    const rid = await tenant("Backfill");
    const rows = [
      { category: "Tercero", createdAt: new Date("2026-03-03T10:00:00Z"), recurring: false },
      { category: "Primero", createdAt: new Date("2026-01-01T10:00:00Z"), recurring: false },
      { category: "Plantilla", createdAt: new Date("2026-01-02T10:00:00Z"), recurring: true },
      { category: "Segundo", createdAt: new Date("2026-02-02T10:00:00Z"), recurring: false },
    ];
    for (const r of rows) {
      await db.expense.create({
        data: { restaurantId: rid, amountCents: 1_000, date: r.createdAt, ...r, recurringDay: r.recurring ? 3 : null },
      });
    }
    const sql = readFileSync(
      path.resolve(__dirname, "../prisma/migrations/20261113160000_expense_number/migration.sql"),
      "utf8",
    );
    const block = /-- backfill:start\n([\s\S]*?)-- backfill:end/.exec(sql)![1]!;
    for (const statement of block.split(/;\s*\n/).map((s) => s.replace(/^\s*--.*$/gm, "").trim()).filter(Boolean)) {
      await db.$executeRawUnsafe(statement);
    }
    const after = await db.expense.findMany({ where: { restaurantId: rid }, orderBy: { createdAt: "asc" }, select: { category: true, number: true } });
    expect(after).toEqual([
      { category: "Primero", number: 1 },
      { category: "Plantilla", number: null },
      { category: "Segundo", number: 2 },
      { category: "Tercero", number: 3 },
    ]);
    expect(await counter(rid)).toBe(4);
    // Correrlo otra vez no cambia nada (sólo toca los que no tienen número).
    for (const statement of block.split(/;\s*\n/).map((s) => s.replace(/^\s*--.*$/gm, "").trim()).filter(Boolean)) {
      await db.$executeRawUnsafe(statement);
    }
    expect(await numbers(rid)).toEqual([1, 2, 3]);
    expect(await counter(rid)).toBe(4);
  });
});

describe("lista filtrada: búsqueda, filtros, páginas y totales en el servidor", () => {
  let rid = "";
  let cerezos = "";
  let polar = "";
  beforeAll(async () => {
    rid = await tenant("Lista de gastos");
    // Un comercio con contabilidad ya tiene su plan de cuentas (se crea al abrirla).
    await ensureChartOfAccounts(rid);
    cerezos = (await db.supplier.create({ data: { restaurantId: rid, name: "Inmobiliaria Los Cerezos", taxId: "900481516" } })).id;
    polar = (await db.supplier.create({ data: { restaurantId: rid, name: "Refrigeración Polar", taxId: "800765432" } })).id;
    // Con IVA descontable, ya pagado: costo 1.000.000, total a pagar 1.190.000.
    await post({ category: "Mantenimiento", supplierId: polar, subtotalCents: 100_000_000, ivaPct: 19, documentType: "e_invoice", documentNumber: "FE-1280", date: "2026-10-05T17:00:00.000Z" });
    await db.expense.updateMany({ where: { restaurantId: rid }, data: { paidCents: 119_000_000, paidAt: new Date("2026-10-05T17:00:00Z") } });
    // Arriendo debiéndose y vencido (cuenta deducida de la categoría).
    await post({ category: "Arriendo", supplierId: cerezos, amountCents: 980_000_000, documentType: "charge_account", documentNumber: "CC-235", dueAt: "2026-10-20T17:00:00.000Z", date: "2026-10-06T17:00:00.000Z" });
    // Arriendo de noviembre, debiéndose, sin vencimiento.
    await post({ category: "Arriendo", supplierId: cerezos, amountCents: 980_000_000, date: "2026-11-06T17:00:00.000Z" });
    // Sin proveedor, con cuenta fijada.
    await post({ category: "Domicilios", amountCents: 8_500_000, accountCode: "513550", date: "2026-10-09T17:00:00.000Z" });
    for (let i = 0; i < 5; i++) {
      await post({ category: `Caja menor ${i}`, amountCents: 1_000_000, date: `2026-10-${String(10 + i).padStart(2, "0")}T17:00:00.000Z` });
    }
  });

  it("período: el mes, un rango libre y todas las fechas", async () => {
    expect((await list("month=2026-10")).summary.count).toBe(8);
    expect((await list("desde=2026-10-06&hasta=2026-11-06")).summary.count).toBe(8);
    expect((await list("fechas=todas")).summary.count).toBe(9);
  });

  it("por proveedor: el total a pagar y el saldo por pagar son los de ese proveedor (no los de la página)", async () => {
    const r = await list(`fechas=todas&supplier=${cerezos}`);
    expect(r.expenses.every((e) => e.supplier?.name === "Inmobiliaria Los Cerezos")).toBe(true);
    expect(r.summary).toMatchObject({ count: 2, costCents: 1_960_000_000, payableCents: 1_960_000_000, outstandingCents: 1_960_000_000 });
    const none = await list("fechas=todas&supplier=none");
    expect(none.summary.count).toBe(6);
  });

  it("estado: pestañas con su conteo, vencidos aparte y totales de lo filtrado", async () => {
    const pending = await list("fechas=todas&status=pending");
    expect(pending.counts).toEqual({ all: 9, pending: 8, overdue: 1, paid: 1 });
    expect(pending.summary.count).toBe(8);
    const overdue = await list("fechas=todas&status=overdue");
    expect(overdue.expenses.map((e) => e.category)).toEqual(["Arriendo"]);
    expect(overdue.expenses[0]!.overdue).toBe(true);
    expect(overdue.summary.overdueCents).toBe(980_000_000);
    const paid = await list("fechas=todas&status=paid");
    expect(paid.summary).toMatchObject({ count: 1, costCents: 100_000_000, payableCents: 119_000_000, outstandingCents: 0 });
  });

  it("búsqueda: consecutivo, documento del proveedor, NIT, proveedor, concepto y nombre de la cuenta", async () => {
    const byNumber = (await list("fechas=todas&q=G-0002")).expenses;
    expect(byNumber.map((e) => e.number)).toEqual([2]);
    expect((await list("fechas=todas&q=fe-1280")).expenses.map((e) => e.category)).toEqual(["Mantenimiento"]);
    expect((await list("fechas=todas&q=900.481.516")).summary.count).toBe(2);
    expect((await list("fechas=todas&q=cerezos%20arriendo")).summary.count).toBe(2);
    expect((await list("fechas=todas&q=caja%20menor")).summary.count).toBe(5);
    // 513550 «Transporte, fletes y acarreos» (plan por defecto): se encuentra por el nombre de la cuenta.
    expect((await list("fechas=todas&q=fletes")).expenses.map((e) => e.category)).toEqual(["Domicilios"]);
  });

  it("cuenta: la fijada en el gasto y la que el motor deduce de la categoría", async () => {
    expect((await list("fechas=todas&account=513550")).expenses.map((e) => e.category)).toEqual(["Domicilios"]);
    const rent = await list("fechas=todas&account=5120");
    expect(rent.summary.count).toBe(2);
    expect(rent.expenses.every((e) => e.category === "Arriendo")).toBe(true);
  });

  it("páginas: sin truncar, más reciente primero y los totales siempre del conjunto completo", async () => {
    const f = parseExpenseListParams(new URLSearchParams("fechas=todas"))!;
    const seen: number[] = [];
    for (let page = 1; page <= 4; page++) {
      const r = await loadExpenseList(rid, { ...f, page }, "2026-11-13", 4);
      expect(r.pageCount).toBe(3);
      expect(r.summary.count).toBe(9);
      seen.push(...r.expenses.map((e) => e.number!));
      if (page === 4) expect(r.page).toBe(3); // una página de más cae a la última
    }
    expect(new Set(seen.slice(0, 9)).size).toBe(9);
    const first = await loadExpenseList(rid, { ...f, page: 1 }, "2026-11-13", 4);
    const dates = first.expenses.map((e) => e.date.getTime());
    expect([...dates].sort((a, b) => b - a)).toEqual(dates);
  });

  it("el CSV de la lista filtrada trae el consecutivo y sólo lo filtrado", async () => {
    const res = await exportCsv(new Request(`http://localhost/api/operator/accounting/export?book=expenses&fechas=todas&supplier=${cerezos}`));
    expect(res.status).toBe(200);
    const text = await res.text();
    const lines = text.replace(/^﻿/, "").trim().split(/\r?\n/);
    expect(lines[0]!.startsWith("csvExpenseNumber")).toBe(true);
    expect(lines).toHaveLength(3);
    expect(lines.slice(1).every((l) => /^G-\d{4}/.test(l) && l.includes("Inmobiliaria Los Cerezos"))).toBe(true);
    expect(res.headers.get("content-disposition")).toContain("mesapay-expenses.csv");
  });
});
