import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { db } from "../src/lib/db";
import { POST as createOrder } from "../src/app/api/operator/purchase-orders/route";
import { POST as createNote, GET as listNotes } from "../src/app/api/operator/supplier-credit-notes/route";
import { POST as voidNoteRoute } from "../src/app/api/operator/supplier-credit-notes/[id]/void/route";
import { DELETE as deletePaymentRoute } from "../src/app/api/operator/purchase-orders/[id]/payments/[paymentId]/route";
import { applySupplierCreditToDoc } from "../src/lib/erp/supplierPaymentService";
import {
  applyCreditNote,
  createCreditRefund,
  loadSupplierCredits,
  voidSupplierCreditNote,
} from "../src/lib/erp/supplierCreditNoteService";
import { generateJournalForMonth } from "../src/lib/erp/posting";
import { monthRange } from "../src/lib/erp/accounting";
import { loadSupplierCreditBalances } from "../src/lib/erp/reports/supplierCreditCartera";
import { loadPartnerMovements } from "../src/lib/erp/reports/carteraQueries";
import { loadSupplierCreditReport } from "../src/lib/erp/reports/supplierCreditReportQueries";
import { loadTaxesReport } from "../src/lib/erp/reports/taxesReport";

/**
 * Notas crédito de proveedores contra PostgreSQL real: cruce inmediato con
 * las facturas (relacionadas primero, FIFO), saldo a favor, consumo del
 * saldo con una factura nueva, reintegro, anulación, duplicados, devolución
 * con kardex, IVA discriminado o no, asientos del motor y aislamiento por
 * comercio.
 */
const scope = vi.hoisted(() => ({ restaurantId: "" }));
vi.mock("../src/lib/secureApi", () => ({ secureApi: (handler: unknown) => handler }));
vi.mock("../src/auth", () => ({ auth: async () => ({ user: { id: null, role: "operator" } }) }));
vi.mock("../src/lib/activeRestaurant", () => ({ getActiveRestaurantId: async () => scope.restaurantId }));

const database = new URL(process.env.DATABASE_URL ?? "postgresql://localhost/invalid");
if (!["localhost", "127.0.0.1"].includes(database.hostname) || !/^\/[a-z_]*(?:test|validation)$/.test(database.pathname)) {
  throw new Error("Isolated local database required");
}

const MONTH = new Date().toISOString().slice(0, 7);
const today = new Date().toISOString().slice(0, 10);
const tenants: string[] = [];
let restaurantId = "";
let supplierId = "";
let ingredientId = "";

async function tenant(name: string, opts: { ivaDeductible?: boolean } = {}) {
  const r = await db.restaurant.create({
    data: {
      name,
      slug: `nc-prov-${randomUUID()}`,
      enabledModules: ["accounting", "purchasing", "inventory"],
      purchaseIvaDeductible: opts.ivaDeductible ?? false,
    },
  });
  tenants.push(r.id);
  const supplier = await db.supplier.create({ data: { restaurantId: r.id, name: "Cervecería Andina", taxId: "900.100.200-1" } });
  const ingredient = await db.ingredient.create({ data: { restaurantId: r.id, name: "Cerveza lata", measureKind: "count" } });
  return { restaurantId: r.id, supplierId: supplier.id, ingredientId: ingredient.id };
}

async function use(t: Awaited<ReturnType<typeof tenant>>) {
  ({ restaurantId, supplierId, ingredientId } = t);
  scope.restaurantId = restaurantId;
}

beforeEach(async () => {
  await use(await tenant("Notas crédito"));
});

afterAll(async () => {
  if (tenants.length) {
    const where = { restaurantId: { in: tenants } };
    await db.journalEntry.deleteMany({ where });
    await db.supplierCreditNote.deleteMany({ where });
    await db.stockMovement.deleteMany({ where });
    await db.expense.deleteMany({ where });
    await db.purchaseOrder.deleteMany({ where });
    await db.restaurant.deleteMany({ where: { id: { in: tenants } } });
  }
  await db.$disconnect();
});

