import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { db } from "../src/lib/db";
import { loadPayablesDocs } from "../src/lib/erp/reports/carteraQueries";
import { parseSupplierReportQuery } from "../src/lib/erp/reports/supplierReport";
import { loadSupplierReportRows } from "../src/lib/erp/reports/supplierReportQueries";

const url = new URL(process.env.DATABASE_URL ?? "postgresql://localhost/invalid");
if (!["127.0.0.1", "localhost"].includes(url.hostname) || !/^\/mesapay_.*(?:test|validation)$/.test(url.pathname)) {
  throw new Error("Isolated local database required");
}

// Hoy fijo: el período por defecto es nov 2025 – oct 2026 (12 meses).
const TODAY = "2026-11-13";
const at = (iso: string) => new Date(`${iso}T15:00:00Z`);

let tenantIds: string[] = [];
const ids = { a: "", b: "", s1: "", s2: "", s3: "", other: "" };
let orderNumber = 1;

async function purchase(opts: {
  restaurantId: string;
  supplierId: string;
  ingredientId: string;
  status: "draft" | "sent" | "partially_received" | "received" | "canceled";
  createdAt: string;
  receivedAt?: string | null;
  netCents: number;
  receivedNetCents: number;
  taxPct?: number;
  /** Recepciones (kardex): fecha y valor. */
  receptions?: { date: string; valueCents: number }[];
}) {
  const order = await db.purchaseOrder.create({
    data: {
      restaurantId: opts.restaurantId,
      supplierId: opts.supplierId,
      number: orderNumber++,
      status: opts.status,
      createdAt: at(opts.createdAt),
      receivedAt: opts.receivedAt ? at(opts.receivedAt) : null,
      items: {
        create: [
          {
            ingredientId: opts.ingredientId,
            qtyOrderedBase: 10,
            expectedCostCents: opts.netCents,
            taxPct: opts.taxPct ?? 0,
            receivedQtyBase: opts.netCents > 0 ? Math.round((10 * opts.receivedNetCents) / opts.netCents) : 0,
            receivedCostCents: opts.receivedNetCents,
          },
        ],
      },
    },
  });
  for (const r of opts.receptions ?? []) {
    await db.stockMovement.create({
      data: {
        restaurantId: opts.restaurantId,
        ingredientId: opts.ingredientId,
        kind: "purchase_in",
        qtyBase: 1,
        valueCents: r.valueCents,
        purchaseOrderId: order.id,
        createdAt: at(r.date),
      },
    });
  }
  return order;
}

beforeAll(async () => {
  const a = await db.restaurant.create({
    data: { name: "Supplier report A", slug: `supplier-report-a-${randomUUID()}`, enabledModules: ["purchasing", "accounting"], purchaseIvaDeductible: false },
  });
  const b = await db.restaurant.create({
    data: { name: "Supplier report B", slug: `supplier-report-b-${randomUUID()}`, enabledModules: ["purchasing"] },
  });
  tenantIds = [a.id, b.id];
  ids.a = a.id;
  ids.b = b.id;
  ids.s1 = (await db.supplier.create({ data: { restaurantId: a.id, name: "Lácteos validación", taxId: "900123456-7", paymentTermsDays: 30 } })).id;
  ids.s2 = (await db.supplier.create({ data: { restaurantId: a.id, name: "Sin compras validación" } })).id;
  ids.s3 = (await db.supplier.create({ data: { restaurantId: a.id, name: "Servicios validación", taxId: "1020304050", taxIdType: "CC" } })).id;
  // Mismo nombre en OTRO comercio, con una compra grande en el período.
  ids.other = (await db.supplier.create({ data: { restaurantId: b.id, name: "Lácteos validación", taxId: "900123456-7" } })).id;
  const ingA = (await db.ingredient.create({ data: { restaurantId: a.id, name: "Leche validación", measureKind: "count" } })).id;
  const ingB = (await db.ingredient.create({ data: { restaurantId: b.id, name: "Leche validación", measureKind: "count" } })).id;

  // Recibida en enero con IVA no descontable (el kardex entró al bruto).
  await purchase({ restaurantId: a.id, supplierId: ids.s1, ingredientId: ingA, status: "received", createdAt: "2026-01-18", receivedAt: "2026-01-20", netCents: 1_000_000, receivedNetCents: 1_000_000, taxPct: 19, receptions: [{ date: "2026-01-20", valueCents: 1_190_000 }] });
  // Recibida ANTES del período: no suma, pero sí pesa en el saldo.
  await purchase({ restaurantId: a.id, supplierId: ids.s1, ingredientId: ingA, status: "received", createdAt: "2025-10-10", receivedAt: "2025-10-15", netCents: 5_000_000, receivedNetCents: 5_000_000, receptions: [{ date: "2025-10-15", valueCents: 5_000_000 }] });
  // Anulada (aun con montos «recibidos» puestos a mano) y borrador: no son compras.
  await purchase({ restaurantId: a.id, supplierId: ids.s1, ingredientId: ingA, status: "canceled", createdAt: "2026-02-01", receivedAt: "2026-02-02", netCents: 7_000_000, receivedNetCents: 7_000_000 });
  await purchase({ restaurantId: a.id, supplierId: ids.s1, ingredientId: ingA, status: "draft", createdAt: "2026-02-03", netCents: 3_000_000, receivedNetCents: 0 });
  // Recibida a medias: cuenta lo recibido, fechada en la primera recepción.
  await purchase({ restaurantId: a.id, supplierId: ids.s1, ingredientId: ingA, status: "partially_received", createdAt: "2026-02-25", netCents: 400_000, receivedNetCents: 200_000, receptions: [{ date: "2026-03-05", valueCents: 200_000 }] });

  await db.expense.createMany({
    data: [
      { restaurantId: a.id, supplierId: ids.s3, category: "Servicios", amountCents: 300_000, date: at("2026-05-15") },
      // Plantilla recurrente: no es un gasto.
      { restaurantId: a.id, supplierId: ids.s3, category: "Servicios", amountCents: 999_999, date: at("2026-06-01"), recurring: true, recurringDay: 1 },
      // Sin proveedor: no es de nadie en este informe.
      { restaurantId: a.id, category: "Varios", amountCents: 50_000, date: at("2026-05-20") },
    ],
  });

  await purchase({ restaurantId: b.id, supplierId: ids.other, ingredientId: ingB, status: "received", createdAt: "2026-04-01", receivedAt: "2026-04-02", netCents: 9_000_000, receivedNetCents: 9_000_000, receptions: [{ date: "2026-04-02", valueCents: 9_000_000 }] });
});

