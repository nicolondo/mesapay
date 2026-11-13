import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { db } from "../src/lib/db";
import { POST as createOrder } from "../src/app/api/operator/purchase-orders/route";
import { PATCH as patchOrder } from "../src/app/api/operator/purchase-orders/[id]/route";
import { POST as confirmInvoice } from "../src/app/api/operator/purchase-invoices/[id]/confirm/route";
import { POST as createExpense } from "../src/app/api/operator/expenses/route";
import { PATCH as patchExpense } from "../src/app/api/operator/expenses/[id]/route";
import { GET as checkDuplicates } from "../src/app/api/operator/supplier-documents/duplicates/route";
import { loadPurchaseListPage } from "../src/lib/erp/purchaseListQueries";
import { parsePurchaseListParams } from "../src/lib/erp/purchaseList";

/**
 * Facturas de proveedor repetidas contra PostgreSQL real, por todas las vías
 * de alta: compra manual («Ya recibí»), factura leída con IA (borrador y
 * recibida), número de factura de una orden, y gastos. Más el cálculo del
 * total a pagar de la lista de Compras con filtros, sobre todas las páginas.
 */
const scope = vi.hoisted(() => ({ restaurantId: "" }));
vi.mock("../src/lib/secureApi", () => ({ secureApi: (handler: unknown) => handler }));
vi.mock("../src/auth", () => ({ auth: async () => ({ user: { id: null, role: "operator" } }) }));
vi.mock("../src/lib/activeRestaurant", () => ({ getActiveRestaurantId: async () => scope.restaurantId }));

const database = new URL(process.env.DATABASE_URL ?? "postgresql://localhost/invalid");
if (!["localhost", "127.0.0.1"].includes(database.hostname) || !/^\/[a-z_]*(?:test|validation)$/.test(database.pathname)) {
  throw new Error("Isolated local database required");
}

const tenants: string[] = [];
let restaurantId = "";
let supplierId = "";
let ingredientId = "";

async function tenant(name: string) {
  const r = await db.restaurant.create({
    data: {
      name,
      slug: `dup-docs-${randomUUID()}`,
      enabledModules: ["accounting", "purchasing", "inventory"],
    },
  });
  tenants.push(r.id);
  const supplier = await db.supplier.create({ data: { restaurantId: r.id, name: "Distribuidora Andina", taxId: "900.100.200-1" } });
  const ingredient = await db.ingredient.create({ data: { restaurantId: r.id, name: "Harina", measureKind: "mass" } });
  return { restaurantId: r.id, supplierId: supplier.id, ingredientId: ingredient.id };
}

beforeEach(async () => {
  ({ restaurantId, supplierId, ingredientId } = await tenant("Facturas repetidas"));
  scope.restaurantId = restaurantId;
});

afterAll(async () => {
  if (tenants.length) {
    const where = { restaurantId: { in: tenants } };
    await db.journalEntry.deleteMany({ where });
    await db.stockMovement.deleteMany({ where });
    await db.expense.deleteMany({ where });
    await db.purchaseInvoiceUpload.deleteMany({ where });
    await db.purchaseOrder.deleteMany({ where });
    await db.restaurant.deleteMany({ where: { id: { in: tenants } } });
  }
  await db.$disconnect();
});

