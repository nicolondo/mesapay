import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { db } from "../src/lib/db";
import { monthRange } from "../src/lib/erp/accounting";
import { regenerateMonth } from "../src/lib/erp/autoJournal";
import { createPurchaseOrder, receivePurchaseOrder } from "../src/lib/erp/purchasing";
import { generateJournalForMonth } from "../src/lib/erp/posting";
import { loadTaxesReport } from "../src/lib/erp/reports/taxesReport";
import { loadTaxesDrillBase, loadTaxesTrend, taxChecks } from "../src/lib/erp/reports/taxesDrillReport";
import { issueSimpleInvoice } from "../src/lib/simpleInvoice";

/**
 * Motor contable contra PostgreSQL real, los dos arreglos de la revisión de
 * impuestos (#574):
 *
 *  1. El impuesto que las LÍNEAS LIBRES suman encima (IVA/INC propio de un
 *     servicio) llega al IVA/INC generado y no al ingreso; la base sí queda
 *     en 4135. Facturado: lo que declaró la factura. Sin factura: las
 *     líneas del pedido, y el INC embebido sólo sobre lo de la carta.
 *  2. Con `purchaseIvaDeductible = false` el IVA de las compras es costo:
 *     el de las inventariables va a 143505 (el kardex ya lo valoró al
 *     bruto) y el de las no inventariables al gasto; nada a 2408. Con IVA
 *     descontable, el asiento es el de siempre.
 *
 * Y que «Impuestos del período» (documentos vs libro) cuadra en cero.
 */
vi.mock("../src/lib/events", () => ({ publishOrderEvent: vi.fn() }));
const database = new URL(process.env.DATABASE_URL ?? "postgresql://localhost/invalid");
if (!["localhost", "127.0.0.1"].includes(database.hostname) || !/^\/mesapay_.*(?:test|validation)$/.test(database.pathname)) {
  throw new Error("Isolated local database required");
}

const MONTH = "2026-10";
const RANGE = monthRange(MONTH)!;
/** 13:00 en Bogotá del 15-oct: día de negocio 2026-10-15 con cualquier corte. */
const PAID_AT = new Date("2026-10-15T18:00:00Z");
const DAY_DATE = new Date("2026-10-15T05:00:00.000Z");
const PERIOD = { desde: "2026-10-01", hasta: "2026-10-31" };

type Line = { accountCode: string; debitCents: number; creditCents: number };
type Fixture = { restaurantId: string; tableId: string; categoryId: string };
const tenants: string[] = [];

async function tenant(purchaseIvaDeductible: boolean): Promise<Fixture> {
  const r = await db.restaurant.create({
    data: {
      name: `Motor IVA ${purchaseIvaDeductible ? "descontable" : "no descontable"}`,
      slug: `motor-iva-${randomUUID()}`,
      salesTaxKind: "inc",
      salesTaxPct: 8,
      businessDayCutoffHour: 5,
      purchaseIvaDeductible,
      enabledModules: ["accounting", "purchasing", "inventory"],
    },
  });
  tenants.push(r.id);
  const table = await db.table.create({ data: { restaurantId: r.id, number: 1, qrToken: randomUUID() } });
  const category = await db.category.create({ data: { restaurantId: r.id, slug: "platos", label: "Platos" } });
  return { restaurantId: r.id, tableId: table.id, categoryId: category.id };
}

type ItemSpec = { name: string; priceCents: number; qty?: number; taxKind?: "inc" | "iva" | "none"; taxPct?: number };

