// Análisis de ventas contra PostgreSQL: el SQL agregado tiene que dar
// exactamente lo que define `metrics.ts` (y, por él, el Resumen), con el
// día operativo de corte 5 a. m., los filtros y siempre acotado por comercio.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Prisma } from "@prisma/client";
import { db } from "../src/lib/db";
import { loadDashboardSales } from "../src/lib/reports/dashboardSalesQuery";
import { allocateLines, saleFacts, sumSaleFacts, summarizeReturns, type SaleOrderInput } from "../src/lib/salesAnalysis/metrics";
import {
  loadChannels, loadHeat, loadMethods, loadModifiers, loadOrders, loadProducts, loadReturnRows, loadTotals, loadTrend, loadWaiters,
} from "../src/lib/salesAnalysis/queries";
import { NO_WAITER, parseSalesFilters } from "../src/lib/salesAnalysis/filters";
import { rangeInstants } from "../src/lib/salesAnalysis/period";
import { loadSalesAnalysis } from "../src/lib/salesAnalysis/load";
import type { SalesScope } from "../src/lib/salesAnalysis/sql";

const database = new URL(process.env.DATABASE_URL ?? "postgresql://localhost/invalid");
if (!["localhost", "127.0.0.1"].includes(database.hostname) || !/^\/mesapay_.*(?:test|validation)$/.test(database.pathname)) {
  throw new Error("Isolated local database required");
}

const INC8 = { kind: "inc" as const, pct: 8 };
const bog = (s: string) => new Date(`${s}-05:00`);
const tenantIds: string[] = [];
const seriesIds: string[] = [];

type LineSpec = {
  price: number; qty?: number; menuItemId?: string | null; name?: string; taxKind?: string | null; taxPct?: number | null;
  cancelled?: "cancel" | "comp"; roundCancelled?: boolean; mods?: Prisma.InputJsonValue;
};
type OrderSpec = {
  restaurantId: string; tableId: string; paidAt: Date | null; status?: "paid" | "served"; orderType?: "dineIn" | "pickup";
  diners?: number; tip?: number; discount?: number; lines: LineSpec[]; invoice?: Prisma.InputJsonValue; comped?: boolean;
  commissionWaiterId?: string; commissionCents?: number; placedBy?: string; payments?: { method: string; share?: number }[];
};

