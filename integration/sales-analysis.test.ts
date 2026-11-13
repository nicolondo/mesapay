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
// Las pruebas históricas del módulo van con el eje «pago» (el comportamiento
// de siempre); el eje «pedido» tiene su propio bloque abajo.
const scope = (dims: SalesScope["dims"] = {}, restaurantId = A.r.id): SalesScope => ({
  restaurantId, ...rangeInstants(RANGE, 5), cutoffHour: 5, tax: INC8, dims, axis: "pago",
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
      filters: parseSalesFilters(new URLSearchParams("periodo=rango&desde=2026-10-14&hasta=2026-10-14&tiempo=pago")),
      today: "2026-10-31", cutoffHour: 5, tax: INC8, counterMode: false, recipesEnabled: true,
    });
    expect(a.compare?.totals.orders).toBe(1); // 04:59:59 del 14 = día 13
    expect(a.orders).toHaveLength(5);
    expect(a.engineering?.unreliable.every((u) => u.reason === "no_recipe")).toBe(true);
  });

  it("por defecto el orquestador ubica por hora del pedido: la cuenta pagada a las 05:00 del 15 se montó el 14", async () => {
    const a = await loadSalesAnalysis(db, {
      restaurantId: A.r.id,
      filters: parseSalesFilters(new URLSearchParams("periodo=rango&desde=2026-10-14&hasta=2026-10-14")),
      today: "2026-10-31", cutoffHour: 5, tax: INC8, counterMode: false, recipesEnabled: true,
    });
    expect(a.filters.axis).toBe("pedido");
    // Cada cuenta del fixture se montó 75 minutos antes de pagarse: la de las
    // 05:00 del 15 (día 15 por pago) se montó a las 03:45, todavía día 14.
    expect(a.current.totals.orders).toBe(6);
    expect(a.orders).toHaveLength(6);
    expect(a.compare?.totals.orders).toBe(1);
  });
});

