import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { db } from "../src/lib/db";
import { POST as createExpense } from "../src/app/api/operator/expenses/route";
import { PATCH as patchExpense } from "../src/app/api/operator/expenses/[id]/route";
import { POST as payExpense } from "../src/app/api/operator/expenses/[id]/payments/route";
import { POST as createSupplier } from "../src/app/api/operator/suppliers/route";
import { POST as runRecurring } from "../src/app/api/cron/recurring-expenses/route";
import { monthRange } from "../src/lib/erp/accounting";
import { computeMonthPnl, computeTaxSummary } from "../src/lib/erp/accountingData";
import { generateJournalForMonth } from "../src/lib/erp/posting";
import { loadPayablesDocs } from "../src/lib/erp/reports/carteraQueries";
import { loadTaxesReport } from "../src/lib/erp/reports/taxesReport";
import { loadExogenaInputs } from "../src/lib/erp/exogena/queries";
import { buildExogenaReport } from "../src/lib/erp/exogena/sources";
import { loadRetentionConcepts } from "../src/lib/erp/retenciones";
import { centsToNumber } from "../src/lib/erp/ledgerCents";

/**
 * Gastos con impuestos y retenciones contra PostgreSQL real (migración
 * 20261104153000_expense_taxes): las rutas guardan lo que calcula el motor
 * puro, el motor contable asienta cada caso cuadrado, y cartera, impuestos,
 * exógena y PYG leen lo mismo. Un gasto viejo (sin impuestos, como lo deja
 * el código anterior) sigue idéntico.
 */
const scope = vi.hoisted(() => ({ restaurantId: "" }));
vi.mock("../src/lib/secureApi", () => ({ secureApi: (handler: unknown) => handler }));
vi.mock("../src/auth", () => ({ auth: async () => ({ user: { role: "operator" } }) }));
vi.mock("../src/lib/erp/access", () => ({
  getErpContext: async () => ({ restaurantId: scope.restaurantId, country: "CO", userId: null }),
  isDenied: () => false,
}));
const database = new URL(process.env.DATABASE_URL ?? "postgresql://localhost/invalid");
if (!["localhost", "127.0.0.1"].includes(database.hostname) || !/^\/mesapay_.*(?:test|validation)$/.test(database.pathname)) {
  throw new Error("Isolated local database required");
}

const MONTH = "2026-10";
const OCT = monthRange(MONTH)!;
const NOW = new Date("2026-11-15T10:30:00Z");
let restaurantId = "";
let supplierId = "";
let conceptIds: Record<string, string> = {};

type Handler = (r: Request, c: { params: Promise<{ id: string }> }) => Promise<Response>;
const json = (body: unknown) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
async function post(body: unknown) {
  const res = await createExpense(new Request("http://localhost/api/operator/expenses", json(body)));
  return { status: res.status, body: (await res.json()) as { expense?: { id: string }; error?: string } };
}

beforeAll(async () => {
  const tenant = await db.restaurant.create({
    data: {
      name: "Gastos con impuestos",
      slug: `gastos-${randomUUID()}`,
      enabledModules: ["accounting"],
      purchaseIvaDeductible: true,
      businessDayCutoffHour: 0,
    },
  });
  restaurantId = scope.restaurantId = tenant.id;
  const concepts = await loadRetentionConcepts(restaurantId);
  for (const c of concepts) {
    if (/Servicios|ReteIVA/.test(c.name)) await db.retentionConcept.update({ where: { id: c.id }, data: { active: true } });
  }
  conceptIds = Object.fromEntries(concepts.map((c) => [c.kind === "retefuente" ? c.name.split(" ")[0]! : c.kind, c.id]));
});

afterAll(async () => {
  if (restaurantId) {
    await db.journalEntry.deleteMany({ where: { restaurantId } });
    await db.restaurant.deleteMany({ where: { id: restaurantId } });
  }
  await db.$disconnect();
});