const json = (body: unknown, method = "POST") => ({ method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

/** Compra recibida («Ya recibí»): `units` latas a `netCents` el total neto, IVA `taxPct`. */
async function purchase(netCents: number, opts: { taxPct?: number; units?: number; invoice?: string; dueAt?: string } = {}) {
  const res = await createOrder(
    new Request(
      "http://localhost/api/operator/purchase-orders",
      json({
        supplierId,
        lines: [{ ingredientId, qtyBase: (opts.units ?? 10) * 1000, expectedCostCents: netCents, taxPct: opts.taxPct ?? 0 }],
        receive: {
          supplierInvoiceNumber: opts.invoice ?? `FE-${randomUUID().slice(0, 6)}`,
          invoiceDueAt: opts.dueAt ?? null,
          retefuenteCents: 0,
          reteIvaCents: 0,
          reteIcaCents: 0,
        },
      }),
    ),
  );
  expect(res.status).toBe(201);
  return (await res.json()).order.id as string;
}

const note = (body: Record<string, unknown>) =>
  createNote(
    new Request(
      "http://localhost/api/operator/supplier-credit-notes",
      json({ supplierId, number: `NC-${randomUUID().slice(0, 6)}`, date: today, kind: "agreement", totalCents: 100_000, ...body }),
    ),
  );

async function noteId(body: Record<string, unknown>) {
  const res = await note(body);
  const j = await res.json();
  expect(res.status, JSON.stringify(j)).toBe(201);
  return j.id as string;
}

const po = (id: string) => db.purchaseOrder.findUniqueOrThrow({ where: { id }, select: { paidCents: true, paidAt: true } });
const available = async () => (await loadSupplierCredits(db, restaurantId, supplierId)).reduce((s, c) => s + c.availableCents, 0);

async function journal() {
  await generateJournalForMonth(restaurantId, MONTH, monthRange(MONTH)!);
  const entries = await db.journalEntry.findMany({ where: { restaurantId }, include: { lines: true } });
  const by = (source: string) => {
    const net = new Map<string, number>();
    for (const e of entries.filter((x) => x.source === source)) {
      for (const l of e.lines) net.set(l.accountCode, (net.get(l.accountCode) ?? 0) + Number(l.debitCents) - Number(l.creditCents));
    }
    return Object.fromEntries([...net].filter(([, v]) => v !== 0));
  };
  return { entries, by };
}

describe("cruce al registrar", () => {
  it("sin nada pendiente: todo queda como saldo a favor (133005) y se ve en la cartera", async () => {
    await noteId({ totalCents: 250_000, agreement: "Bonificación trimestral" });
    expect(await available()).toBe(250_000);
    const balances = await loadSupplierCreditBalances(restaurantId, today);
    expect(balances).toEqual([expect.objectContaining({ supplierId, availableCents: 250_000, notes: 1 })]);
    const { by } = await journal();
    expect(by("supplier_credit_note")).toEqual({ "133005": 250_000, "613575": -250_000 });
    expect(by("supplier_credit_apply")).toEqual({});
  });

  it("nota mayor que lo pendiente: cruza la factura (pagada) y el remanente queda a favor", async () => {
    const id = await purchase(100_000, { taxPct: 19 });
    await noteId({ totalCents: 150_000 });
    expect(await po(id)).toMatchObject({ paidCents: 119_000, paidAt: expect.any(Date) });
    expect(await available()).toBe(31_000);
    const { by } = await journal();
    expect(by("supplier_credit_apply")).toEqual({ "220505": 119_000, "133005": -119_000 });
    // El cruce no es plata: no va al asiento de pagos a proveedores.
    expect(by("purchase_payment")).toEqual({});
    // Cartera: el cruce es un abono de la factura (saldo 0) y queda el saldo a favor aparte.
    const mov = await loadPartnerMovements(restaurantId, "cxp", supplierId, today);
    expect(mov!.payments.reduce((s, p) => s + p.amountCents, 0)).toBe(119_000);
  });

  it("primero las facturas que relaciona; lo que sobra, FIFO por vencimiento", async () => {
    const older = await purchase(50_000, { dueAt: "2026-01-01T17:00:00.000Z" });
    const related = await purchase(30_000, { dueAt: "2026-12-31T17:00:00.000Z" });
    await noteId({ totalCents: 60_000, kind: "discount", relatedPurchaseIds: [related] });
    expect((await po(related)).paidCents).toBe(30_000);
    expect((await po(older)).paidCents).toBe(30_000);
    expect(await available()).toBe(0);
  });

  it("el operador puede elegir el reparto o dejarlo todo a favor", async () => {
    const a = await purchase(50_000);
    await noteId({ totalCents: 40_000, applications: [{ kind: "purchase", id: a, amountCents: 10_000 }] });
    expect((await po(a)).paidCents).toBe(10_000);
    await noteId({ totalCents: 5_000, applications: [] });
    expect((await po(a)).paidCents).toBe(10_000);
    expect(await available()).toBe(35_000);
    const tooMuch = await note({ totalCents: 5_000, applications: [{ kind: "purchase", id: a, amountCents: 6_000 }] });
    expect(tooMuch.status).toBe(409);
  });

  it("también cruza gastos del proveedor (D costos y gastos por pagar · C saldo a favor)", async () => {
    const expense = await db.expense.create({
      data: { restaurantId, supplierId, category: "Hielo", amountCents: 30_000, payableCents: 30_000, date: new Date(`${today}T17:00:00.000Z`) },
    });
    await noteId({ totalCents: 30_000, kind: "discount" });
    expect((await db.expense.findUniqueOrThrow({ where: { id: expense.id } })).paidCents).toBe(30_000);
    const { by } = await journal();
    expect(by("supplier_credit_apply")).toEqual({ "233505": 30_000, "133005": -30_000 });
    expect(by("expense_payment")).toEqual({});
  });
});

describe("saldo a favor después", () => {
  it("una factura nueva consume el saldo a favor (uso automático)", async () => {
    await noteId({ totalCents: 80_000 });
    const id = await purchase(50_000);
    const r = await applySupplierCreditToDoc(restaurantId, { kind: "purchase", id }, null);
    expect(r.appliedCents).toBe(50_000);
    expect((await po(id)).paidCents).toBe(50_000);
    expect(await available()).toBe(30_000);
  });

  it("aplicar el saldo de una nota a facturas pendientes (FIFO)", async () => {
    const n = await noteId({ totalCents: 40_000 });
    const id = await purchase(25_000);
    expect((await applyCreditNote(restaurantId, n, null, null)).appliedCents).toBe(25_000);
    expect((await po(id)).paidCents).toBe(25_000);
  });

  it("reintegro en dinero: D banco · C saldo a favor, sin pasar el saldo", async () => {
    const n = await noteId({ totalCents: 40_000 });
    await createCreditRefund(restaurantId, n, { amountCents: 15_000, date: today, accountCode: "111005" }, null);
    expect(await available()).toBe(25_000);
    await expect(createCreditRefund(restaurantId, n, { amountCents: 30_000, date: today, accountCode: "111005" }, null)).rejects.toMatchObject({
      code: "exceeds_available",
    });
    await expect(createCreditRefund(restaurantId, n, { amountCents: 1, date: today, accountCode: "613575" }, null)).rejects.toMatchObject({
      code: "account_invalid",
    });
    const { by } = await journal();
    expect(by("supplier_credit_refund")).toEqual({ "111005": 15_000, "133005": -15_000 });
  });
});

describe("anulación", () => {
  it("deshace los cruces, el saldo y asienta el reverso; no se borra el abono desde la compra", async () => {
    const id = await purchase(100_000);
    const n = await noteId({ totalCents: 60_000 });
    const cross = await db.purchasePayment.findFirstOrThrow({ where: { purchaseOrderId: id, supplierCreditNoteId: n } });
    const del = await deletePaymentRoute(new Request("http://localhost", { method: "DELETE" }), {
      params: Promise.resolve({ id, paymentId: cross.id }),
    });
    expect(del.status).toBe(409);

    const res = await voidNoteRoute(new Request("http://localhost", json({ reason: "Error de digitación" })), { params: Promise.resolve({ id: n }) });
    expect(res.status).toBe(200);
    expect(await po(id)).toMatchObject({ paidCents: 0, paidAt: null });
    expect(await db.supplierCreditNote.findUniqueOrThrow({ where: { id: n } })).toMatchObject({ status: "voided", voidReason: "Error de digitación" });
    const { by } = await journal();
    // El original y su reverso se netean; los cruces (filas borradas) ya no se asientan.
    expect(by("supplier_credit_note")).toEqual({ "133005": 60_000, "613575": -60_000 });
    expect(by("supplier_credit_note_void")).toEqual({ "133005": -60_000, "613575": 60_000 });
    expect(by("supplier_credit_apply")).toEqual({});
  });

  it("con reintegros no se puede anular", async () => {
    const n = await noteId({ totalCents: 10_000 });
    await createCreditRefund(restaurantId, n, { amountCents: 10_000, date: today, accountCode: "110505" }, null);
    await expect(voidSupplierCreditNote(restaurantId, n, null, null)).rejects.toMatchObject({ code: "has_refunds" });
  });

  it("no se registra una nota fechada en un mes cerrado", async () => {
    await db.accountingConfig.create({ data: { restaurantId, closedThrough: "2026-01" } });
    const res = await note({ date: "2026-01-15" });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("month_closed");
  });
});

describe("duplicados", () => {
  it("mismo proveedor (o mismo NIT) y número normalizado; las anuladas no cuentan; mismo CUDE", async () => {
    const first = await noteId({ number: "NC-000123", cude: "ABC123" });
    const again = await note({ number: "nc 123" });
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ error: "duplicate_credit_note", duplicate: { id: first, reason: "number" } });

    const twin = await db.supplier.create({ data: { restaurantId, name: "Cervecería Andina S.A.S.", taxId: "900100200" } });
    const viaNit = await note({ supplierId: twin.id, number: "NC-123" });
    expect(viaNit.status).toBe(409);

    const byCude = await note({ number: "NC-999", cude: "abc123" });
    expect((await byCude.json()).duplicate.reason).toBe("cude");

    await voidSupplierCreditNote(restaurantId, first, null, null);
    expect((await note({ number: "NC-123" })).status).toBe(201);
  });
});