/** Cuenta pagada en efectivo el 15-oct con sus líneas (carta y libres). */
async function paidOrder(f: Fixture, items: ItemSpec[], opts: { invoice?: "issue" | Prisma.InputJsonValue } = {}) {
  const subtotal = items.reduce((s, i) => s + i.priceCents * (i.qty ?? 1), 0);
  const onTop = items.reduce(
    (s, i) => s + (i.taxKind && i.taxKind !== "none" ? Math.round((i.priceCents * (i.qty ?? 1) * (i.taxPct ?? 0)) / 100) : 0),
    0,
  );
  const total = subtotal + onTop;
  const order = await db.order.create({
    data: {
      restaurantId: f.restaurantId,
      tableId: f.tableId,
      shortCode: randomUUID(),
      status: "paid",
      subtotalCents: subtotal,
      taxCents: onTop,
      totalCents: total,
      paidAt: PAID_AT,
    },
  });
  for (const i of items) {
    const menuItemId = i.taxKind
      ? null
      : (await db.menuItem.create({ data: { restaurantId: f.restaurantId, categoryId: f.categoryId, name: i.name, priceCents: i.priceCents } })).id;
    await db.orderItem.create({
      data: {
        orderId: order.id,
        menuItemId,
        qty: i.qty ?? 1,
        nameSnapshot: i.name,
        priceCentsSnapshot: i.priceCents,
        taxKind: i.taxKind ?? null,
        taxPct: i.taxKind ? (i.taxPct ?? 0) : null,
      },
    });
  }
  await db.payment.create({
    data: { orderId: order.id, method: "cash", status: "approved", amountCents: total, settledAt: PAID_AT },
  });
  if (opts.invoice === "issue") {
    const issued = await issueSimpleInvoice({ tenantId: f.restaurantId, orderId: order.id });
    expect(issued.ok).toBe(true);
  } else if (opts.invoice) {
    await db.simpleInvoice.create({
      data: { restaurantId: f.restaurantId, orderId: order.id, invoiceNumber: 900, totalCents: total, snapshot: opts.invoice },
    });
  }
  return order;
}

/** Compra recibida en dos entregas: insumo de inventario + servicio no inventariable, ambos con IVA 19 %. */
async function receivedPurchase(f: Fixture, deductible: boolean) {
  const supplier = await db.supplier.create({ data: { restaurantId: f.restaurantId, name: "Proveedor IVA" } });
  const tracked = await db.ingredient.create({ data: { restaurantId: f.restaurantId, name: "Queso", measureKind: "mass" } });
  const service = await db.ingredient.create({
    data: { restaurantId: f.restaurantId, name: "Fumigación", measureKind: "count", trackInventory: false },
  });
  const po = await db.$transaction((tx) =>
    createPurchaseOrder(tx, {
      restaurantId: f.restaurantId,
      supplierId: supplier.id,
      lines: [
        { ingredientId: tracked.id, qtyBase: 2_000, expectedCostCents: 100_000, taxPct: 19 },
        { ingredientId: service.id, qtyBase: 1, expectedCostCents: 50_000, taxPct: 19 },
      ],
    }),
  );
  const [cheese, fumigation] = [po.items.find((i) => i.ingredientId === tracked.id)!, po.items.find((i) => i.ingredientId === service.id)!];
  // Recepción PARCIAL y después el resto: el libro asienta la compra
  // completa el día en que quedó recibida.
  const first = await db.$transaction((tx) =>
    receivePurchaseOrder(tx, {
      restaurantId: f.restaurantId,
      purchaseOrderId: po.id,
      ivaDeductible: deductible,
      lines: [{ itemId: cheese.id, qtyBase: 1_000, costCents: 50_000 }],
    }),
  );
  expect(first.complete).toBe(false);
  const second = await db.$transaction((tx) =>
    receivePurchaseOrder(tx, {
      restaurantId: f.restaurantId,
      purchaseOrderId: po.id,
      ivaDeductible: deductible,
      lines: [
        { itemId: cheese.id, qtyBase: 1_000, costCents: 50_000 },
        { itemId: fumigation.id, qtyBase: 1, costCents: 50_000 },
      ],
    }),
  );
  expect(second.complete).toBe(true);
  // La recepción fecha `receivedAt` con el reloj real: se fija en el mes de la prueba.
  await db.purchaseOrder.update({ where: { id: po.id }, data: { receivedAt: PAID_AT } });
  return po;
}

async function engineEntries(restaurantId: string) {
  const entries = await db.journalEntry.findMany({
    where: { restaurantId, sourceRef: MONTH },
    include: { lines: true },
    orderBy: [{ source: "asc" }, { date: "asc" }],
  });
  return entries.map((e) => ({
    source: e.source,
    date: e.date.toISOString(),
    memo: e.memo,
    lines: e.lines
      .map((l) => ({ accountCode: l.accountCode, debitCents: Number(l.debitCents), creditCents: Number(l.creditCents) }))
      .sort((a, b) => a.accountCode.localeCompare(b.accountCode) || a.debitCents - b.debitCents),
  }));
}