const json = (body: unknown, method = "POST") => ({ method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const line = () => ({ ingredientId, qtyBase: 5_000, expectedCostCents: 1_000_000, taxPct: 19 });

/** Compra manual recibida («Ya recibí esta mercancía»). */
const manualPurchase = (receive: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  createOrder(new Request("http://localhost/api/operator/purchase-orders", json({ supplierId, lines: [line()], receive, ...extra })));

async function aiInvoice(body: Record<string, unknown>) {
  const upload = await db.purchaseInvoiceUpload.create({
    data: { restaurantId: scope.restaurantId, fileUrl: "/uploads/fixture.pdf", extraction: {} },
  });
  const res = await confirmInvoice(
    new Request(`http://localhost/api/operator/purchase-invoices/${upload.id}/confirm`, json({ supplierId, lines: [line()], mode: "receive", ...body })),
    { params: Promise.resolve({ id: upload.id }) },
  );
  return { res, uploadId: upload.id };
}

const expense = (body: Record<string, unknown>) =>
  createExpense(new Request("http://localhost/api/operator/expenses", json({ category: "Insumos", date: "2026-11-10T17:00:00.000Z", supplierId, ...body })));

const invoiceUpdate = (id: string, body: Record<string, unknown>) =>
  patchOrder(new Request(`http://localhost/api/operator/purchase-orders/${id}`, json({ action: "update_invoice", ...body }, "PATCH")), {
    params: Promise.resolve({ id }),
  });

describe("manual purchase («Ya recibí»)", () => {
  it("blocks the same supplier invoice written differently, naming the existing one", async () => {
    const first = await manualPurchase({ supplierInvoiceNumber: "FE-000123" });
    expect(first.status).toBe(201);
    const firstId = (await first.json()).order.id as string;

    const again = await manualPurchase({ supplierInvoiceNumber: "fe 123" });
    expect(again.status).toBe(409);
    const body = await again.json();
    expect(body).toMatchObject({
      error: "duplicate_document",
      duplicate: {
        kind: "purchase",
        id: firstId,
        number: "FE-000123",
        purchaseNumber: 1,
        totalCents: 1_190_000,
        supplierName: "Distribuidora Andina",
        href: `/operator/compras?oc=${firstId}`,
      },
    });
    // Se deshizo todo: ni orden, ni inventario de la segunda.
    expect(await db.purchaseOrder.count({ where: { restaurantId } })).toBe(1);
    expect(await db.stockMovement.count({ where: { restaurantId } })).toBe(1);
  });

  it("a different number, or the same number from another supplier, is fine", async () => {
    expect((await manualPurchase({ supplierInvoiceNumber: "FE-1" })).status).toBe(201);
    expect((await manualPurchase({ supplierInvoiceNumber: "FE-2" })).status).toBe(201);
    const other = await db.supplier.create({ data: { restaurantId, name: "Otro proveedor", taxId: "800.555.444" } });
    const res = await createOrder(
      new Request("http://localhost/api/operator/purchase-orders", json({ supplierId: other.id, lines: [line()], receive: { supplierInvoiceNumber: "FE-1" } })),
    );
    expect(res.status).toBe(201);
  });

  it("the same NIT under another supplier record counts as the same supplier", async () => {
    expect((await manualPurchase({ supplierInvoiceNumber: "A-77" })).status).toBe(201);
    const twin = await db.supplier.create({ data: { restaurantId, name: "Distribuidora Andina S.A.S.", taxId: "900100200" } });
    const res = await createOrder(
      new Request("http://localhost/api/operator/purchase-orders", json({ supplierId: twin.id, lines: [line()], receive: { supplierInvoiceNumber: "A77" } })),
    );
    expect(res.status).toBe(409);
  });

  it("another merchant's invoice never counts", async () => {
    expect((await manualPurchase({ supplierInvoiceNumber: "FE-9" })).status).toBe(201);
    const other = await tenant("Otro comercio");
    scope.restaurantId = other.restaurantId;
    const res = await createOrder(
      new Request(
        "http://localhost/api/operator/purchase-orders",
        json({ supplierId: other.supplierId, lines: [{ ...line(), ingredientId: other.ingredientId }], receive: { supplierInvoiceNumber: "FE-9" } }),
      ),
    );
    expect(res.status).toBe(201);
  });

  it("the same invoice saved at the same time as a purchase and as an expense: exactly one wins", async () => {
    // (Dos compras a la vez ya chocan antes por el consecutivo OC del comercio;
    // compra + gasto no comparten consecutivo: aquí sólo protege el candado.)
    const results = await Promise.all([
      manualPurchase({ supplierInvoiceNumber: "SIM-500" }),
      expense({ amountCents: 1_190_000, documentNumber: "SIM-0500" }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    const saved = (await db.purchaseOrder.count({ where: { restaurantId } })) + (await db.expense.count({ where: { restaurantId } }));
    expect(saved).toBe(1);
  });

  it("without a number: warns only when asked, and saves when the operator confirms", async () => {
    expect((await manualPurchase({})).status).toBe(201);
    // Cliente viejo (sin advertencia): guarda.
    expect((await manualPurchase({})).status).toBe(201);
    const warned = await manualPurchase({}, { possibleDuplicate: "check" });
    expect(warned.status).toBe(409);
    expect(await warned.json()).toMatchObject({ error: "possible_duplicate", duplicate: { kind: "purchase", number: null, totalCents: 1_190_000 } });
    expect((await manualPurchase({}, { possibleDuplicate: "allow" })).status).toBe(201);
    // Otro total el mismo día: nada que advertir.
    const different = await createOrder(
      new Request(
        "http://localhost/api/operator/purchase-orders",
        json({ supplierId, lines: [{ ...line(), expectedCostCents: 2_000_000 }], receive: {}, possibleDuplicate: "check" }),
      ),
    );
    expect(different.status).toBe(201);
  });
});

describe("invoice read with AI", () => {
  it("a draft keeps the invoice number and a second upload of it is blocked (the upload stays pending)", async () => {
    const first = await aiInvoice({ mode: "draft", supplierInvoiceNumber: "FV-0042" });
    expect(first.res.status).toBe(201);
    const order = (await first.res.json()).order as { id: string };
    expect((await db.purchaseOrder.findUniqueOrThrow({ where: { id: order.id } })).supplierInvoiceNumber).toBe("FV-0042");

    const second = await aiInvoice({ mode: "receive", supplierInvoiceNumber: "FV 42" });
    expect(second.res.status).toBe(409);
    expect((await second.res.json()).duplicate).toMatchObject({ kind: "purchase", id: order.id, number: "FV-0042" });
    expect((await db.purchaseInvoiceUpload.findUniqueOrThrow({ where: { id: second.uploadId } })).status).toBe("pending");
    expect(await db.purchaseOrder.count({ where: { restaurantId } })).toBe(1);
  });

  it("a canceled purchase does not block registering its invoice again", async () => {
    const first = await aiInvoice({ mode: "draft", supplierInvoiceNumber: "FV-7" });
    const { id } = (await first.res.json()).order as { id: string };
    const cancel = await patchOrder(new Request(`http://localhost/api/operator/purchase-orders/${id}`, json({ action: "cancel" }, "PATCH")), {
      params: Promise.resolve({ id }),
    });
    expect(cancel.status).toBe(200);
    expect((await aiInvoice({ mode: "receive", supplierInvoiceNumber: "FV-7" })).res.status).toBe(201);
  });

  it("a new supplier (by NIT) that already exists is still the same supplier", async () => {
    expect((await manualPurchase({ supplierInvoiceNumber: "N-55" })).status).toBe(201);
    const upload = await db.purchaseInvoiceUpload.create({ data: { restaurantId, fileUrl: "/uploads/fixture.pdf", extraction: {} } });
    // Proveedor "nuevo" con el NIT del existente (con DV): el early-check lo ve.
    const check = await checkDuplicates(
      new Request("http://localhost/api/operator/supplier-documents/duplicates?taxId=900100200-1&number=n%2055"),
    );
    expect((await check.json()).duplicate).toMatchObject({ kind: "purchase", number: "N-55" });
    const res = await confirmInvoice(
      new Request(
        `http://localhost/api/operator/purchase-invoices/${upload.id}/confirm`,
        json({ supplierId: null, newSupplierName: "Andina (nuevo)", newSupplierNit: "900100200-1", lines: [line()], mode: "receive", supplierInvoiceNumber: "N-55" }),
      ),
      { params: Promise.resolve({ id: upload.id }) },
    );
    expect(res.status).toBe(409);
    // El proveedor "nuevo" tampoco quedó creado.
    expect(await db.supplier.count({ where: { restaurantId, name: "Andina (nuevo)" } })).toBe(0);
  });
});

describe("invoice number of a received order (Editar factura)", () => {
  it("blocks a number already used, and editing only the due date of an old duplicate still works", async () => {
    const a = (await (await manualPurchase({ supplierInvoiceNumber: "R-1" })).json()).order.id as string;
    const b = (await (await manualPurchase({ supplierInvoiceNumber: "R-2" })).json()).order.id as string;
    const blocked = await invoiceUpdate(b, { supplierInvoiceNumber: "r-0001", invoiceDueAt: null });
    expect(blocked.status).toBe(409);
    expect((await blocked.json()).duplicate).toMatchObject({ id: a });
    expect((await db.purchaseOrder.findUniqueOrThrow({ where: { id: b } })).supplierInvoiceNumber).toBe("R-2");

    // Duplicado viejo (anterior a esta revisión): cambiar sólo el vencimiento no se bloquea.
    await db.purchaseOrder.update({ where: { id: b }, data: { supplierInvoiceNumber: "R-1" } });
    const due = await invoiceUpdate(b, { supplierInvoiceNumber: "R-1", invoiceDueAt: "2026-12-01T17:00:00.000Z" });
    expect(due.status).toBe(200);
    // Su propio número no lo bloquea.
    expect((await invoiceUpdate(a, { supplierInvoiceNumber: "R-0001" })).status).toBe(200);
  });
});

describe("expenses", () => {
  it("the same invoice as a purchase and then as an expense is blocked, and between expenses too", async () => {
    const po = (await (await manualPurchase({ supplierInvoiceNumber: "G-10" })).json()).order.id as string;
    const asExpense = await expense({ amountCents: 1_190_000, documentType: "e_invoice", documentNumber: "G 010" });
    expect(asExpense.status).toBe(409);
    expect((await asExpense.json()).duplicate).toMatchObject({ kind: "purchase", id: po });

    const first = await expense({ amountCents: 50_000, documentNumber: "CC-3" });
    expect(first.status).toBe(201);
    const firstId = (await first.json()).expense.id as string;
    const again = await expense({ amountCents: 50_000, documentNumber: "cc3" });
    expect(again.status).toBe(409);
    expect((await again.json()).duplicate).toMatchObject({
      kind: "expense",
      id: firstId,
      href: `/operator/contabilidad?tab=expenses&month=2026-11&expense=${firstId}`,
    });
    expect(await db.expensePayment.count({ where: { restaurantId } })).toBe(0);
  });

  it("three simultaneous saves of the same expense document: exactly one wins", async () => {
    const results = await Promise.all(["CON-9", "con 9", "CON-09"].map((documentNumber) => expense({ amountCents: 40_000, documentNumber })));
    expect(results.map((r) => r.status).sort()).toEqual([201, 409, 409]);
    expect(await db.expense.count({ where: { restaurantId } })).toBe(1);
  });

  it("an expense without a supplier, or a recurring template, is not checked", async () => {
    expect((await expense({ supplierId: null, amountCents: 10_000, documentNumber: "X-1" })).status).toBe(201);
    expect((await expense({ supplierId: null, amountCents: 10_000, documentNumber: "X-1" })).status).toBe(201);
    expect((await expense({ amountCents: 10_000, documentNumber: "T-1", recurring: true, recurringDay: 5 })).status).toBe(201);
    expect((await expense({ amountCents: 10_000, documentNumber: "T-1" })).status).toBe(201);
  });

  it("editing: changing to a used number is blocked; editing other fields of an old duplicate is not", async () => {
    const a = (await (await expense({ amountCents: 20_000, documentNumber: "E-1" })).json()).expense.id as string;
    const b = (await (await expense({ amountCents: 20_000, documentNumber: "E-2" })).json()).expense.id as string;
    const edit = (id: string, body: Record<string, unknown>) =>
      patchExpense(new Request(`http://localhost/api/operator/expenses/${id}`, json(body, "PATCH")), { params: Promise.resolve({ id }) });
    const blocked = await edit(b, { documentNumber: "e 1" });
    expect(blocked.status).toBe(409);
    expect((await blocked.json()).duplicate).toMatchObject({ kind: "expense", id: a });
    await db.expense.update({ where: { id: b }, data: { documentNumber: "E-1" } });
    expect((await edit(b, { description: "Corregido", documentNumber: "E-1" })).status).toBe(200);
  });

  it("without a number: same supplier, day and total warns when asked", async () => {
    expect((await expense({ amountCents: 30_000 })).status).toBe(201);
    const warned = await expense({ amountCents: 30_000, possibleDuplicate: "check" });
    expect(warned.status).toBe(409);
    expect((await warned.json()).error).toBe("possible_duplicate");
    expect((await expense({ amountCents: 30_000, possibleDuplicate: "allow" })).status).toBe(201);
    expect((await expense({ amountCents: 30_000, possibleDuplicate: "check", date: "2026-11-11T17:00:00.000Z" })).status).toBe(201);
  });
});

describe("Compras list: totals with the active filters", () => {
  it("adds every page and follows supplier, status and search filters", async () => {
    const other = await db.supplier.create({ data: { restaurantId, name: "Lácteos Sabana", taxId: "830.111.222" } });
    // Andina: 3 facturas recibidas de $11.900 c/u (con IVA), una abonada en parte.
    for (const n of ["A-1", "A-2", "A-3"]) expect((await manualPurchase({ supplierInvoiceNumber: n })).status).toBe(201);
    const create = (sup: string, receive: Record<string, unknown>) =>
      createOrder(new Request("http://localhost/api/operator/purchase-orders", json({ supplierId: sup, lines: [line()], receive })));
    expect((await create(other.id, { supplierInvoiceNumber: "L-1", invoiceDueAt: "2020-01-01T17:00:00.000Z" })).status).toBe(201);
    const partial = await db.purchaseOrder.findFirstOrThrow({ where: { restaurantId, supplierInvoiceNumber: "A-2" } });
    await db.purchaseOrder.update({ where: { id: partial.id }, data: { paidCents: 190_000 } });

    const page = (sp: Record<string, string>) =>
      loadPurchaseListPage(restaurantId, parsePurchaseListParams(sp), { pageSize: 2, todayIso: "2026-11-13" });

    const all = await page({ tab: "unpaid" });
    expect(all.total).toBe(4);
    expect(all.rows).toHaveLength(2);
    expect(all.pageCount).toBe(2);
    expect(all.summary).toMatchObject({ payableCents: 4 * 1_190_000 - 190_000, payableCount: 4, overdueCents: 1_190_000, overdueCount: 1 });

    const andina = await page({ tab: "unpaid", supplier: supplierId });
    expect(andina.summary.payableCents).toBe(3 * 1_190_000 - 190_000);
    expect(andina.summary.overdueCents).toBe(0);

    const overdue = await page({ tab: "unpaid", status: "overdue" });
    expect(overdue.rows.map((r) => r.supplierInvoiceNumber)).toEqual(["L-1"]);
    expect(overdue.summary.payableCents).toBe(1_190_000);

    const byNit = await page({ q: "830111222" });
    expect(byNit.rows.map((r) => r.supplier.name)).toEqual(["Lácteos Sabana"]);
    const byInvoice = await page({ q: "a 02" });
    expect(byInvoice.rows.map((r) => r.supplierInvoiceNumber)).toEqual(["A-2"]);
    expect(byInvoice.summary).toMatchObject({ count: 1, totalCents: 1_190_000, payableCents: 1_000_000 });

    // Fuera de rango de fechas: nada.
    expect((await page({ from: "2020-01-01", to: "2020-01-31" })).total).toBe(0);
  });
});
