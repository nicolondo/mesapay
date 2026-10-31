import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { db } from "../src/lib/db";
import { monthRange } from "../src/lib/erp/accounting";
import { generateJournalForMonth, loadJournalForMonth } from "../src/lib/erp/posting";
import { createManualEntry, reverseEntry } from "../src/lib/erp/journalManual";
import { listEntries, loadEntryDetail } from "../src/lib/erp/journalQuery";
import { depreciationPairsForMonth } from "../src/lib/erp/activos";
import { listAssets, loadAssetDetail } from "../src/lib/erp/activosQuery";
import { deferredAmortizationLinesForMonth } from "../src/lib/erp/deferred";
import { listDeferredItems } from "../src/lib/erp/deferredQuery";
import { loadBudgetExecution } from "../src/lib/erp/budgets";
import {
  loadBalancesThrough,
  loadEntriesWithLines,
  loadLedgerLines,
  loadReportAccounts,
  loadResultMovements,
  loadTrialBalanceRows,
} from "../src/lib/erp/reports/queries";
import { buildTrialBalance } from "../src/lib/erp/reports/trialBalance";
import { buildBalanceSheet } from "../src/lib/erp/reports/balanceSheet";
import { buildIncomeStatement } from "../src/lib/erp/reports/incomeStatement";
import { buildGeneralLedger } from "../src/lib/erp/reports/generalLedger";
import { buildDailyBook } from "../src/lib/erp/reports/dailyBook";
import { GET as getBank } from "../src/app/api/operator/accounting/bank/route";
import { GET as getFilings } from "../src/app/api/operator/accounting/declaraciones/route";

/**
 * Montos contables por encima de INT4 contra PostgreSQL real (migración
 * 20261101090000_journal_amounts_bigint). La primera corrida automática del
 * motor (#521) falló para Son y Melona: "Unable to fit integer value
 * '24179580000' into an INT4". Acá el motor REAL asienta ese mes, y el libro,
 * los reportes y las rutas lo leen al centavo y en JSON sin `bigint`.
 */
const scope = vi.hoisted(() => ({ restaurantId: "" }));
vi.mock("../src/lib/secureApi", () => ({ secureApi: (handler: unknown) => handler }));
vi.mock("../src/lib/erp/access", () => ({
  getErpContext: async () => ({ restaurantId: scope.restaurantId, userId: null }),
  isDenied: () => false,
}));
vi.mock("../src/lib/events", () => ({ publishOrderEvent: vi.fn() }));
const database = new URL(process.env.DATABASE_URL ?? "postgresql://localhost/invalid");
if (!["localhost", "127.0.0.1"].includes(database.hostname) || !/^\/mesapay_.*(?:test|validation)$/.test(database.pathname)) throw new Error("Isolated local database required");

/** Ventas de octubre de 2026 de Son y Melona (centavos). */
const OCT_SALES = 24_179_580_000;
const OCT = monthRange("2026-10")!;
const PAID_AT = new Date("2026-10-15T15:00:00Z");
let restaurantId = "";

function expectJsonSafe(value: unknown) {
  const walk = (v: unknown, path: string) => {
    expect(typeof v, path).not.toBe("bigint");
    if (v && typeof v === "object" && !(v instanceof Date)) for (const [k, x] of Object.entries(v)) walk(x, `${path}.${k}`);
  };
  walk(value, "$");
  expect(() => JSON.stringify(value)).not.toThrow();
}

