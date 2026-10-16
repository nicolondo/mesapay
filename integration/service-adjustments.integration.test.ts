import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Prisma } from "@prisma/client";
import { db } from "../src/lib/db";
import { parseServiceReportFilters, type ServiceReportFilters } from "../src/lib/reports/serviceAdjustments";
import { getServiceReport, iterateServiceReportRows } from "../src/lib/reports/serviceAdjustmentsQuery";

const database = new URL(process.env.DATABASE_URL ?? "postgresql://localhost/invalid");
if (!["localhost", "127.0.0.1"].includes(database.hostname) || !/^\/mesapay_.*(?:test|validation)$/.test(database.pathname)) {
  throw new Error("Service report integration tests require an isolated local mesapay_*test or mesapay_*validation database");
}

const tenantIds: string[] = [];
let restaurantId: string;
let tableId: string;
const early = new Date("2026-10-12T12:00:00.000Z");
const middle = new Date("2026-10-13T12:00:00.000Z");
const late = new Date("2026-10-14T12:00:00.000Z");

async function tenant(number = 17) {
  const restaurant = await db.restaurant.create({ data: { name: "Service reports fixture", slug: `service-report-${randomUUID()}` } });
  tenantIds.push(restaurant.id);
  const table = await db.table.create({ data: { restaurantId: restaurant.id, number, label: "Terraza norte", qrToken: randomUUID() } });
  return { restaurantId: restaurant.id, tableId: table.id };
}

function filters(patch: Partial<ServiceReportFilters> = {}): ServiceReportFilters {
  return { ...parseServiceReportFilters("uncollected", { range: "all" }, 5), ...patch };
}

function representation(patch: Partial<ServiceReportFilters> = {}) {
  return filters({ report: "representation", view: "orders", kind: "representation", ...patch });
}

function order(patch: Partial<Prisma.OrderUncheckedCreateInput> = {}) {
  return db.order.create({ data: { restaurantId, tableId, shortCode: randomUUID(), status: "placed", ...patch } });
}

function item(orderId: string, patch: Partial<Prisma.OrderItemUncheckedCreateInput> = {}) {
  return db.orderItem.create({ data: {
    orderId, nameSnapshot: "Producto", priceCentsSnapshot: 1500, qty: 1,
    cancelledAt: middle, cancellationKind: "cancel", cancellationReason: "Pedido duplicado", cancelledByEmail: "staff@example.test", ...patch,
  } });
}

function round(orderId: string, patch: Partial<Prisma.RoundUncheckedCreateInput> = {}) {
  return db.round.create({ data: {
    orderId, seq: 1, status: "cancelled", cancelledAt: middle,
    cancellationReason: "Ronda sin ingredientes", cancelledByEmail: "kitchen@example.test", ...patch,
  } });
}

beforeEach(async () => { ({ restaurantId, tableId } = await tenant()); });
afterAll(async () => {
  await db.auditEvent.deleteMany({ where: { restaurantId: { in: tenantIds } } });
  await db.restaurant.deleteMany({ where: { id: { in: tenantIds } } });
  await db.$disconnect();
});