const net = (lines: readonly Line[]) => {
  const out = new Map<string, number>();
  for (const l of lines) out.set(l.accountCode, (out.get(l.accountCode) ?? 0) + l.debitCents - l.creditCents);
  return out;
};
const balance = (lines: readonly Line[]) => lines.reduce((s, l) => s + l.debitCents - l.creditCents, 0);

afterAll(async () => {
  if (tenants.length) {
    await db.journalEntry.deleteMany({ where: { restaurantId: { in: tenants } } });
    await db.stockMovement.deleteMany({ where: { restaurantId: { in: tenants } } });
    await db.purchaseOrder.deleteMany({ where: { restaurantId: { in: tenants } } });
    await db.restaurant.deleteMany({ where: { id: { in: tenants } } });
  }
  await db.$disconnect();
});

describe("ventas con líneas libres que suman impuesto encima", () => {
  let invoiced: Fixture;
  let uninvoiced: Fixture;

  beforeAll(async () => {
    invoiced = await tenant(true);
    // Factura emitida con el emisor real: carta con INC 8 % embebido, un
    // alquiler con IVA 19 % y dos meseros con INC 8 % encima.
    await paidOrder(
      invoiced,
      [
        { name: "Bandeja", priceCents: 3_000_000 },
        { name: "Alquiler del salón", priceCents: 10_000_000, taxKind: "iva", taxPct: 19 },
        { name: "Servicio de meseros", priceCents: 1_250_000, qty: 2, taxKind: "inc", taxPct: 8 },
        { name: "Cargo sin impuesto", priceCents: 500_000, taxKind: "none", taxPct: 0 },
      ],
      { invoice: "issue" },
    );
    // Tirilla emitida antes de que el snapshot guardara el impuesto de cada
    // ítem (sep-2026): declara el IVA por tipo, y la tarifa sale del pedido.
    await paidOrder(
      invoiced,
      [
        { name: "Almuerzo", priceCents: 1_080_000 },
        { name: "Decoración", priceCents: 2_000_000, taxKind: "iva", taxPct: 5 },
      ],
      {
        invoice: {
          restaurantName: "Motor IVA",
          shortCode: "OLD1",
          tableLabel: "Mesa 1",
          paidAtIso: PAID_AT.toISOString(),
          items: [
            { qty: 1, name: "Almuerzo", priceCents: 1_080_000 },
            { qty: 1, name: "Decoración", priceCents: 2_000_000 },
          ],
          subtotalCents: 3_080_000,
          taxCents: 100_000,
          taxByKind: { inc: 0, iva: 100_000 },
          salesTaxKind: "inc",
          salesTaxPct: 8,
          embeddedTaxCents: 80_000,
          embeddedBaseCents: 1_000_000,
          tipCents: 0,
          totalCents: 3_180_000,
        },
      },
    );
    await generateJournalForMonth(invoiced.restaurantId, MONTH, RANGE);

    uninvoiced = await tenant(true);
    await paidOrder(uninvoiced, [
      { name: "Bandeja", priceCents: 2_500_000 },
      { name: "Servicio", priceCents: 1_000_000, taxKind: "iva", taxPct: 19 },
    ]);
    await generateJournalForMonth(uninvoiced.restaurantId, MONTH, RANGE);
  });

  it("facturado: la base al ingreso y el impuesto de cada línea libre a su generado, como lo declaró la factura", async () => {
    const invoice = await db.simpleInvoice.findFirstOrThrow({
      where: { restaurantId: invoiced.restaurantId, invoiceNumber: { not: 900 } },
    });
    // El snapshot real congeló el impuesto de las líneas libres por tipo.
    expect(invoice.snapshot).toMatchObject({ taxCents: 2_100_000, taxByKind: { inc: 200_000, iva: 1_900_000 }, embeddedTaxCents: 222_222 });

    const sale = (await engineEntries(invoiced.restaurantId)).filter((e) => e.source === "sale");
    expect(sale).toHaveLength(1);
    expect(sale[0]!.date).toBe(DAY_DATE.toISOString());
    const lines = sale[0]!.lines;
    expect(balance(lines)).toBe(0);
    const byAccount = net(lines);
    // Caja: 18.100.000 (carta + libres + IVA/INC encima) + 3.180.000 (tirilla vieja).
    expect(byAccount.get("110505")).toBe(18_100_000 + 3_180_000);
    // INC: 222.222 embebido + 200.000 de los meseros + 80.000 de la tirilla vieja.
    expect(byAccount.get("241205")).toBe(-(222_222 + 200_000 + 80_000));
    // IVA por tarifa: 19 % del alquiler; 5 % de la decoración (tarifa del pedido).
    expect(byAccount.get("24080501")).toBe(-1_900_000);
    expect(byAccount.get("24080503")).toBe(-100_000);
    // Ingreso = bases: 2.777.778 + 10.000.000 + 2.500.000 + 500.000 + 1.000.000 + 2.000.000.
    expect(byAccount.get("413505")).toBe(-(2_777_778 + 10_000_000 + 2_500_000 + 500_000 + 1_000_000 + 2_000_000));
  });

  it("sin factura: el impuesto encima va al generado y el INC embebido sólo sale de lo de la carta", async () => {
    const sale = (await engineEntries(uninvoiced.restaurantId)).filter((e) => e.source === "sale");
    const byAccount = net(sale[0]!.lines);
    expect(balance(sale[0]!.lines)).toBe(0);
    expect(byAccount.get("110505")).toBe(3_690_000);
    // round(2.500.000 × 8 / 108) = 185.185 — antes se calculaba sobre 3.500.000.
    expect(byAccount.get("241205")).toBe(-185_185);
    expect(byAccount.get("24080501")).toBe(-190_000);
    expect(byAccount.get("413505")).toBe(-(2_500_000 - 185_185 + 1_000_000));
  });

  it("«Impuestos del período»: documentos y libro dicen lo mismo (diferencia 0) en lo facturado", async () => {
    const report = await loadTaxesReport(invoiced.restaurantId, PERIOD);
    expect(report.documental.totals).toMatchObject({ incGeneradoCents: 502_222, ivaGeneradoCents: 2_000_000 });
    for (const key of ["consumo", "iva"] as const) {
      expect(report.cross.find((r) => r.key === key)).toMatchObject({ differenceCents: 0 });
    }
    // #574: la reconciliación del despliegue también da 0, componente por componente.
    const drill = await loadTaxesDrillBase(invoiced.restaurantId, PERIOD);
    for (const r of drill.recon.byTax) {
      expect(r.diffCents, r.tax).toBe(0);
      expect(Object.values(r.components).every((c) => c === 0), r.tax).toBe(true);
    }
    const checks = taxChecks(drill);
    expect(checks.find((c) => c.key === "desactualizado")?.count).toBe(0);
    expect(checks.find((c) => c.key === "sinAsiento")?.count).toBe(0);
    // Las teselas (documentos) y el último punto de la tendencia dicen lo mismo.
    const tiles = new Map(drill.drill.taxes.map((t) => [t.key, t.docCents]));
    expect(tiles.get("inc")).toBe(502_222);
    expect(tiles.get("iva")).toBe(2_000_000);
    const trend = await loadTaxesTrend(invoiced.restaurantId, PERIOD);
    expect(trend.series.inc.at(-1)).toBe(502_222);
    expect(trend.series.iva.at(-1)).toBe(2_000_000);
  });

  it("sin factura, la única diferencia es el impuesto que el motor le causa al pedido (no hay documento)", async () => {
    const report = await loadTaxesReport(uninvoiced.restaurantId, PERIOD);
    expect(report.cross.find((r) => r.key === "consumo")).toMatchObject({ referenceCents: 0, bookCents: 185_185 });
    expect(report.cross.find((r) => r.key === "iva")).toMatchObject({ referenceCents: 0, bookCents: 190_000 });
    // #574: toda la diferencia es «sin factura» (lo que el motor le causa al pedido).
    const drill = await loadTaxesDrillBase(uninvoiced.restaurantId, PERIOD);
    const byTax = new Map(drill.recon.byTax.map((r) => [r.tax, r]));
    expect(byTax.get("inc")).toMatchObject({ diffCents: 185_185, components: expect.objectContaining({ sinFactura: 185_185, desactualizado: 0 }) });
    expect(byTax.get("iva")).toMatchObject({ diffCents: 190_000, components: expect.objectContaining({ sinFactura: 190_000, desactualizado: 0 }) });
  });

  it("regenerar es idempotente y un mes cerrado no se toca", async () => {
    const before = await engineEntries(invoiced.restaurantId);
    await generateJournalForMonth(invoiced.restaurantId, MONTH, RANGE);
    await generateJournalForMonth(invoiced.restaurantId, MONTH, RANGE);
    expect(await engineEntries(invoiced.restaurantId)).toEqual(before);
    const ids = (await db.journalEntry.findMany({ where: { restaurantId: invoiced.restaurantId }, select: { id: true } })).map((e) => e.id);
    expect(await regenerateMonth(invoiced.restaurantId, MONTH, MONTH)).toEqual({ month: MONTH, status: "closed" });
    expect((await db.journalEntry.findMany({ where: { restaurantId: invoiced.restaurantId }, select: { id: true } })).map((e) => e.id)).toEqual(ids);
  });
});