describe("devolución con kardex", () => {
  it("saca del inventario al costo de la nota, acredita 1435 y la anulación lo devuelve", async () => {
    const id = await purchase(100_000, { units: 10 });
    const item = await db.purchaseOrderItem.findFirstOrThrow({ where: { purchaseOrderId: id } });
    const before = await db.stockLevel.findUniqueOrThrow({ where: { ingredientId } });
    const n = await noteId({
      kind: "return",
      totalCents: 20_000,
      relatedPurchaseIds: [id],
      lines: [{ ingredientId, purchaseOrderItemId: item.id, qtyBase: 2_000, valueCents: 20_000 }],
    });
    const after = await db.stockLevel.findUniqueOrThrow({ where: { ingredientId } });
    expect(after.qtyBase).toBe(before.qtyBase - 2_000);
    expect(after.totalValueCents).toBe(before.totalValueCents - 20_000);
    expect(await db.stockMovement.count({ where: { supplierCreditNoteId: n, kind: "purchase_return" } })).toBe(1);
    // La devolución se cruza con su factura.
    expect((await po(id)).paidCents).toBe(20_000);
    const { by } = await journal();
    expect(by("supplier_credit_note")).toEqual({ "133005": 20_000, "143505": -20_000 });

    await voidSupplierCreditNote(restaurantId, n, null, null);
    const restored = await db.stockLevel.findUniqueOrThrow({ where: { ingredientId } });
    expect(restored).toMatchObject({ qtyBase: before.qtyBase, totalValueCents: before.totalValueCents });
  });

  it("una devolución exige la factura y líneas que sumen la base", async () => {
    expect((await (await note({ kind: "return", totalCents: 1_000 })).json()).error).toBe("return_needs_invoice");
    const id = await purchase(10_000);
    const bad = await note({ kind: "return", totalCents: 1_000, relatedPurchaseIds: [id], lines: [{ ingredientId, qtyBase: 1_000, valueCents: 900 }] });
    expect((await bad.json()).error).toBe("lines_mismatch");
  });
});

