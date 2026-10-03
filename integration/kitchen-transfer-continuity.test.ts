import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { KitchenState, OrderStatus, PrepStation } from "@prisma/client";
import { db } from "../src/lib/db";

const h = vi.hoisted(() => ({ restaurantId: "", staffId: "", event: vi.fn(), audit: vi.fn(), print: vi.fn() }));
vi.mock("@/auth", () => ({ auth: async () => ({ user: { id: h.staffId, role: "operator", name: "Transfer administrator", email: "transfer@example.test" } }) }));
vi.mock("@/lib/activeRestaurant", () => ({
  getActiveRestaurantId: async () => h.restaurantId,
  getActiveContext: async () => ({ restaurantId: h.restaurantId, session: { user: { id: h.staffId, role: "operator", name: "Transfer administrator", email: "transfer@example.test" } } }),
}));
vi.mock("next-intl/server", () => ({ getLocale: async () => "es" }));
vi.mock("@/lib/rateLimit", () => ({ rateLimit: async () => true }));
vi.mock("@/lib/events", () => ({ publishOrderEvent: h.event }));
vi.mock("@/lib/auditLog", () => ({ recordAuditEvent: h.audit }));
vi.mock("@/lib/print/enqueue", () => ({ notifyAcceptedRoundTicketSafe: h.print }));
import { POST as moveItemRoute } from "../src/app/api/operator/order-items/[id]/move/route";
import { POST as moveOrderRoute } from "../src/app/api/operator/orders/[id]/move/route";

const database = new URL(process.env.DATABASE_URL ?? "postgresql://localhost/invalid");
if (!["localhost", "127.0.0.1"].includes(database.hostname) || !/^\/mesapay_.*(?:test|validation)$/.test(database.pathname)) {
  throw new Error("Transfer continuity tests require an explicitly selected local validation database");
}
const slug = `transfer-continuity-${randomUUID()}`;
const placedAt = new Date("2026-09-30T16:00:00Z");
const startedAt = new Date("2026-09-30T16:05:00Z");
const readyAt = new Date("2026-09-30T16:15:00Z");
const servedAt = new Date("2026-09-30T16:20:00Z");
let originalStaffId: string, menuItemId: string, tableNumber = 0;
const move = (kind: "item" | "order", id: string, targetTableId: string) => {
  const path = `/api/operator/${kind === "item" ? "order-items" : "orders"}/${id}/move`;
  return (kind === "item" ? moveItemRoute : moveOrderRoute)(new Request(`http://localhost${path}`, {
    method: "POST", headers: { host: "localhost", "content-type": "application/json" }, body: JSON.stringify({ targetTableId }),
  }), { params: Promise.resolve({ id }) });
};
const newTable = () => db.table.create({ data: { restaurantId: h.restaurantId, number: ++tableNumber, qrToken: randomUUID() } });

async function fixture(state: "placed" | "in_kitchen" | "ready" | "served", station: PrepStation = "kitchen", unknownTimes = false) {
  const table = await newTable();
  const order = await db.order.create({ data: { restaurantId: h.restaurantId, tableId: table.id, shortCode: randomUUID(), status: state as OrderStatus, subtotalCents: 246800, totalCents: 246800, placedAt } });
  const round = await db.round.create({ data: {
    orderId: order.id, seq: 1, status: state, placedAt,
    kitchenStartedAt: state === "placed" || unknownTimes ? null : startedAt,
    readyAt: ["ready", "served"].includes(state) && !unknownTimes ? readyAt : null,
    placedByUserId: originalStaffId, placedByName: "Original waiter", placedByRole: "mesero",
  } });
  const item = await db.orderItem.create({ data: {
    orderId: order.id, roundId: round.id, menuItemId, nameSnapshot: `Transfer ${state}`, qty: 2, priceCentsSnapshot: 123400,
    kitchenStatus: (state === "served" ? "ready" : state) as KitchenState,
    station, barSubStation: station === "bar" ? "Cocktails" : null, prepMinutesSnapshot: 120,
    preparationStartedAt: state === "placed" || unknownTimes ? null : startedAt,
    preparationFirstStartedAt: state === "placed" ? null : startedAt,
    servedAt: state === "served" ? servedAt : null,
    modifierSelections: [{ label: "Original selection" }], notes: "Original note", guestName: "Original guest",
  } });
  return { order, round, item };
}
beforeAll(async () => {
  h.restaurantId = (await db.restaurant.create({ data: { slug, name: "Transfer continuity", hasBar: true, kitchenAutoFire: true, barAutoFire: true, kitchenPrintEnabled: false, barPrintEnabled: false } })).id;
  h.staffId = (await db.user.create({ data: { restaurantId: h.restaurantId, role: "operator", email: `${slug}-admin@example.test`, passwordHash: "fixture" } })).id;
  originalStaffId = (await db.user.create({ data: { restaurantId: h.restaurantId, role: "mesero", email: `${slug}-waiter@example.test`, passwordHash: "fixture" } })).id;
  const category = await db.category.create({ data: { restaurantId: h.restaurantId, slug: "test", label: "Test" } });
  menuItemId = (await db.menuItem.create({ data: { restaurantId: h.restaurantId, categoryId: category.id, name: "Original item", priceCents: 123400 } })).id;
});
beforeEach(() => vi.clearAllMocks());
afterAll(async () => {
  if (h.restaurantId) {
    await db.restaurant.delete({ where: { id: h.restaurantId } });
    await db.platformEvent.deleteMany({ where: { restaurantId: h.restaurantId } });
  }
  await db.$disconnect();
});