describe("gastos con impuestos (PostgreSQL)", () => {
  it("el proveedor se crea desde el gasto con su NIT y DV; el NIT repetido devuelve el existente", async () => {
    const res = await createSupplier(
      new Request("http://localhost/api/operator/suppliers", json({ name: "Refrigeración Andina", taxId: "901.944.469", taxIdType: "NIT", personType: "juridica" })),
    );
    expect(res.status).toBe(201);
    const { supplier } = (await res.json()) as { supplier: { id: string; taxId: string; taxIdType: string } };
    expect(supplier).toMatchObject({ taxId: "901944469-1", taxIdType: "NIT" });
    supplierId = supplier.id;
    const dup = await createSupplier(
      new Request("http://localhost/api/operator/suppliers", json({ name: "Andina otra", taxId: "901944469-1", taxIdType: "NIT" })),
    );
    expect(dup.status).toBe(409);
    expect(await dup.json()).toMatchObject({ error: "tax_id_taken", existing: { id: supplierId } });
  });

  it("crea los cuatro casos y el motor asienta cada día cuadrado, con las cuentas de las compras", async () => {
    // 1) Gasto viejo: lo que escribía el código anterior (sin campos nuevos).
    const legacy = await db.expense.create({
      data: { restaurantId, category: "Arriendo", amountCents: 300_000_000, date: new Date("2026-10-03T17:00:00Z") },
    });
    // 2) Factura con IVA 19 % descontable + retefuente servicios + reteIVA, pagada de contado.
    const paid = await post({
      category: "Mantenimiento nevera",
      date: "2026-10-10T17:00:00.000Z",
      supplierId,
      subtotalCents: 100_000_000,
      ivaPct: 19,
      retentions: [
        { conceptId: conceptIds["Servicios"], amountCents: 4_000_000 },
        { conceptId: conceptIds["reteiva"], amountCents: 2_850_000 },
      ],
      documentType: "e_invoice",
      documentNumber: "FE-901",
      payFromAccountCode: "111005",
    });
    expect(paid.status).toBe(201);
    // 3) Con INC, debiéndose, con un abono parcial.
    const owed = await post({
      category: "Representación",
      date: "2026-10-12T17:00:00.000Z",
      subtotalCents: 20_000_000,
      incCents: 1_600_000,
      dueAt: "2026-10-30T17:00:00.000Z",
    });
    expect(owed.status).toBe(201);
    const pay = await (payExpense as unknown as Handler)(
      new Request(`http://localhost/api/operator/expenses/${owed.body.expense!.id}/payments`, json({ amountCents: 10_000_000, paidAt: "2026-10-20T17:00:00.000Z", accountCode: "110505" })),
      { params: Promise.resolve({ id: owed.body.expense!.id }) },
    );
    expect(pay.status).toBe(201);
    // Sin proveedor con IVA: se rechaza.
    expect((await post({ category: "X", date: "2026-10-12T17:00:00.000Z", subtotalCents: 1_000, ivaPct: 19 })).body).toEqual({ error: "supplier_required" });

    const stored = await db.expense.findUniqueOrThrow({ where: { id: paid.body.expense!.id }, include: { retentions: true } });
    expect(stored).toMatchObject({
      amountCents: 100_000_000,
      baseCents: 100_000_000,
      ivaCents: 19_000_000,
      ivaDeductible: true,
      retefuenteCents: 4_000_000,
      reteIvaCents: 2_850_000,
      payableCents: 112_150_000,
      paidCents: 112_150_000,
      documentNumber: "FE-901",
    });
    expect(stored.retentions.map((r) => [r.kind, r.accountCode, r.amountCents])).toEqual(
      expect.arrayContaining([
        ["reteiva", "236705", 2_850_000],
        ["retefuente", "236505", 4_000_000],
      ]),
    );
    expect(stored.retentions).toHaveLength(2);

    await generateJournalForMonth(restaurantId, MONTH, OCT, { now: NOW });
    const entries = await db.journalEntry.findMany({
      where: { restaurantId, sourceRef: MONTH, source: { in: ["expense", "expense_payment"] } },
      include: { lines: true },
      orderBy: { date: "asc" },
    });
    for (const e of entries) {
      const d = e.lines.reduce((s, l) => s + centsToNumber(l.debitCents), 0);
      const c = e.lines.reduce((s, l) => s + centsToNumber(l.creditCents), 0);
      expect(d, `${e.source} ${e.date.toISOString()}`).toBe(c);
    }
    const net = (code: string) =>
      entries
        .flatMap((e) => e.lines)
        .filter((l) => l.accountCode.startsWith(code))
        .reduce((s, l) => s + centsToNumber(l.debitCents) - centsToNumber(l.creditCents), 0);
    expect(net("2408")).toBe(19_000_000); // IVA descontable
    expect(net("236505")).toBe(-4_000_000);
    expect(net("236705")).toBe(-2_850_000);
    // CxP de gastos: lo que se debe del gasto con INC (21.600.000 − 10.000.000) y el arriendo viejo.
    expect(net("233505")).toBe(-(21_600_000 - 10_000_000) - 300_000_000);

    // Cartera: total a pagar, no costo.
    const payables = await loadPayablesDocs(restaurantId, "2026-10-31");
    expect(payables.map((d) => [d.totalCents, d.outstandingCents]).sort()).toEqual([
      [21_600_000, 11_600_000],
      [300_000_000, 300_000_000],
    ]);
    expect(legacy.payableCents).toBe(0);
  });

  it("PYG con el costo (base + INC + IVA no descontable); impuestos y exógena con el IVA y lo retenido", async () => {
    const pnl = await computeMonthPnl(restaurantId, OCT);
    expect(pnl.expensesCents).toBe(300_000_000 + 100_000_000 + 21_600_000);
    const tax = await computeTaxSummary(restaurantId, OCT);
    expect(tax.purchases).toMatchObject({ ivaCents: 19_000_000, incCents: 1_600_000, retefuenteCents: 4_000_000, reteIvaCents: 2_850_000 });
    const report = await loadTaxesReport(restaurantId, { desde: "2026-10-01", hasta: "2026-10-31" } as never);
    expect(report.documental.expenses).toEqual([
      expect.objectContaining({ kind: "iva", pct: 19, taxCents: 19_000_000 }),
      expect.objectContaining({ kind: "inc", taxCents: 1_600_000 }),
    ]);
    expect(report.cross.find((r) => r.key === "retefuente")).toMatchObject({ referenceCents: 4_000_000, bookCents: 4_000_000, differenceCents: 0 });
    const exo = buildExogenaReport(await loadExogenaInputs(restaurantId, 2026));
    expect(exo.formats["1005"]).toEqual([expect.objectContaining({ vimpCents: 19_000_000 })]);
    expect(exo.formats["1001"]).toEqual([expect.objectContaining({ pagoCents: 100_000_000, idedCents: 19_000_000, retpCents: 4_000_000, retaCents: 2_850_000 })]);
  });

  it("editar: no baja del abonado; la copia recurrente recalcula la retención", async () => {
    const owed = await db.expense.findFirstOrThrow({ where: { restaurantId, category: "Representación" } });
    const low = await (patchExpense as unknown as Handler)(
      new Request(`http://localhost/api/operator/expenses/${owed.id}`, { ...json({ subtotalCents: 5_000_000, incCents: 0, retentions: [] }), method: "PATCH" }),
      { params: Promise.resolve({ id: owed.id }) },
    );
    expect(await low.json()).toEqual({ error: "below_paid" });

    const tpl = await post({
      category: "Mantenimiento mensual",
      date: "2026-10-01T17:00:00.000Z",
      supplierId,
      subtotalCents: 100_000_000,
      ivaPct: 19,
      retentions: [{ conceptId: conceptIds["Servicios"], amountCents: 4_000_000 }],
      recurring: true,
      recurringDay: 5,
    });
    expect(tpl.status).toBe(201);
    // El contador sube la tarifa: la copia la toma.
    await db.retentionConcept.update({ where: { id: conceptIds["Servicios"] }, data: { rateBps: 600 } });
    vi.stubEnv("CRON_SECRET", "s");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-05T12:00:00Z"));
    // Plantilla creada antes del día 5 de noviembre: se materializa.
    await db.expense.update({ where: { id: tpl.body.expense!.id }, data: { createdAt: new Date("2026-10-01T12:00:00Z") } });
    const res = await runRecurring(new Request("http://localhost/api/cron/recurring-expenses", { method: "POST", headers: { "x-cron-secret": "s" } }));
    vi.useRealTimers();
    expect(await res.json()).toMatchObject({ created: 1 });
    const copy = await db.expense.findFirstOrThrow({ where: { templateId: tpl.body.expense!.id }, include: { retentions: true } });
    expect(copy).toMatchObject({ ivaCents: 19_000_000, retefuenteCents: 6_000_000, payableCents: 113_000_000, recurring: false });
    expect(copy.retentions).toEqual([expect.objectContaining({ rateBps: 600, amountCents: 6_000_000 })]);
  });
});