/** Crea una cuenta coherente con `recomputeOrderTotalsInTx` y devuelve su entrada de referencia. */
async function mkOrder(s: OrderSpec): Promise<{ id: string; ref: SaleOrderInput }> {
  const qty = (l: LineSpec) => l.qty ?? 1;
  const live = s.lines.filter((l) => !l.cancelled && !l.roundCancelled);
  const subtotal = s.comped ? 0 : live.reduce((a, l) => a + l.price * qty(l), 0);
  const taxOnTop = s.comped ? 0 : live.reduce((a, l) => a + (l.taxKind && l.taxKind !== "none" && (l.taxPct ?? 0) > 0 ? Math.round((l.price * qty(l) * (l.taxPct ?? 0)) / 100) : 0), 0);
  const discount = s.discount ?? 0;
  const tip = s.tip ?? 0;
  const total = Math.max(0, subtotal + taxOnTop - discount) + tip;
  const compedAt = s.comped ? s.paidAt : null;
  const compAmount = s.comped ? s.lines.reduce((a, l) => a + l.price * qty(l), 0) : null;
  const order = await db.order.create({ data: {
    restaurantId: s.restaurantId, tableId: s.tableId, shortCode: randomUUID(), status: s.status ?? "paid",
    orderType: s.orderType ?? "dineIn", diners: s.diners ?? 1,
    createdAt: new Date((s.paidAt ?? new Date()).getTime() - 3 * 3600_000), paidAt: s.paidAt,
    subtotalCents: subtotal, taxCents: taxOnTop, tipCents: tip, discountCents: discount, totalCents: total,
    compedAt, compAmountCents: compAmount, compLabel: s.comped ? "Cortesía" : null,
    commissionWaiterId: s.commissionWaiterId ?? null, commissionCents: s.commissionCents ?? null,
    commissionBps: s.commissionWaiterId ? 250 : null, commissionBaseCents: s.commissionWaiterId ? subtotal - discount : null,
    commissionSealedAt: s.commissionWaiterId ? s.paidAt : null,
  } });
  const round = await db.round.create({ data: {
    orderId: order.id, seq: 1, status: "served", placedAt: new Date((s.paidAt ?? new Date()).getTime() - 75 * 60_000),
    placedByUserId: s.placedBy ?? null, placedByRole: s.placedBy ? "mesero" : null,
  } });
  const cancelledRound = s.lines.some((l) => l.roundCancelled)
    ? await db.round.create({ data: { orderId: order.id, seq: 2, status: "cancelled", cancelledAt: s.paidAt } })
    : null;
  for (const l of s.lines) {
    await db.orderItem.create({ data: {
      orderId: order.id, roundId: l.roundCancelled ? cancelledRound!.id : round.id,
      menuItemId: l.menuItemId ?? null, nameSnapshot: l.name ?? "Plato", priceCentsSnapshot: l.price, qty: qty(l),
      taxKind: l.taxKind ?? null, taxPct: l.taxPct ?? null,
      cancelledAt: s.comped ? compedAt : l.cancelled ? new Date((s.paidAt ?? new Date()).getTime() - 600_000) : null,
      cancellationKind: s.comped ? "comp" : l.cancelled ?? null,
      modifierSelections: l.mods ?? undefined,
    } });
  }
  if (s.invoice !== undefined) {
    await db.simpleInvoice.create({ data: { restaurantId: s.restaurantId, orderId: order.id, invoiceNumber: 1, totalCents: total, snapshot: s.invoice } });
  }
  const pays = s.payments ?? (s.comped || total === 0 ? [] : [{ method: "cash" }]);
  let left = total;
  let leftTip = tip;
  for (let i = 0; i < pays.length; i++) {
    const last = i === pays.length - 1;
    const amount = last ? left : Math.round(total * (pays[i]!.share ?? 0.5));
    const t = last ? leftTip : Math.min(leftTip, Math.round(tip * (pays[i]!.share ?? 0.5)));
    await db.payment.create({ data: { orderId: order.id, method: pays[i]!.method as never, status: s.status === "served" ? "pending" : "approved", amountCents: amount, tipCents: t } });
    left -= amount;
    leftTip -= t;
  }
  return {
    id: order.id,
    ref: {
      subtotalCents: subtotal, taxCents: taxOnTop, tipCents: tip, totalCents: total, discountCents: discount, diners: s.diners ?? 1,
      compedAt, compAmountCents: compAmount,
      invoice: s.invoice === undefined ? null : (s.invoice as { salesTaxKind?: unknown; embeddedTaxCents?: unknown }),
      lines: s.lines.map((l) => ({
        priceCentsSnapshot: l.price, qty: qty(l), taxKind: l.taxKind ?? null, menuItemId: l.menuItemId ?? null,
        live: !s.comped && !l.cancelled && !l.roundCancelled, comp: !!s.comped || l.cancelled === "comp",
      })),
    },
  };
}

async function tenant(name: string) {
  const r = await db.restaurant.create({ data: { name, slug: `sales-${randomUUID()}`, businessDayCutoffHour: 5, salesTaxKind: "inc", salesTaxPct: 8 } });
  tenantIds.push(r.id);
  const table = (number: number, extra: Partial<Prisma.TableUncheckedCreateInput> = {}) =>
    db.table.create({ data: { restaurantId: r.id, number, qrToken: randomUUID(), ...extra } });
  const [t1, t2, pick, manual] = [await table(1), await table(2, { label: "Terraza" }), await table(-1, { kind: "pickup" }), await table(-100, { kind: "manual" })];
  const cat = await db.category.create({ data: { restaurantId: r.id, slug: `c-${randomUUID()}`, label: "Fuertes" } });
  const drinks = await db.category.create({ data: { restaurantId: r.id, slug: `d-${randomUUID()}`, label: "Bebidas" } });
  const mk = (n: string, price: number, categoryId: string, modifiers?: Prisma.InputJsonValue) =>
    db.menuItem.create({ data: { restaurantId: r.id, categoryId, name: n, priceCents: price, modifiers } });
  const lomo = await mk("Lomo", 3_000_000, cat.id, [{ id: "term", label: "Término", type: "radio", opts: [{ label: "Medio" }] }]);
  const pasta = await mk("Pasta", 1_200_000, cat.id);
  const limonada = await mk("Limonada", 800_000, drinks.id, [{ id: "extras", label: "Extras", type: "checkbox", opts: [{ label: "Hierbabuena" }, { label: "Jengibre" }] }]);
  const user = (n: string) => db.user.create({ data: { email: `${n}-${randomUUID()}@example.test`, name: n, role: "mesero", restaurantId: r.id, passwordHash: "x" } });
  const [w1, w2] = [await user("Ana"), await user("Luis")];
  return { r, t1, t2, pick, manual, drinks, lomo, pasta, limonada, w1, w2 };
}