describe("service adjustment reports on PostgreSQL", () => {
  it("uses price snapshots including modifiers, legacy cancellation kinds, and the active tenant only", async () => {
    const account = await order();
    const cancelled = await item(account.id, { qty: 3, priceCentsSnapshot: 12500, cancellationKind: null, modifierSelections: { extra: "Queso" } });
    await item(account.id, { cancelledAt: null, cancellationKind: null });
    const other = await tenant();
    const foreign = await order(other);
    await item(foreign.id, { priceCentsSnapshot: 999999 });
    const report = await getServiceReport(restaurantId, filters());
    expect(report.rows).toHaveLength(1);
    expect(report.rows[0]).toMatchObject({ id: cancelled.id, kind: "item_cancel", quantity: 3, lineCount: 1, amountCents: 37500, detailAmountCents: 37500, missingDetail: false });
    expect(report.totals).toEqual({ rowCount: 1, orderCount: 1, lineCount: 1, quantity: 3, amountCents: 37500, unknownAmountCount: 0, cancelAmountCents: 37500, compAmountCents: 0, representationAmountCents: 0 });
    expect((await getServiceReport(restaurantId, filters({ orderId: foreign.id }))).totals.rowCount).toBe(0);
  });

  it("keeps the first cancellation event, its reason and actor, preferring the item on ties", async () => {
    const account = await order();
    const cancelledRound = await round(account.id);
    const roundOnly = await item(account.id, { roundId: cancelledRound.id, cancelledAt: null, cancellationKind: null });
    const laterCascade = await item(account.id, { roundId: cancelledRound.id, cancelledAt: late, cancellationReason: "Orden completa cancelada" });
    const earlierComp = await item(account.id, { roundId: cancelledRound.id, cancelledAt: early, cancellationKind: "comp", cancellationReason: "Llegó frío" });
    const tiedComp = await item(account.id, { roundId: cancelledRound.id, cancelledAt: middle, cancellationKind: "comp", cancellationReason: "Cortesía individual" });
    const report = await getServiceReport(restaurantId, filters());
    const byId = new Map(report.rows.map(row => [row.id, row]));
    for (const id of [roundOnly.id, laterCascade.id]) expect(byId.get(id)).toMatchObject({ eventAt: middle, kind: "round_cancel", reason: "Ronda sin ingredientes", actorEmail: "kitchen@example.test" });
    expect(byId.get(earlierComp.id)).toMatchObject({ eventAt: early, kind: "item_comp", reason: "Llegó frío", actorEmail: "staff@example.test" });
    expect(byId.get(tiedComp.id)).toMatchObject({ eventAt: middle, kind: "item_comp", reason: "Cortesía individual" });
    expect(report.totals).toMatchObject({ rowCount: 4, cancelAmountCents: 3000, compAmountCents: 3000 });
    expect((await getServiceReport(restaurantId, filters({ start: late, end: new Date(late.getTime() + 1) }))).rows).toHaveLength(0);
  });

  it("separates whole-account representation from prior individual comps and cancels", async () => {
    const account = await order({ compedAt: late, compAmountCents: 7000, compLabel: "Atenciones", compNote: "Invitado del evento", status: "paid" });
    const prior = await item(account.id, { cancelledAt: early, cancellationKind: "comp", nameSnapshot: "Postre anterior", priceCentsSnapshot: 3500 });
    await item(account.id, { cancelledAt: early, nameSnapshot: "Producto cancelado" });
    const first = await item(account.id, { cancelledAt: late, cancellationKind: "comp", qty: 2, priceCentsSnapshot: 2500, nameSnapshot: "Lomo", cancellationReason: "Atenciones: Invitado del evento" });
    const second = await item(account.id, { cancelledAt: late, cancellationKind: "comp", priceCentsSnapshot: 2000, nameSnapshot: "Agua", cancellationReason: "Atenciones: Invitado del evento" });
    const accounts = await getServiceReport(restaurantId, representation());
    expect(accounts.rows[0]).toMatchObject({ id: account.id, eventAt: late, name: "Atenciones", kind: "order_comp", lineCount: 2, quantity: 3, amountCents: 7000, detailAmountCents: 7000, missingDetail: false });
    const products = await getServiceReport(restaurantId, representation({ view: "items", kind: "all" }));
    expect(new Set(products.rows.map(row => row.id))).toEqual(new Set([first.id, second.id]));
    const individual = await getServiceReport(restaurantId, filters({ kind: "comp" }));
    expect(individual.rows.map(row => row.id)).toEqual([prior.id]);
    expect((await getServiceReport(restaurantId, filters({ kind: "representation" }))).totals).toMatchObject({ rowCount: 2, representationAmountCents: 7000, compAmountCents: 0 });
    expect((await getServiceReport(restaurantId, representation({ q: "lOmO" }))).rows[0]).toMatchObject({ amountCents: 7000, quantity: 3 });
    expect((await getServiceReport(restaurantId, representation({ q: "Postre anterior" }))).rows).toHaveLength(0);
  });

  it("preserves explicit zero and missing snapshots, reports mismatched detail without inventing amounts", async () => {
    const unknown = await order({ compedAt: late, compAmountCents: null });
    const zero = await order({ compedAt: late, compAmountCents: 0 });
    const incomplete = await order({ compedAt: late, compAmountCents: 9000 });
    const fallback = await order({ compedAt: late, compAmountCents: null });
    await item(zero.id, { cancelledAt: late, cancellationKind: "comp", priceCentsSnapshot: 1000 });
    await item(incomplete.id, { cancelledAt: late, cancellationKind: "comp", priceCentsSnapshot: 5000 });
    await item(fallback.id, { cancelledAt: late, cancellationKind: "comp", priceCentsSnapshot: 3000 });
    const report = await getServiceReport(restaurantId, representation());
    const byId = new Map(report.rows.map(row => [row.id, row]));
    expect(byId.get(unknown.id)).toMatchObject({ amountCents: null, detailAmountCents: 0, lineCount: 0, missingDetail: true });
    expect(byId.get(zero.id)).toMatchObject({ amountCents: 0, detailAmountCents: 1000, missingDetail: true });
    expect(byId.get(incomplete.id)).toMatchObject({ amountCents: 9000, detailAmountCents: 5000, missingDetail: true });
    expect(byId.get(fallback.id)).toMatchObject({ amountCents: 3000, detailAmountCents: 3000, missingDetail: false });
    expect(report.totals).toMatchObject({ rowCount: 4, orderCount: 4, lineCount: 3, amountCents: 12000, unknownAmountCount: 1, representationAmountCents: 12000 });
  });

  it("uses the captured item actor before a tenant-scoped audit fallback and never duplicates accounts", async () => {
    const fallback = await order({ compedAt: middle, compAmountCents: 500 });
    const captured = await order({ compedAt: middle, compAmountCents: 1500 });
    await item(captured.id, { cancelledAt: middle, cancellationKind: "comp", cancelledByEmail: "captured@example.test" });
    const other = await tenant();
    for (const account of [fallback, captured]) {
      await db.auditEvent.createMany({ data: [
        { restaurantId: other.restaurantId, targetType: "order", targetId: account.id, kind: "order.comp", actorEmail: "foreign@example.test", actorRole: "operator", summary: "fixture", occurredAt: early },
        { restaurantId, targetType: "order", targetId: account.id, kind: "order.cancel", actorEmail: "wrong-kind@example.test", actorRole: "operator", summary: "fixture", occurredAt: early },
        { restaurantId, targetType: "order_item", targetId: account.id, kind: "order.comp", actorEmail: "wrong-target@example.test", actorRole: "operator", summary: "fixture", occurredAt: early },
        { restaurantId, targetType: "order", targetId: account.id, kind: "order.comp", actorEmail: "audit@example.test", actorRole: "operator", summary: "fixture", occurredAt: middle },
        { restaurantId, targetType: "order", targetId: account.id, kind: "order.comp", actorEmail: "duplicate@example.test", actorRole: "operator", summary: "fixture", occurredAt: late },
      ] });
    }
    const report = await getServiceReport(restaurantId, representation());
    expect(report.rows).toHaveLength(2);
    expect(report.rows.find(row => row.id === captured.id)?.actorEmail).toBe("captured@example.test");
    expect(report.rows.find(row => row.id === fallback.id)?.actorEmail).toBe("audit@example.test");
    expect((await getServiceReport(restaurantId, representation({ email: "audit@example.test" }))).rows.map(row => row.id)).toEqual([fallback.id]);
  });

  it("uses inclusive start and exclusive end and does not treat an emptied moved account as lost sales", async () => {
    const account = await order({ status: "cancelled" });
    const start = new Date("2026-10-13T10:00:00.000Z");
    const end = new Date("2026-10-14T10:00:00.000Z");
    await item(account.id, { cancelledAt: new Date(start.getTime() - 1) });
    const inside = await item(account.id, { cancelledAt: start });
    await item(account.id, { cancelledAt: end });
    const destination = await order();
    await item(destination.id, { cancelledAt: null });
    await order({ status: "cancelled" });
    const report = await getServiceReport(restaurantId, filters({ start, end }));
    expect(report.rows.map(row => row.id)).toEqual([inside.id]);
    expect(report.totals.rowCount).toBe(1);
  });

  it("applies literal case-insensitive search to saved text, table number, actor and account", async () => {
    const account = await order({ shortCode: `CODE-${randomUUID()}` });
    const special = await item(account.id, { nameSnapshot: "Promo 10%_\\ especial", cancellationReason: "Queja del CLIENTE", cancelledByEmail: "Manager@example.test" });
    await item(account.id, { nameSnapshot: "Promo 1000 especial" });
    expect((await getServiceReport(restaurantId, filters({ q: "%_\\" }))).rows.map(row => row.id)).toEqual([special.id]);
    for (const q of ["cliente", "manager@", account.shortCode.toLowerCase()]) {
      expect((await getServiceReport(restaurantId, filters({ q }))).rows.some(row => row.id === special.id)).toBe(true);
    }
    for (const q of ["terraza NORTE", "17"]) expect((await getServiceReport(restaurantId, filters({ q }))).totals.rowCount).toBe(2);
    expect((await getServiceReport(restaurantId, filters({ q: "' OR 1=1 --" }))).rows).toHaveLength(0);
  });

  it("aggregates in bigint before converting the complete result to safe integers", async () => {
    const account = await order();
    await item(account.id, { priceCentsSnapshot: 1_000_000_000, qty: 3 });
    expect((await getServiceReport(restaurantId, filters())).totals.amountCents).toBe(3_000_000_000);
  });

  it("paginates and exports every filtered row beyond 500, using deterministic timestamp ties", async () => {
    const account = await order();
    const ids = Array.from({ length: 1007 }, () => randomUUID());
    await db.orderItem.createMany({ data: ids.map(id => ({ id, orderId: account.id, nameSnapshot: "Bulk fixture", priceCentsSnapshot: 250, qty: 2, cancelledAt: middle, cancellationKind: "cancel" })) });
    const first = await getServiceReport(restaurantId, filters());
    expect(first.rows).toHaveLength(50);
    expect(first.totals).toMatchObject({ rowCount: 1007, lineCount: 1007, quantity: 2014, amountCents: 503500 });
    const final = await getServiceReport(restaurantId, filters({ page: 999 }));
    expect(final).toMatchObject({ page: 21, pageCount: 21, pageSize: 50 });
    expect(final.rows).toHaveLength(7);
    expect(final.totals).toEqual(first.totals);
    const exported = [];
    for await (const row of iterateServiceReportRows(restaurantId, filters({ page: 999 }))) exported.push(row);
    expect(exported.map(row => row.id)).toEqual([...ids].sort().reverse());
    expect(new Set(exported.map(row => row.id)).size).toBe(1007);
  });

  it("keeps new events after the export starts out of subsequent batches", async () => {
    const account = await order();
    await db.orderItem.createMany({ data: Array.from({ length: 501 }, () => ({ orderId: account.id, nameSnapshot: "Export fixture", priceCentsSnapshot: 100, cancelledAt: middle, cancellationKind: "cancel" })) });
    const stream = iterateServiceReportRows(restaurantId, filters());
    const first = await stream.next();
    expect(first.done).toBe(false);
    const concurrent = await item(account.id, { cancelledAt: new Date(Date.now() + 60000) });
    const ids = [first.value!.id];
    for await (const row of stream) ids.push(row.id);
    expect(ids).toHaveLength(501);
    expect(ids).not.toContain(concurrent.id);
  });

  it("returns a stable empty result and empty export without fabricated counts", async () => {
    expect(await getServiceReport(restaurantId, filters({ page: 99 }))).toMatchObject({ rows: [], page: 1, pageCount: 1, totals: { rowCount: 0, amountCents: 0, unknownAmountCount: 0 } });
    const rows = [];
    for await (const row of iterateServiceReportRows(restaurantId, representation())) rows.push(row);
    expect(rows).toEqual([]);
  });

  it("does not flag a recorded zero-value empty courtesy as a detail discrepancy", async () => {
    const account = await order({ compedAt: middle, compAmountCents: 0 });
    expect((await getServiceReport(restaurantId, representation())).rows[0]).toMatchObject({ id: account.id, amountCents: 0, detailAmountCents: 0, lineCount: 0, missingDetail: false });
  });
});