beforeAll(async () => {
  const tenant = await db.restaurant.create({ data: { name: "Prueba montos BIGINT", slug: `bigint-${randomUUID()}` } });
  restaurantId = scope.restaurantId = tenant.id;
  const table = await db.table.create({ data: { restaurantId, number: 1, qrToken: randomUUID() } });
  // Cada cuenta cabe en INT4; el mes no. Mismo patrón que shift-large-cash.
  for (let left = OCT_SALES; left > 0; ) {
    const cents = Math.min(left, 1_000_000_000);
    const order = await db.order.create({ data: {
      restaurantId, tableId: table.id, status: "placed", shortCode: randomUUID(), subtotalCents: cents, totalCents: cents,
    } });
    await db.payment.create({ data: { orderId: order.id, method: "cash", status: "approved", amountCents: cents, settledAt: PAID_AT } });
    await db.order.update({ where: { id: order.id }, data: { status: "paid", paidAt: PAID_AT } });
    left -= cents;
  }
});
afterAll(async () => {
  if (restaurantId) {
    // JournalLine → LedgerAccount es RESTRICT: primero el libro.
    await db.journalEntry.deleteMany({ where: { restaurantId } });
    await db.restaurant.deleteMany({ where: { id: restaurantId } });
  }
  await db.$disconnect();
});