let A: Awaited<ReturnType<typeof tenant>>;
let B: Awaited<ReturnType<typeof tenant>>;
const day14: SaleOrderInput[] = [];
let o2Id = "";
const RANGE = { from: "2026-10-14", to: "2026-10-14" };
const scope = (dims: SalesScope["dims"] = {}, restaurantId = A.r.id): SalesScope => ({
  restaurantId, ...rangeInstants(RANGE, 5), cutoffHour: 5, tax: INC8, dims,
});

beforeAll(async () => {
  A = await tenant("Sales analysis A");
  B = await tenant("Sales analysis B (otro comercio)");
  const add = async (spec: OrderSpec) => (await mkOrder(spec)).ref;
  // 1. Sin factura, propina, efectivo actual + histórico, montada por Ana.
  day14.push(await add({
    restaurantId: A.r.id, tableId: A.t1.id, paidAt: bog("2026-10-14T20:10:00"), diners: 2, tip: 500_000, placedBy: A.w1.id,
    lines: [
      { price: 3_000_000, qty: 2, menuItemId: A.lomo.id, name: "Lomo", mods: { term: "Medio" } },
      { price: 800_000, menuItemId: A.limonada.id, name: "Limonada", mods: { extras: ["Hierbabuena", "Jengibre"] } },
    ],
    payments: [{ method: "demo_cash", share: 0.5 }, { method: "cash" }],
  }));
  // 2. Factura con INC congelado, descuento y comisión de Luis; pagada a la 01:30 del 15 (día 14).
  const o2 = await mkOrder({
    restaurantId: A.r.id, tableId: A.t2.id, paidAt: bog("2026-10-15T01:30:00"), diners: 3, discount: 500_000,
    placedBy: A.w1.id, commissionWaiterId: A.w2.id, commissionCents: 112_500,
    lines: [{ price: 3_000_000, menuItemId: A.lomo.id, name: "Lomo" }, { price: 1_200_000, qty: 2, menuItemId: A.pasta.id, name: "Pasta" }],
    invoice: { salesTaxKind: "inc", embeddedTaxCents: 370_370, customer: { name: "no" } },
    payments: [{ method: "kushki_card" }],
  });
  o2Id = o2.id;
  day14.push(o2.ref);
  // 3. Para llevar con línea libre con IVA encima.
  const o3 = await mkOrder({
    restaurantId: A.r.id, tableId: A.pick.id, paidAt: bog("2026-10-14T14:00:00"), orderType: "pickup",
    lines: [{ price: 10_000_000, name: "Catering", taxKind: "iva", taxPct: 19 }, { price: 2_000_000, menuItemId: A.limonada.id, name: "Limonada" }],
    payments: [{ method: "kushki_card" }],
  });
  day14.push(o3.ref);
  // 4. Cortesía de cuenta completa.
  day14.push(await add({ restaurantId: A.r.id, tableId: A.t1.id, paidAt: bog("2026-10-14T16:00:00"), comped: true, placedBy: A.w1.id,
    lines: [{ price: 1_500_000, qty: 2, menuItemId: A.pasta.id, name: "Pasta" }] }));
  // 5. Factura vieja sin impuesto, plato regalado, ronda y plato cancelados; 04:59 del 15.
  day14.push(await add({
    restaurantId: A.r.id, tableId: A.t1.id, paidAt: bog("2026-10-15T04:59:00"), tip: 200_000,
    lines: [
      { price: 2_500_000, menuItemId: A.pasta.id, name: "Pasta" },
      { price: 1_000_000, menuItemId: A.limonada.id, name: "Limonada", cancelled: "comp" },
      { price: 5_000_000, menuItemId: A.lomo.id, name: "Lomo", roundCancelled: true },
      { price: 700_000, menuItemId: A.limonada.id, name: "Limonada", cancelled: "cancel" },
    ],
    invoice: { subtotalCents: 2_500_000 },
  }));
  // 9. Factura manual.
  day14.push(await add({ restaurantId: A.r.id, tableId: A.manual.id, paidAt: bog("2026-10-14T12:00:00"), lines: [{ price: 300_000, name: "Servicio", taxKind: "none" }] }));
  // Fuera del día 14 (05:00 del 15 y 04:59:59 del 14), otro comercio y una cuenta sin pagar.
  await mkOrder({ restaurantId: A.r.id, tableId: A.t1.id, paidAt: bog("2026-10-15T05:00:00"), lines: [{ price: 999_900, menuItemId: A.pasta.id }] });
  await mkOrder({ restaurantId: A.r.id, tableId: A.t1.id, paidAt: bog("2026-10-14T04:59:59"), lines: [{ price: 111_100, menuItemId: A.pasta.id }] });
  await mkOrder({ restaurantId: B.r.id, tableId: B.t1.id, paidAt: bog("2026-10-14T20:00:00"), lines: [{ price: 7_777_700, menuItemId: B.lomo.id }] });
  await mkOrder({ restaurantId: A.r.id, tableId: A.t1.id, paidAt: null, status: "served", lines: [{ price: 4_444_400 }] });

  // Nota crédito aceptada de la cuenta 2 y su reembolso; reembolso suelto de la cuenta 3.
  const series = await db.creditNoteSeries.create({ data: { issuerNit: `9${Date.now()}`, environment: "2" } });
  seriesIds.push(series.id);
  const inv2 = await db.simpleInvoice.findUniqueOrThrow({ where: { orderId: o2.id } });
  const note = await db.creditNote.create({ data: {
    fiscalKey: randomUUID(), restaurantId: A.r.id, originalInvoiceId: inv2.id, seriesId: series.id, number: 1, documentNumber: "NC1",
    requestId: randomUUID(), requestHash: "h", reasonCode: "2", reasonText: "x", snapshot: {}, subtotalCents: 1_000_000, taxCents: 80_000, totalCents: 1_080_000,
  } });
  await db.dianDocument.create({ data: { restaurantId: A.r.id, kind: "credit_note", state: "accepted", creditNoteId: note.id, issuedAt: bog("2026-10-14T22:00:00") } });
  const p2 = await db.payment.findFirstOrThrow({ where: { orderId: o2.id } });
  const p3 = await db.payment.findFirstOrThrow({ where: { orderId: o3.id } });
  await db.kushkiTransaction.create({ data: { restaurantId: A.r.id, paymentId: p2.id, kushkiTxId: randomUUID(), kind: "refund", status: "approved", amountCents: 1_080_000, raw: {}, createdAt: bog("2026-10-14T23:00:00") } });
  await db.kushkiTransaction.create({ data: { restaurantId: A.r.id, paymentId: p3.id, kushkiTxId: randomUUID(), kind: "refund", status: "approved", amountCents: 540_000, raw: {}, createdAt: bog("2026-10-14T18:00:00") } });
});