// ── Eje «hora del pedido» ───────────────────────────────────────────────────
// Un comercio sintético con cuentas de varias rondas: el dinero de cada línea
// va a la hora de SU ronda y la cuenta (contarla, comensales, propina, ticket,
// pagos) a su apertura. Las ventas que entran son las mismas que por pago.
describe("análisis de ventas por hora del pedido", () => {
  type TimedLine = { price: number; qty?: number; menuItemId: string; comp?: boolean };
  type TimedOrder = {
    tableId: string; createdAt: Date; paidAt: Date | null; diners?: number; tip?: number; comped?: boolean;
    rounds: { at: Date; by?: string; lines: TimedLine[] }[]; method?: string;
  };
  let C: Awaited<ReturnType<typeof tenant>>;
  /** Cuenta con rondas en instantes distintos; devuelve su referencia y el reparto por ronda. */
  async function mkTimed(spec: TimedOrder) {
    const qty = (l: TimedLine) => l.qty ?? 1;
    const all = spec.rounds.flatMap((r) => r.lines);
    const live = spec.comped ? [] : all.filter((l) => !l.comp);
    const subtotal = live.reduce((a, l) => a + l.price * qty(l), 0);
    const tip = spec.tip ?? 0;
    const total = subtotal + tip;
    const compedAt = spec.comped ? spec.paidAt : null;
    const order = await db.order.create({ data: {
      restaurantId: C.r.id, tableId: spec.tableId, shortCode: randomUUID(), status: spec.paidAt ? "paid" : "served",
      diners: spec.diners ?? 1, createdAt: spec.createdAt, placedAt: spec.rounds[0]?.at ?? null, paidAt: spec.paidAt,
      subtotalCents: subtotal, taxCents: 0, tipCents: tip, discountCents: 0, totalCents: total,
      compedAt, compAmountCents: spec.comped ? all.reduce((a, l) => a + l.price * qty(l), 0) : null,
      compLabel: spec.comped ? "Cortesía" : null,
    } });
    let seq = 0;
    for (const r of spec.rounds) {
      const round = await db.round.create({ data: {
        orderId: order.id, seq: ++seq, status: "served", placedAt: r.at,
        placedByUserId: r.by ?? null, placedByRole: r.by ? "mesero" : null,
      } });
      for (const l of r.lines) {
        const comp = spec.comped || l.comp;
        await db.orderItem.create({ data: {
          orderId: order.id, roundId: round.id, menuItemId: l.menuItemId, nameSnapshot: "Plato",
          priceCentsSnapshot: l.price, qty: qty(l),
          cancelledAt: comp ? (compedAt ?? r.at) : null, cancellationKind: comp ? "comp" : null,
        } });
      }
    }
    if (spec.paidAt && total > 0) {
      await db.payment.create({ data: {
        orderId: order.id, method: (spec.method ?? "cash") as never, status: "approved", amountCents: total, tipCents: tip,
      } });
    }
    const ref: SaleOrderInput = {
      subtotalCents: subtotal, taxCents: 0, tipCents: tip, totalCents: total, discountCents: 0, diners: spec.diners ?? 1,
      compedAt, compAmountCents: spec.comped ? all.reduce((a, l) => a + l.price * qty(l), 0) : null, invoice: null,
      lines: all.map((l) => ({
        priceCentsSnapshot: l.price, qty: qty(l), taxKind: null, menuItemId: l.menuItemId,
        live: !spec.comped && !l.comp, comp: !!spec.comped || !!l.comp,
      })),
    };
    // Venta neta de cada ronda (reparto de la referencia pura entre sus líneas vivas).
    const alloc = allocateLines(ref, INC8);
    let i = 0;
    const byRound = spec.rounds.map((r) => r.lines.reduce((sum, l) => {
      if (spec.comped || l.comp) return sum;
      return sum + alloc[i++]!.netCents;
    }, 0));
    return { id: order.id, ref, facts: saleFacts(ref, INC8), byRound };
  }

  let acctA: Awaited<ReturnType<typeof mkTimed>>;
  let acctB: Awaited<ReturnType<typeof mkTimed>>;
  let acctD: Awaited<ReturnType<typeof mkTimed>>;
  let compC: Awaited<ReturnType<typeof mkTimed>>;
  const day = (from: string, to = from) => ({ from, to });
  const at = (range: { from: string; to: string }, axis: SalesScope["axis"], dims: SalesScope["dims"] = {}): SalesScope => ({
    restaurantId: C.r.id, ...rangeInstants(range, 5), cutoffHour: 5, tax: INC8, dims, axis,
  });

  beforeAll(async () => {
    C = await tenant("Sales analysis C (hora del pedido)");
    // A: dos rondas (20:00 y 22:00 del 14, la segunda con un plato regalado),
    //    pagada a las 03:00 del 15 — antes del corte, día 14 en los dos ejes.
    acctA = await mkTimed({
      tableId: C.t1.id, createdAt: bog("2026-10-14T19:50:00"), paidAt: bog("2026-10-15T03:00:00"), diners: 2, tip: 300_000,
      rounds: [
        { at: bog("2026-10-14T20:00:00"), by: C.w1.id, lines: [{ price: 3_000_000, menuItemId: C.lomo.id }, { price: 800_000, menuItemId: C.limonada.id }] },
        { at: bog("2026-10-14T22:00:00"), by: C.w1.id, lines: [{ price: 1_200_000, qty: 2, menuItemId: C.pasta.id }, { price: 800_000, menuItemId: C.limonada.id, comp: true }] },
      ],
    });
    // B: montada el 14 a las 21:05 y pagada el 16 al mediodía (fuera del período del pedido).
    acctB = await mkTimed({
      tableId: C.t2.id, createdAt: bog("2026-10-14T21:00:00"), paidAt: bog("2026-10-16T12:00:00"), diners: 3, method: "kushki_card",
      rounds: [{ at: bog("2026-10-14T21:05:00"), by: C.w2.id, lines: [{ price: 3_000_000, menuItemId: C.lomo.id }] }],
    });
    // C: cortesía de cuenta completa montada a las 18:00 del 14.
    compC = await mkTimed({
      tableId: C.t1.id, createdAt: bog("2026-10-14T17:55:00"), paidAt: bog("2026-10-14T19:00:00"), comped: true,
      rounds: [{ at: bog("2026-10-14T18:00:00"), lines: [{ price: 1_500_000, menuItemId: C.pasta.id }] }],
    });
    // D: abierta el 13 a las 23:10; segunda ronda a las 05:30 del 14 (después
    //    del corte: día 14); pagada a las 06:00 del 14.
    acctD = await mkTimed({
      tableId: C.t2.id, createdAt: bog("2026-10-13T23:00:00"), paidAt: bog("2026-10-14T06:00:00"), diners: 4, tip: 100_000,
      rounds: [
        { at: bog("2026-10-13T23:10:00"), lines: [{ price: 1_200_000, menuItemId: C.pasta.id }] },
        { at: bog("2026-10-14T05:30:00"), lines: [{ price: 800_000, menuItemId: C.limonada.id }] },
      ],
    });
    // E: montada el 14 y todavía abierta: no es venta en ningún eje.
    await mkTimed({
      tableId: C.t1.id, createdAt: bog("2026-10-14T20:20:00"), paidAt: null,
      rounds: [{ at: bog("2026-10-14T20:30:00"), lines: [{ price: 9_999_900, menuItemId: C.lomo.id }] }],
    });
  });

  it("una mesa que pidió a las 20 y volvió a pedir a las 22 reparte su venta en esas dos horas", async () => {
    const trend = await loadTrend(db, at(day("2026-10-14"), "pedido"), "hora");
    const bucket = (h: string) => trend.find((p) => p.bucket === `2026-10-14T${h}`);
    expect(bucket("20")).toMatchObject({ netCents: Math.round(acctA.byRound[0]!), orders: 1, diners: 2 });
    expect(bucket("22")).toMatchObject({ netCents: Math.round(acctA.byRound[1]!), orders: 0, diners: 0 });
    // El ticket del balde de apertura es el de la cuenta entera.
    expect(bucket("20")?.accountNetCents).toBe(acctA.facts.netCents);
    // Por pago, todo cae a las 03:00 (madrugada del día 14).
    const paid = await loadTrend(db, at(day("2026-10-14"), "pago"), "hora");
    expect(paid.find((p) => p.bucket === "2026-10-14T03")).toMatchObject({ netCents: acctA.facts.netCents, orders: 1 });
    expect(paid.some((p) => p.bucket === "2026-10-14T20" || p.bucket === "2026-10-14T22")).toBe(false);
  });

  it("los totales del día por pedido: la cuenta pagada después cuenta en su día de pedido; la abierta no cuenta", async () => {
    const pedido = await loadTotals(db, at(day("2026-10-14"), "pedido"));
    const net14 = acctA.facts.netCents + acctB.facts.netCents + acctD.byRound[1]!;
    expect(pedido.orders).toBe(2); // A y B (D se abrió el 13; E sigue abierta; la cortesía no es venta)
    expect(pedido.diners).toBe(5);
    expect(Math.abs(pedido.netCents - Math.round(net14))).toBeLessThanOrEqual(1);
    expect(pedido.tipCents).toBe(300_000);
    expect(pedido.accountNetCents).toBe(acctA.facts.netCents + acctB.facts.netCents);
    expect(pedido.units).toBe(1 + 1 + 2 + 1 + 1); // A: lomo, limonada, 2 pastas · B: lomo · D: limonada (2.ª ronda)
    expect(pedido.compsCents).toBe(800_000 + 1_500_000);

    const pago = await loadTotals(db, at(day("2026-10-14"), "pago"));
    expect(pago.orders).toBe(2); // A y D
    expect(pago.netCents).toBe(acctA.facts.netCents + acctD.facts.netCents);
    expect(pago.accountNetCents).toBe(pago.netCents);
    expect(pago.compsCents).toBe(800_000 + 1_500_000);

    // B por pago es del 16; por pedido, nada del 16.
    expect((await loadTotals(db, at(day("2026-10-16"), "pago"))).orders).toBe(1);
    expect((await loadTotals(db, at(day("2026-10-16"), "pedido"))).netCents).toBe(0);
  });

  it("la cuenta que cruza el corte: la apertura y su primera ronda al 13, la segunda ronda al 14", async () => {
    const d13 = await loadTotals(db, at(day("2026-10-13"), "pedido"));
    expect(d13.orders).toBe(1);
    expect(Math.abs(d13.netCents - Math.round(acctD.byRound[0]!))).toBeLessThanOrEqual(1);
    expect(d13.accountNetCents).toBe(acctD.facts.netCents); // el ticket es el de la cuenta entera
    expect(d13.tipCents).toBe(100_000);
    expect((await loadTotals(db, at(day("2026-10-13"), "pago"))).orders).toBe(0);
  });

  it("las mismas ventas en los dos ejes: en un rango que cubre todo, los totales coinciden", async () => {
    const range = day("2026-10-12", "2026-10-17");
    const pedido = await loadTotals(db, at(range, "pedido"));
    const pago = await loadTotals(db, at(range, "pago"));
    expect(pedido).toEqual(pago);
    expect(pago).toEqual(sumSaleFacts([acctA, acctB, compC, acctD].map((x) => x.facts)));
  });

  it("comparación con el día anterior en los dos ejes", async () => {
    const run = (qs: string) => loadSalesAnalysis(db, {
      restaurantId: C.r.id,
      filters: parseSalesFilters(new URLSearchParams(`periodo=rango&desde=2026-10-14&hasta=2026-10-14${qs}`)),
      today: "2026-10-31", cutoffHour: 5, tax: INC8, counterMode: false, recipesEnabled: false,
    });
    const pedido = await run("");
    expect(pedido.compareRange).toEqual({ from: "2026-10-13", to: "2026-10-13" });
    expect([pedido.current.totals.orders, pedido.compare?.totals.orders]).toEqual([2, 1]);
    expect(pedido.compare?.trend.reduce((s, p) => s + p.orders, 0)).toBe(1);
    expect(pedido.kpis.avgTicketCents).toBe(Math.round((acctA.facts.netCents + acctB.facts.netCents) / 2));
    const pago = await run("&tiempo=pago");
    expect([pago.current.totals.orders, pago.compare?.totals.orders]).toEqual([2, 0]);
  });

  it("día y hora filtran las tajadas: lo pedido a las 22 sin contar la cuenta abierta a las 20", async () => {
    const h22 = await loadTotals(db, at(day("2026-10-14"), "pedido", { hora: 22 }));
    expect(h22.orders).toBe(0);
    expect(Math.abs(h22.netCents - Math.round(acctA.byRound[1]!))).toBeLessThanOrEqual(1);
    expect(h22.compsCents).toBe(800_000); // el plato regalado se pidió a las 22
    expect((await loadTotals(db, at(day("2026-10-14"), "pago", { hora: 22 }))).netCents).toBe(0);
    // El 14 fue miércoles (3): en un rango largo, el filtro de día también va por pedido.
    const wed = await loadTotals(db, at(day("2026-10-12", "2026-10-17"), "pedido", { dia: 3 }));
    expect(wed.orders).toBe(2);
    const heat = await loadHeat(db, at(day("2026-10-12", "2026-10-17"), "pedido"));
    expect(heat.filter((h) => h.dow === 3).map((h) => h.hour).sort((x, y) => x - y)).toEqual([5, 20, 21, 22]);
  });

  it("filtro de producto: sus líneas por la hora de su ronda; la cuenta cuenta en su apertura si lo pidió", async () => {
    const pasta = (dims: SalesScope["dims"]) => loadTotals(db, at(day("2026-10-14"), "pedido", { producto: C.pasta.id, ...dims }));
    const all = await pasta({});
    expect(all.orders).toBe(1); // A (la pasta de D se pidió el 13)
    expect(all.units).toBe(2);
    expect(all.tipCents).toBeNull();
    const at20 = await pasta({ hora: 20 });
    expect([at20.orders, at20.netCents]).toEqual([1, 0]); // A se abrió a las 20 sin pasta
    const at22 = await pasta({ hora: 22 });
    expect(at22.orders).toBe(0);
    expect(at22.netCents).toBe(all.netCents);
  });

  it("productos, meseros, pagos y cuentas del día siguen el mismo eje", async () => {
    const units = async (axis: SalesScope["axis"]) =>
      Object.fromEntries((await loadProducts(db, at(day("2026-10-14"), axis))).map((p) => [p.menuItemId, p.units]));
    expect(await units("pedido")).toEqual({ [C.lomo.id]: 2, [C.limonada.id]: 2, [C.pasta.id]: 2 });
    expect(await units("pago")).toEqual({ [C.lomo.id]: 1, [C.limonada.id]: 2, [C.pasta.id]: 3 });

    const waiters = await loadWaiters(db, at(day("2026-10-14"), "pedido"));
    const byName = Object.fromEntries(waiters.map((w) => [w.name ?? "none", w]));
    expect(byName.Ana).toMatchObject({ orders: 1, netCents: acctA.facts.netCents, tipCents: 300_000 });
    expect(byName.Luis).toMatchObject({ orders: 1, netCents: acctB.facts.netCents });
    expect(byName.none?.orders).toBe(0); // la 2.ª ronda de D, sin la cuenta

    const methods = await loadMethods(db, at(day("2026-10-14"), "pedido"));
    expect(Object.fromEntries(methods.map((m) => [m.method, m.orders]))).toEqual({ cash: 1, kushki_card: 1 });

    const orders = await loadOrders(db, at(day("2026-10-14"), "pedido"), 50);
    expect(orders.map((o) => o.id)).toEqual([acctB.id, acctA.id, acctD.id]); // por apertura, la más reciente primero
    expect(orders.find((o) => o.id === acctD.id)).toMatchObject({ diners: 0, openedAt: bog("2026-10-13T23:10:00") });
    expect(Math.abs(orders.reduce((s, o) => s + o.netCents, 0) - (await loadTotals(db, at(day("2026-10-14"), "pedido"))).netCents))
      .toBeLessThanOrEqual(1);
    expect((await loadOrders(db, at(day("2026-10-14"), "pago"), 50)).map((o) => o.id)).toEqual([acctA.id, acctD.id]);
  });
});