describe("asientos de más de $21 M en PostgreSQL", () => {
  it("el motor asienta el mes de $241 M con el monto exacto", async () => {
    const results = await generateJournalForMonth(restaurantId, "2026-10", OCT);
    expect(results).toEqual(expect.arrayContaining([{ source: "sale", totalCents: OCT_SALES }]));
    const sale = await db.journalEntry.findFirstOrThrow({ where: { restaurantId, source: "sale", sourceRef: "2026-10" }, include: { lines: true } });
    expect(sale.lines.reduce((s, l) => s + Number(l.debitCents), 0)).toBe(OCT_SALES);
    expect(sale.lines.reduce((s, l) => s + Number(l.creditCents), 0)).toBe(OCT_SALES);
    expect(sale.lines.find((l) => l.accountCode === "110505")?.debitCents).toBe(BigInt(OCT_SALES));
    const journal = await loadJournalForMonth(restaurantId, "2026-10");
    expect(journal.find((e) => e.source === "sale")?.lines[0]).toMatchObject({ accountCode: "110505", debitCents: OCT_SALES });
    expectJsonSafe(journal);
  });

  it("balance de prueba, ESFA, estado de resultados y libros leen el mes al centavo", async () => {
    const accounts = await loadReportAccounts(restaurantId);
    const tb = buildTrialBalance(await loadTrialBalanceRows(restaurantId, OCT.from, OCT.to), { level: 6, accounts });
    expect(tb.totals).toMatchObject({ debitCents: OCT_SALES, creditCents: OCT_SALES });
    expectJsonSafe(tb);

    const bs = buildBalanceSheet({
      balances: await loadBalancesThrough(restaurantId, OCT.to), accounts, cutoff: "2026-10-31", openYearStart: "2026-01-01", utilidadLabel: "Utilidad",
    });
    expect(bs.totals.activoCents).toBe(OCT_SALES);
    expect(bs.totals.differenceCents).toBe(0);
    expectJsonSafe(bs);

    const is = buildIncomeStatement({
      movements: await loadResultMovements(restaurantId, OCT.from, OCT.to), accounts, country: "CO", from: "2026-10-01", to: "2026-10-31",
    });
    expect(is.summary.incomeCents).toBe(OCT_SALES);
    expectJsonSafe(is);

    const ledger = buildGeneralLedger(await loadLedgerLines(restaurantId, OCT.to), accounts, { from: OCT.from, to: OCT.to });
    expect(ledger.totals).toEqual({ debitCents: OCT_SALES, creditCents: OCT_SALES });
    expectJsonSafe(ledger);

    const book = buildDailyBook(await loadEntriesWithLines(restaurantId, OCT.from, OCT.to), { mode: "detallado" });
    expect(book.stats).toMatchObject({ debitCents: OCT_SALES, creditCents: OCT_SALES, balanced: true });
    expectJsonSafe(book);
  });

  it("un comprobante manual y su reversa de $300 M se guardan y leen exactos", async () => {
    const amount = 30_000_000_000;
    const created = await createManualEntry({
      restaurantId, actorId: null,
      input: { date: "2026-10-20", memo: "Aporte de capital", lines: [{ accountCode: "110505", debitCents: amount }, { accountCode: "413505", creditCents: amount }] },
    });
    if (!created.ok) throw new Error(created.error);
    expect(created.entry.lines.map((l) => [l.debitCents, l.creditCents]).sort()).toEqual([[0, amount], [amount, 0]]);
    expectJsonSafe(created);
    const detail = await loadEntryDetail(restaurantId, created.entry.id);
    expect(detail).toMatchObject({ totalDebitCents: amount, totalCreditCents: amount, balanced: true });
    expectJsonSafe(detail);
    const reversed = await reverseEntry({ restaurantId, entryId: created.entry.id, actorId: null });
    if (!reversed.ok) throw new Error(reversed.error);
    expect(reversed.entry.lines.find((l) => l.accountCode === "110505")).toMatchObject({ debitCents: 0, creditCents: amount });
    expectJsonSafe(reversed);
    const list = await listEntries(restaurantId, { desde: "2026-10-01", hasta: "2026-10-31" });
    expect(list.entries.map((e) => e.totalCents)).toEqual(expect.arrayContaining([OCT_SALES, amount, amount]));
    expectJsonSafe(list);
  });

  it("activos, diferidos, presupuesto, declaraciones y extracto aceptan y devuelven montos > INT4", async () => {
    const asset = await db.fixedAsset.create({ data: {
      restaurantId, name: "Remodelación", purchaseDate: new Date("2026-06-15T12:00:00Z"), purchaseCents: 48_000_000_000,
      usefulLifeMonths: 12, assetAccountCode: "152405",
    } });
    expect((await listAssets(restaurantId))[0]).toMatchObject({ purchaseCents: 48_000_000_000, monthlyCents: 4_000_000_000 });
    expectJsonSafe(await loadAssetDetail(restaurantId, asset.id));
    expect(await depreciationPairsForMonth(restaurantId, "2026-10")).toEqual([expect.objectContaining({ amountCents: 4_000_000_000 })]);

    await db.deferredItem.create({ data: {
      restaurantId, name: "Arriendo anual", kind: "expense", totalCents: 36_000_000_000, startDate: new Date("2026-10-01T12:00:00Z"), months: 12,
      sourceAccountCode: "111005", deferralAccountCode: "170520", targetAccountCode: "512010",
    } });
    expect((await listDeferredItems(restaurantId))[0]).toMatchObject({ totalCents: 36_000_000_000, monthlyCents: 3_000_000_000 });
    expect(await deferredAmortizationLinesForMonth(restaurantId, "2026-10")).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "512010", debit: 3_000_000_000 })]),
    );

    await db.budget.create({ data: { restaurantId, year: 2026, month: 10, accountCode: "4135", monthlyCents: 30_000_000_000 } });
    const budget = await loadBudgetExecution(restaurantId, 2026, 10);
    expect(budget.budgets[0]).toMatchObject({ monthlyCents: 30_000_000_000 });
    expect(budget.rows[0]).toMatchObject({ budgetCents: 30_000_000_000 });
    expectJsonSafe(budget);

    await db.taxFiling.create({ data: { restaurantId, form: "inc", period: "2026-10", declaredCents: 2_670_000_000, paidAt: new Date("2026-11-10T12:00:00Z") } });
    const filings = await getFilings(new Request("http://localhost/api/operator/accounting/declaraciones?year=2026"));
    expect((await filings.json()).filings[0].declaredCents).toBe(2_670_000_000);

    await db.bankStatementLine.create({ data: { restaurantId, date: new Date("2026-10-31T12:00:00Z"), description: "Abono datáfono", amountCents: 5_600_000_000, importBatch: "b1" } });
    const bank = await getBank(new Request("http://localhost/api/operator/accounting/bank"));
    expect((await bank.json()).lines[0].amountCents).toBe(5_600_000_000);

    // Las cuotas del mes también pasan de INT4 y el motor las asienta.
    expect(await generateJournalForMonth(restaurantId, "2026-10", OCT)).toEqual(expect.arrayContaining([
      { source: "sale", totalCents: OCT_SALES },
      { source: "depreciation", totalCents: 4_000_000_000 },
      { source: "deferred", totalCents: 3_000_000_000 },
    ]));
  });
});