describe("kitchen/bar preparation continuity when transferring tables", () => {
  it.each(["placed", "in_kitchen", "ready", "served"] as const)("preserves the full %s item and original round timeline across repeated transfers", async state => {
    const f = await fixture(state, state === "in_kitchen" ? "bar" : "kitchen");
    for (let iteration = 0; iteration < 2; iteration++) {
      const target = await newTable();
      expect((await move("item", f.item.id, target.id)).status).toBe(200);
      const moved = await db.orderItem.findUniqueOrThrow({ where: { id: f.item.id } });
      expect(moved).toEqual({ ...f.item, orderId: moved.orderId, roundId: moved.roundId });
      expect(moved.orderId).not.toBe(f.order.id);
      const round = await db.round.findUniqueOrThrow({ where: { id: moved.roundId! } });
      expect(round).toMatchObject({
        status: state, placedAt: f.round.placedAt, kitchenStartedAt: f.round.kitchenStartedAt, readyAt: f.round.readyAt,
        placedByUserId: f.round.placedByUserId, placedByName: f.round.placedByName, placedByRole: f.round.placedByRole,
      });
      const onBoard = await db.round.count({ where: { id: round.id, status: { in: ["placed", "in_kitchen", "ready"] }, items: { some: { station: f.item.station, cancelledAt: null, servedAt: null } } } });
      expect(onBoard).toBe(state === "served" ? 0 : 1);
      expect((await db.order.findUniqueOrThrow({ where: { id: moved.orderId } })).totalCents).toBe(246800);
    }
    expect(h.print).not.toHaveBeenCalled();
    expect(await db.printJob.count({ where: { restaurantId: h.restaurantId } })).toBe(0);
  });
  it.each(["in_kitchen", "ready"] as const)("does not invent preparation/ready time for a legacy %s item", async state => {
    const f = await fixture(state, "bar", true);
    expect((await move("item", f.item.id, (await newTable()).id)).status).toBe(200);
    const moved = await db.orderItem.findUniqueOrThrow({ where: { id: f.item.id }, include: { round: true } });
    expect(moved.preparationStartedAt).toBeNull();
    expect(moved.preparationFirstStartedAt).toEqual(startedAt);
    expect(moved.round).toMatchObject({ placedAt, kitchenStartedAt: null, readyAt: null });
  });
  it("whole-account transfer preserves round identities, chronology and every item field", async () => {
    const f = await fixture("in_kitchen", "bar");
    const target = await newTable();
    expect((await move("order", f.order.id, target.id)).status).toBe(200);
    expect(await db.orderItem.findUniqueOrThrow({ where: { id: f.item.id } })).toEqual(f.item);
    expect(await db.round.findUniqueOrThrow({ where: { id: f.round.id } })).toEqual(f.round);
    expect((await db.order.findUniqueOrThrow({ where: { id: f.order.id } })).tableId).toBe(target.id);
    expect(h.print).not.toHaveBeenCalled();
  });
});