describe("IVA discriminado", () => {
  it("con IVA y comercio que lo descuenta: baja 24081001 y el reporte de impuestos cuadra con el libro", async () => {
    await use(await tenant("IVA descontable", { ivaDeductible: true }));
    await purchase(1_000_000, { taxPct: 19 });
    await noteId({ kind: "discount", totalCents: 119_000, ivaPct: 19, ivaCents: 19_000, applications: [] });
    const { by } = await journal();
    expect(by("supplier_credit_note")).toEqual({ "133005": 119_000, "613570": -100_000, "24081001": -19_000 });
    const report = await loadTaxesReport(restaurantId, { desde: `${MONTH}-01`, hasta: today });
    const iva19 = report.documental.purchases.find((b) => b.key === "iva:19")!;
    expect(iva19.creditNoteTaxCents).toBe(19_000);
    expect(report.documental.totals.ivaDescontableCents).toBe(190_000 - 19_000);
  });

  it("sin IVA discriminado: el IVA no se toca", async () => {
    await use(await tenant("Sin IVA", { ivaDeductible: true }));
    await noteId({ kind: "discount", totalCents: 119_000, applications: [] });
    const { by } = await journal();
    expect(by("supplier_credit_note")).toEqual({ "133005": 119_000, "613570": -119_000 });
  });
});