afterAll(async () => {
  await db.stockMovement.deleteMany({ where: { restaurantId: { in: tenantIds } } });
  await db.purchaseOrder.deleteMany({ where: { restaurantId: { in: tenantIds } } });
  await db.expense.deleteMany({ where: { restaurantId: { in: tenantIds } } });
  await db.restaurant.deleteMany({ where: { id: { in: tenantIds } } });
  await db.$disconnect();
});

const query = (raw: Record<string, string> = {}) => parseSupplierReportQuery(raw, TODAY);
const byId = async (restaurantId: string, raw: Record<string, string> = {}) =>
  new Map((await loadSupplierReportRows(restaurantId, query(raw), TODAY)).map((r) => [r.supplierId, r]));

describe("informe de proveedores contra la base", () => {
  it("promedio = total del período ÷ 12 meses; anuladas, borradores y lo de antes del período no suman", async () => {
    const rows = await byId(ids.a);
    expect(rows.get(ids.s1)).toMatchObject({
      name: "Lácteos validación",
      document: { type: "NIT", number: "900123456", dv: "7" },
      creditDays: 30,
      // 1.190.000 (enero, con el IVA no descontable) + 200.000 (lo recibido de la parcial).
      totalCents: 1_390_000,
      averageCents: Math.round(1_390_000 / 12),
      invoices: 2,
      lastPurchase: "2026-03-05",
    });
  });

  it("total facturado: neto + IVA", async () => {
    const rows = await byId(ids.a, { base: "total" });
    expect(rows.get(ids.s1)).toMatchObject({ totalCents: 1_390_000, invoices: 2 });
  });

  it("proveedor sin compras: sale en cero", async () => {
    const rows = await byId(ids.a);
    expect(rows.get(ids.s2)).toMatchObject({ totalCents: 0, averageCents: 0, invoices: 0, lastPurchase: null, payableCents: 0, creditDays: null });
  });

  it("gastos con proveedor: entran con «incluir gastos» (sin la plantilla recurrente) y salen con «solo compras»", async () => {
    const withExpenses = await byId(ids.a);
    expect(withExpenses.get(ids.s3)).toMatchObject({ totalCents: 300_000, averageCents: 25_000, invoices: 1, lastPurchase: "2026-05-15", payableCents: 300_000 });
    const purchasesOnly = await byId(ids.a, { gastos: "no" });
    expect(purchasesOnly.get(ids.s3)).toMatchObject({ totalCents: 0, invoices: 0, lastPurchase: null, payableCents: 0 });
  });

  it("el saldo por pagar es el de la cartera de hoy", async () => {
    const docs = await loadPayablesDocs(ids.a, TODAY);
    const expected = docs.filter((d) => d.partnerId === ids.s1).reduce((s, d) => s + d.outstandingCents, 0);
    expect(expected).toBe(1_190_000 + 5_000_000 + 200_000);
    expect((await byId(ids.a)).get(ids.s1)?.payableCents).toBe(expected);
  });

  it("aislamiento por comercio: nada del proveedor homónimo de otro comercio", async () => {
    const a = await byId(ids.a);
    expect([...a.keys()].sort()).toEqual([ids.s1, ids.s2, ids.s3].sort());
    const b = await byId(ids.b);
    expect([...b.keys()]).toEqual([ids.other]);
    expect(b.get(ids.other)).toMatchObject({ totalCents: 9_000_000, invoices: 1, payableCents: 9_000_000 });
  });
});