afterAll(async () => {
  try {
    await db.dianDocument.deleteMany({ where: { restaurantId: { in: tenantIds } } });
    await db.creditNote.deleteMany({ where: { restaurantId: { in: tenantIds } } });
    await db.creditNoteSeries.deleteMany({ where: { id: { in: seriesIds } } });
    await db.restaurant.deleteMany({ where: { id: { in: tenantIds } } });
  } finally {
    await db.$disconnect();
  }
});

describe("análisis de ventas en PostgreSQL", () => {
  it("los totales del día operativo son exactamente los de la definición pura", async () => {
    const expected = sumSaleFacts(day14.map((o) => saleFacts(o, INC8)));
    const totals = await loadTotals(db, scope());
    expect(totals).toEqual(expected);
    expect(totals.orders).toBe(5); // la cortesía completa no es cuenta vendida
  });

  it("la venta neta es la misma del Resumen", async () => {
    const { start, end } = rangeInstants(RANGE, 5);
    const dash = await loadDashboardSales(A.r.id, { from: start, to: end }, INC8);
    expect((await loadTotals(db, scope())).netCents).toBe(dash.reduce((s, d) => s + d.netCents, 0));
  });

  it("los productos suman la venta neta y siguen el reparto por línea", async () => {
    const products = await loadProducts(db, scope());
    const totals = await loadTotals(db, scope());
    expect(Math.abs(products.reduce((s, p) => s + p.netCents, 0) - totals.netCents)).toBeLessThanOrEqual(products.length);
    const ref = new Map<string, number>();
    for (const o of day14) {
      const alloc = allocateLines(o, INC8);
      o.lines.filter((l) => l.live).forEach((l, i) => ref.set(l.menuItemId ?? "free", (ref.get(l.menuItemId ?? "free") ?? 0) + alloc[i]!.netCents));
    }
    const sql = new Map<string, number>();
    for (const p of products) sql.set(p.menuItemId ?? "free", (sql.get(p.menuItemId ?? "free") ?? 0) + p.netCents);
    for (const [k, v] of sql) expect(Math.abs(v - (ref.get(k) ?? 0))).toBeLessThanOrEqual(1);
  });

  it("filtro de producto: sólo sus líneas, sin propina", async () => {
    const lomo = await loadTotals(db, scope({ producto: A.lomo.id }));
    expect(lomo.orders).toBe(2);
    expect(lomo.tipCents).toBeNull();
    const ref = day14.reduce((s, o) => {
      const alloc = allocateLines(o, INC8);
      return s + o.lines.filter((l) => l.live).reduce((a, l, i) => a + (l.menuItemId === A.lomo.id ? alloc[i]!.netCents : 0), 0);
    }, 0);
    expect(Math.abs(lomo.netCents - Math.round(ref))).toBeLessThanOrEqual(1);
    expect((await loadTotals(db, scope({ categoria: A.drinks.id }))).compsCents).toBe(1_000_000);
  });

  it("mesero de la cuenta: comisión sellada o quien montó; y los filtros de cuenta", async () => {
    const waiters = await loadWaiters(db, scope());
    const byName = Object.fromEntries(waiters.map((w) => [w.name ?? "none", w]));
    expect(byName.Ana?.orders).toBe(1);
    expect(byName.Luis).toMatchObject({ orders: 1, commissionCents: 112_500 });
    expect((await loadTotals(db, scope({ mesero: A.w1.id }))).orders).toBe(1);
    expect((await loadTotals(db, scope({ mesero: NO_WAITER }))).orders).toBe(3);
    expect((await loadTotals(db, scope({ pago: "cash" }))).orders).toBe(3);
    expect((await loadTotals(db, scope({ canal: "llevar" }))).orders).toBe(1);
    expect((await loadTotals(db, scope({ mesa: A.t2.id }))).orders).toBe(1);
    expect((await loadTotals(db, scope({ hora: 20 }))).orders).toBe(1);
    expect((await loadTotals(db, scope({ dia: 4 }))).orders).toBe(0);
  });

  it("canales, métodos (efectivo histórico incluido), mapa de calor y modificadores", async () => {
    expect((await loadChannels(db, scope())).map((c) => c.channel).sort()).toEqual(["llevar", "manual", "salon"]);
    expect((await loadMethods(db, scope())).find((m) => m.method === "cash")?.payments).toBe(4);
    const heat = await loadHeat(db, scope());
    expect(heat.every((h) => h.dow === 3)).toBe(true); // la madrugada del jueves 15 es del miércoles 14
    expect(heat.map((h) => h.hour).sort((a, b) => a - b)).toEqual([1, 4, 12, 14, 20]);
    const mods = await loadModifiers(db, scope());
    expect(mods.map((m) => [m.group, m.option, m.units])).toEqual([["Término", "Medio", 2], ["Extras", "Hierbabuena", 1], ["Extras", "Jengibre", 1]]);
    const trend = await loadTrend(db, scope(), "hora");
    expect(trend.map((p) => p.bucket)).toContain("2026-10-14T01");
    expect((await loadOrders(db, scope(), 50)).length).toBe(5);
  });

  it("notas crédito y reembolsos sin doble conteo, también con filtros de cuenta", async () => {
    const all = await loadReturnRows(db, scope());
    const r = summarizeReturns(all.notes, all.refunds, INC8);
    expect(r.creditNotes).toMatchObject({ count: 1, baseCents: 1_000_000 });
    expect(r.refunds).toEqual({ count: 2, totalCents: 1_620_000, unlinkedCents: 540_000 });
    const luis = await loadReturnRows(db, scope({ mesero: A.w2.id }));
    expect(luis.refunds.every((x) => x.orderId === o2Id)).toBe(true);
    expect(summarizeReturns(luis.notes, luis.refunds, INC8).refunds.unlinkedCents).toBe(0);
  });

  it("cada comercio ve sólo lo suyo", async () => {
    const b = await loadTotals(db, scope({}, B.r.id));
    expect(b.orders).toBe(1);
    expect(b.netCents).toBe(Math.round(7_777_700 * 10000 / 10800));
    expect((await loadProducts(db, scope({}, B.r.id))).every((p) => p.menuItemId === B.lomo.id)).toBe(true);
    // Un id de otro comercio como filtro no trae nada del comercio A.
    expect((await loadTotals(db, scope({ producto: B.lomo.id }))).orders).toBe(0);
  });

  it("el orquestador compara el día con el anterior", async () => {
    const a = await loadSalesAnalysis(db, {
      restaurantId: A.r.id,
      filters: parseSalesFilters(new URLSearchParams("periodo=rango&desde=2026-10-14&hasta=2026-10-14")),
      today: "2026-10-31", cutoffHour: 5, tax: INC8, counterMode: false, recipesEnabled: true,
    });
    expect(a.compare?.totals.orders).toBe(1); // 04:59:59 del 14 = día 13
    expect(a.orders).toHaveLength(5);
    expect(a.engineering?.unreliable.every((u) => u.reason === "no_recipe")).toBe(true);
  });
});