describe("reporte y aislamiento", () => {
  it("totales por tipo y acuerdo del período", async () => {
    await noteId({ totalCents: 300_000, agreement: "Bonificación cerveza" });
    await noteId({ totalCents: 200_000, agreement: "bonificación cerveza" });
    await noteId({ kind: "conditional_discount", totalCents: 10_000 });
    const voided = await noteId({ kind: "discount", totalCents: 99_000 });
    await voidSupplierCreditNote(restaurantId, voided, null, null);
    const r = await loadSupplierCreditReport(restaurantId, { desde: `${MONTH}-01`, hasta: today });
    expect(r.byKind.map((k) => [k.kind, k.totalCents])).toEqual([
      ["agreement", 500_000],
      ["conditional_discount", 10_000],
    ]);
    expect(r.byAgreement).toEqual([expect.objectContaining({ count: 2, totalCents: 500_000 })]);
  });

  it("otro comercio no ve, no anula, no aplica ni relaciona compras ajenas", async () => {
    const mineId = await purchase(10_000);
    const mine = await noteId({ totalCents: 5_000, applications: [] });
    const own = { restaurantId, supplierId };
    await use(await tenant("Otro comercio"));
    const list = await (await listNotes(new Request("http://localhost/api/operator/supplier-credit-notes"))).json();
    expect(list.total).toBe(0);
    const voidRes = await voidNoteRoute(new Request("http://localhost", json({})), { params: Promise.resolve({ id: mine }) });
    expect(voidRes.status).toBe(404);
    await expect(applyCreditNote(restaurantId, mine, null, null)).rejects.toMatchObject({ code: "not_found" });
    const foreignSupplier = await note({ supplierId: own.supplierId });
    expect(foreignSupplier.status).toBe(404);
    const foreignInvoice = await note({ relatedPurchaseIds: [mineId] });
    expect((await foreignInvoice.json()).error).toBe("purchase_not_found");
    await expect(applySupplierCreditToDoc(restaurantId, { kind: "purchase", id: mineId }, null)).rejects.toMatchObject({ code: "not_found" });
  });
});
