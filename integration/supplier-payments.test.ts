import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { db } from "../src/lib/db";
import { POST as createOrder } from "../src/app/api/operator/purchase-orders/route";
import { POST as payOrder } from "../src/app/api/operator/purchase-orders/[id]/payments/route";
import { DELETE as deletePayment } from "../src/app/api/operator/purchase-orders/[id]/payments/[paymentId]/route";
import { POST as createNote } from "../src/app/api/operator/supplier-credit-notes/route";
import { POST as createPaymentRoute } from "../src/app/api/operator/supplier-payments/route";
import { applySupplierCreditToDoc, createSupplierPayment, voidSupplierPayment } from "../src/lib/erp/supplierPaymentService";
import { generateJournalForMonth } from "../src/lib/erp/posting";
import { monthRange } from "../src/lib/erp/accounting";
import { loadSupplierCreditBalances } from "../src/lib/erp/reports/supplierCreditCartera";

/**
 * «Pagar a proveedor» contra PostgreSQL real: primero las notas crédito
 * (relacionadas a su factura, las demás FIFO), luego el dinero FIFO por
 * vencimiento; pago parcial; excedente → anticipo que consume la factura
 * siguiente; anulación con reverso y sus bloqueos; consecutivo bajo
 * concurrencia; el abono desde la compra es un comprobante; asientos y
 * aislamiento por comercio.
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

async function tenant(name: string) {
  const r = await db.restaurant.create({
    data: { name, slug: `pay-sup-${randomUUID()}`, enabledModules: ["accounting", "purchasing", "inventory"] },
  });
  tenants.push(r.id);
  const supplier = await db.supplier.create({ data: { restaurantId: r.id, name: "Lácteos del Norte", taxId: "800.200.300" } });
  const ingredient = await db.ingredient.create({ data: { restaurantId: r.id, name: "Leche", measureKind: "volume" } });
  restaurantId = r.id;
  supplierId = supplier.id;
  ingredientId = ingredient.id;
  scope.restaurantId = r.id;
}

beforeEach(async () => {
  await tenant("Pagos a proveedores");
});

afterAll(async () => {
  if (tenants.length) {
    const where = { restaurantId: { in: tenants } };
    await db.journalEntry.deleteMany({ where });
    await db.supplierPayment.deleteMany({ where });
    await db.supplierCreditNote.deleteMany({ where });
    await db.stockMovement.deleteMany({ where });
    await db.expense.deleteMany({ where });
    await db.purchaseOrder.deleteMany({ where });
    await db.restaurant.deleteMany({ where: { id: { in: tenants } } });
  }
  await db.$disconnect();
});

const json = (body: unknown) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

async function purchase(netCents: number, dueAt: string) {
  const res = await createOrder(
    new Request(
      "http://localhost/api/operator/purchase-orders",
      json({
        supplierId,
        lines: [{ ingredientId, qtyBase: 1_000, expectedCostCents: netCents, taxPct: 0 }],
        receive: { supplierInvoiceNumber: `FE-${randomUUID().slice(0, 5)}`, invoiceDueAt: dueAt, retefuenteCents: 0, reteIvaCents: 0, reteIcaCents: 0 },
      }),
    ),
  );
  expect(res.status).toBe(201);
  return (await res.json()).order.id as string;
}
const po = (id: string) => db.purchaseOrder.findUniqueOrThrow({ where: { id }, select: { paidCents: true, paidAt: true } });
const P = (id: string) => ({ kind: "purchase" as const, id });

async function journal() {
  await generateJournalForMonth(restaurantId, MONTH, monthRange(MONTH)!);
  const entries = await db.journalEntry.findMany({ where: { restaurantId }, include: { lines: true } });
  return (source: string) => {
    const net = new Map<string, number>();
    for (const e of entries.filter((x) => x.source === source)) {
      for (const l of e.lines) net.set(l.accountCode, (net.get(l.accountCode) ?? 0) + Number(l.debitCents) - Number(l.creditCents));
    }
    return Object.fromEntries([...net].filter(([, v]) => v !== 0));
  };
}

describe("pagar a proveedor", () => {
  it("notas primero (la relacionada a su factura, la otra FIFO), luego el dinero FIFO; asientos", async () => {
    const late = await purchase(50_000, "2026-12-30T17:00:00.000Z");
    const early = await purchase(30_000, "2026-01-05T17:00:00.000Z");
    const mid = await purchase(20_000, "2026-06-01T17:00:00.000Z");
    const rel = await createNote(new Request("http://localhost", json({ supplierId, number: "NC-1", date: today, kind: "discount", totalCents: 10_000, relatedPurchaseIds: [late], applications: [] })));
    const free = await createNote(new Request("http://localhost", json({ supplierId, number: "NC-2", date: today, kind: "agreement", totalCents: 25_000, applications: [] })));
    const relId = (await rel.json()).id;
    const freeId = (await free.json()).id;

    const res = await createPaymentRoute(
      new Request(
        "http://localhost",
        json({
          supplierId,
          date: today,
          accountCode: "111005",
          method: "transfer",
          amountCents: 40_000,
          docs: [P(early), P(mid), P(late)],
          credits: [
            { source: "note", id: relId },
            { source: "note", id: freeId },
          ],
          expectedNetCents: 65_000,
        }),
      ),
    );
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(201);
    expect(body.number).toBe(1);
    expect(body.totals).toMatchObject({ creditsCents: 35_000, appliedMoneyCents: 40_000, advanceCents: 0, leftUnpaidCents: 25_000 });
    // early: 25.000 de NC-2 + 5.000 de dinero; mid: 20.000 de dinero; late: 10.000 de NC-1 + 15.000 de dinero.
    expect((await po(early)).paidCents).toBe(30_000);
    expect((await po(mid)).paidCents).toBe(20_000);
    expect((await po(late)).paidCents).toBe(25_000);

    const by = await journal();
    expect(by("supplier_payment")).toEqual({ "220505": 40_000, "111005": -40_000 });
    expect(by("supplier_credit_apply")).toEqual({ "220505": 35_000, "133005": -35_000 });
    // Las filas del comprobante no van a «Pagos a proveedores».
    expect(by("purchase_payment")).toEqual({});
  });

  it("si se paga de más, el excedente es anticipo (133005) y lo consume la factura siguiente", async () => {
    const a = await purchase(10_000, "2026-01-05T17:00:00.000Z");
    const r = await createSupplierPayment(restaurantId, { supplierId, date: today, accountCode: "110505", amountCents: 16_000, docs: [P(a)], credits: [] }, null, { allowAdvance: true });
    expect(r.plan.totals.advanceCents).toBe(6_000);
    expect(await loadSupplierCreditBalances(restaurantId, today)).toEqual([expect.objectContaining({ supplierId, availableCents: 6_000 })]);
    const next = await purchase(4_000, "2026-02-05T17:00:00.000Z");
    expect((await applySupplierCreditToDoc(restaurantId, P(next), null)).appliedCents).toBe(4_000);
    expect((await po(next)).paidCents).toBe(4_000);
    const by = await journal();
    expect(by("supplier_payment")).toEqual({ "220505": 10_000, "133005": 6_000, "110505": -16_000 });
    expect(by("supplier_credit_apply")).toEqual({ "220505": 4_000, "133005": -4_000 });
    // Su anticipo ya se usó en otra factura: no se puede anular.
    await expect(voidSupplierPayment(restaurantId, r.id, null, null)).rejects.toMatchObject({ code: "advance_used" });
  });

  it("anular: las facturas vuelven a deber, las notas recuperan su saldo y el reverso se asienta", async () => {
    const a = await purchase(30_000, "2026-01-05T17:00:00.000Z");
    const n = await createNote(new Request("http://localhost", json({ supplierId, number: "NC-9", date: today, kind: "agreement", totalCents: 10_000, applications: [] })));
    const noteId = (await n.json()).id;
    const r = await createSupplierPayment(restaurantId, { supplierId, date: today, accountCode: "111005", amountCents: 20_000, docs: [P(a)], credits: [{ source: "note", id: noteId }] }, null);
    expect((await po(a)).paidCents).toBe(30_000);
    await voidSupplierPayment(restaurantId, r.id, "Banco rechazó", null);
    expect(await po(a)).toMatchObject({ paidCents: 0, paidAt: null });
    expect((await loadSupplierCreditBalances(restaurantId, today))[0]).toMatchObject({ availableCents: 10_000 });
    const by = await journal();
    expect(by("supplier_payment")).toEqual({ "220505": 20_000, "111005": -20_000 });
    expect(by("supplier_payment_void")).toEqual({ "220505": -20_000, "111005": 20_000 });
    await expect(voidSupplierPayment(restaurantId, r.id, null, null)).rejects.toMatchObject({ code: "already_voided" });
  });

  it("el neto que vio el operador protege de cambios entre la vista previa y el pago", async () => {
    const a = await purchase(30_000, "2026-01-05T17:00:00.000Z");
    await expect(
      createSupplierPayment(restaurantId, { supplierId, date: today, accountCode: "111005", amountCents: 10_000, docs: [P(a)], credits: [], expectedNetCents: 29_000 }, null),
    ).rejects.toMatchObject({ code: "plan_changed" });
    await expect(
      createSupplierPayment(restaurantId, { supplierId, date: today, accountCode: "220505", amountCents: 10_000, docs: [P(a)], credits: [] }, null),
    ).rejects.toMatchObject({ code: "account_invalid" });
  });

  it("dos pagos simultáneos al mismo proveedor: consecutivos distintos y nunca pagan de más", async () => {
    const a = await purchase(30_000, "2026-01-05T17:00:00.000Z");
    const pay = () =>
      createSupplierPayment(restaurantId, { supplierId, date: today, accountCode: "111005", amountCents: 20_000, docs: [P(a)], credits: [] }, null);
    const results = await Promise.allSettled([pay(), pay()]);
    const ok = results.filter((x) => x.status === "fulfilled") as PromiseFulfilledResult<{ number: number }>[];
    const failed = results.filter((x) => x.status === "rejected") as PromiseRejectedResult[];
    // La segunda ve el saldo que dejó la primera (10.000) y no puede pagar 20.000 sin anticipo.
    expect(ok).toHaveLength(1);
    expect(failed[0]!.reason).toMatchObject({ code: "exceeds_balance" });
    expect((await po(a)).paidCents).toBe(20_000);
    const b = await purchase(10_000, "2026-02-05T17:00:00.000Z");
    const both = await Promise.all([
      createSupplierPayment(restaurantId, { supplierId, date: today, accountCode: "111005", amountCents: 1_000, docs: [P(b)], credits: [] }, null),
      createSupplierPayment(restaurantId, { supplierId, date: today, accountCode: "111005", amountCents: 1_000, docs: [P(b)], credits: [] }, null),
    ]);
    expect(new Set(both.map((x) => x.number)).size).toBe(2);
  });

  it("el abono desde la compra es un comprobante de UNA factura; borrarlo anula el comprobante", async () => {
    const a = await purchase(30_000, "2026-01-05T17:00:00.000Z");
    const res = await payOrder(new Request("http://localhost", json({ amountCents: 12_000, accountCode: "110505" })), { params: Promise.resolve({ id: a }) });
    const body = await res.json();
    expect(res.status).toBe(201);
    expect(body.voucher.number).toBe(1);
    expect((await po(a)).paidCents).toBe(12_000);
    const over = await payOrder(new Request("http://localhost", json({ amountCents: 99_000, accountCode: "110505" })), { params: Promise.resolve({ id: a }) });
    expect((await over.json()).error).toBe("exceeds_balance");
    const del = await deletePayment(new Request("http://localhost", { method: "DELETE" }), { params: Promise.resolve({ id: a, paymentId: body.payment.id }) });
    expect(del.status).toBe(200);
    expect((await po(a)).paidCents).toBe(0);
    expect((await db.supplierPayment.findUniqueOrThrow({ where: { id: body.voucher.id } })).status).toBe("voided");
  });

  it("otro comercio no paga ni anula comprobantes ajenos", async () => {
    const a = await purchase(30_000, "2026-01-05T17:00:00.000Z");
    const mine = await createSupplierPayment(restaurantId, { supplierId, date: today, accountCode: "111005", amountCents: 1_000, docs: [P(a)], credits: [] }, null);
    const ownSupplier = supplierId;
    await tenant("Otro comercio");
    await expect(voidSupplierPayment(restaurantId, mine.id, null, null)).rejects.toMatchObject({ code: "not_found" });
    await expect(
      createSupplierPayment(restaurantId, { supplierId: ownSupplier, date: today, accountCode: "111005", amountCents: 1_000, docs: [P(a)], credits: [] }, null),
    ).rejects.toMatchObject({ code: "supplier_not_found" });
    await expect(
      createSupplierPayment(restaurantId, { supplierId, date: today, accountCode: "111005", amountCents: 1_000, docs: [P(a)], credits: [] }, null),
    ).rejects.toMatchObject({ code: "plan_changed" });
  });
});