describe("compras con IVA descontable y no descontable", () => {
  it.each([
    { deductible: false, inventory: 119_000, expense: 59_500, vat: undefined },
    { deductible: true, inventory: 100_000, expense: 50_000, vat: 28_500 },
  ])("deductible=$deductible: inventario $inventory, gasto $expense, IVA descontable $vat", async ({ deductible, inventory, expense, vat }) => {
    const f = await tenant(deductible);
    const po = await receivedPurchase(f, deductible);
    await generateJournalForMonth(f.restaurantId, MONTH, RANGE);
    const purchase = (await engineEntries(f.restaurantId)).filter((e) => e.source === "purchase");
    expect(purchase).toHaveLength(1);
    expect(purchase[0]!.date).toBe(DAY_DATE.toISOString());
    const lines = purchase[0]!.lines;
    expect(balance(lines)).toBe(0);
    const byAccount = net(lines);
    expect(byAccount.get("143505")).toBe(inventory);
    expect(byAccount.get("519505")).toBe(expense);
    expect(byAccount.get("24081001")).toBe(vat);
    expect(byAccount.get("220505")).toBe(-178_500);

    // El inventario del libro es el del kardex (las dos entregas parciales).
    const kardex = await db.stockMovement.aggregate({
      where: { purchaseOrderId: po.id, kind: "purchase_in" },
      _sum: { valueCents: true },
    });
    expect(kardex._sum.valueCents).toBe(inventory);

    // Documentos vs libro: el IVA descontable de las compras cuadra.
    const report = await loadTaxesReport(f.restaurantId, PERIOD);
    expect(report.documental.totals).toMatchObject({
      ivaComprasCents: 28_500,
      ivaNoDescontableCents: deductible ? 0 : 28_500,
      ivaDescontableCents: deductible ? 28_500 : 0,
    });
    const ivaCross = report.cross.find((r) => r.key === "iva");
    if (deductible) expect(ivaCross).toMatchObject({ referenceCents: -28_500, bookCents: -28_500, differenceCents: 0 });
    else expect(ivaCross).toBeUndefined();
    // #574: reconciliación en 0 y «IVA descontable sin ser responsable» sin hallazgos.
    const drill = await loadTaxesDrillBase(f.restaurantId, PERIOD);
    expect(drill.recon.byTax.find((r) => r.tax === "iva")?.diffCents).toBe(0);
    // Con IVA descontable en un comercio de INC la revisión sigue avisando (régimen), como debe.
    expect(taxChecks(drill).find((c) => c.key === "ivaNoDescontable")?.count).toBe(deductible ? 1 : 0);

    // Idempotente.
    const before = await engineEntries(f.restaurantId);
    await generateJournalForMonth(f.restaurantId, MONTH, RANGE);
    expect(await engineEntries(f.restaurantId)).toEqual(before);
  });
});
