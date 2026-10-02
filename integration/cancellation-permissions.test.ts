import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { KitchenState, Prisma, Role } from "@prisma/client";
import { db } from "../src/lib/db";
import { lockOrder } from "../src/lib/orderLock";
import { autoFireRoundInTx } from "../src/lib/kds/autoFire";

const h = vi.hoisted(() => ({ restaurantId: "", staffId: "", role: "mesero" as Role,
  audit: vi.fn(), event: vi.fn(), print: vi.fn(), access: true }));
vi.mock("@/auth", () => ({ auth: async () => ({ user: { id: h.staffId, role: h.role, email: "staff@example.test" } }) }));
vi.mock("@/lib/activeRestaurant", () => ({
  getActiveRestaurantId: async () => h.restaurantId,
  getActiveContext: async () => ({ restaurantId: h.restaurantId, session: { user: { id: h.staffId, role: h.role, email: "staff@example.test" } } }),
}));
vi.mock("next-intl/server", () => ({ getLocale: async () => "es" }));
vi.mock("@/lib/rateLimit", () => ({ rateLimit: async () => true }));
vi.mock("@/lib/guestAccess", () => ({ canAccessOrder: async () => h.access, canAccessTable: async () => h.access }));
vi.mock("@/lib/events", () => ({ publishOrderEvent: h.event }));
vi.mock("@/lib/push", () => ({ sendPushToMeserosForTable: async () => {} }));
vi.mock("@/lib/auditLog", () => ({ recordAuditEvent: h.audit }));
vi.mock("@/lib/print/enqueue", () => ({ notifyAcceptedRoundTicketSafe: h.print }));
vi.mock("@/lib/kds/autoFireTickets", () => ({ notifyAutoFiredTickets: async () => {} }));
vi.mock("@/lib/prepaidRounds", () => ({ activateOpenRounds: async () => [] }));
vi.mock("@/lib/invoiceOnPaid", () => ({ issueInvoiceOnPaid: async () => ({ status: "skipped" }) }));
vi.mock("@/lib/meseroShift", () => ({ meseroNeedsShiftToCharge: async () => false }));
vi.mock("@/lib/waiterCommissionsSeal", () => ({ sealOrderCommission: async () => {} }));

import { PATCH as itemPatch } from "../src/app/api/operator/order-items/[id]/route";
import { PATCH as roundPatch } from "../src/app/api/operator/rounds/[id]/route";
import { PATCH as orderPatch } from "../src/app/api/operator/orders/[id]/route";
import { DELETE as dinerDelete } from "../src/app/api/tenant/[slug]/order-items/[id]/route";
import { POST as compPost } from "../src/app/api/tenant/[slug]/orders/[orderId]/comp/route";
import { POST as movePost } from "../src/app/api/operator/order-items/[id]/move/route";

const url = new URL(process.env.DATABASE_URL ?? "postgresql://localhost/invalid");
if (!["localhost", "127.0.0.1"].includes(url.hostname) || !/^\/mesapay_.*(?:test|validation)$/.test(url.pathname)) {
  throw new Error("Cancellation integration tests require a local mesapay_*test or mesapay_*validation database");
}
const slug = `cancellation-${randomUUID()}`;
let tenantId: string, tableId: string, manualTableId: string, menuItemId: string;
const request = (path: string, body: unknown, method = "PATCH") => new Request(`http://localhost${path}`, {
  method, headers: { host: "localhost", "content-type": "application/json" },
  ...(method === "DELETE" ? {} : { body: JSON.stringify(body) }),
});
const patchItem = (id: string, body: unknown) => itemPatch(request(`/api/operator/order-items/${id}`, body), { params: Promise.resolve({ id }) });
const patchRound = (id: string, body: unknown) => roundPatch(request(`/api/operator/rounds/${id}`, body), { params: Promise.resolve({ id }) });
const patchOrder = (id: string, status: string) => orderPatch(request(`/api/operator/orders/${id}`, { status }), { params: Promise.resolve({ id }) });
const deleteItem = (id: string) => dinerDelete(request(`/api/tenant/${slug}/order-items/${id}`, null, "DELETE"), { params: Promise.resolve({ slug, id }) });
const compOrder = (orderId: string) => compPost(request(`/api/tenant/${slug}/orders/${orderId}/comp`, { note: "Isolated test courtesy" }, "POST"), { params: Promise.resolve({ slug, orderId }) });
const moveItem = (id: string, targetTableId: string) => movePost(request(`/api/operator/order-items/${id}/move`, { targetTableId }, "POST"), { params: Promise.resolve({ id }) });
const cancel = { cancel: { reason: "Isolated test cancellation", markUnavailable: true } };
const comp = { cancel: { reason: "Isolated test complaint", kind: "comp" } };
async function fixture(states: KitchenState[] = ["placed"], options: { manual?: boolean; free?: boolean; served?: boolean } = {}) {
  const order = await db.order.create({ data: {
    restaurantId: tenantId, tableId: options.manual ? manualTableId : tableId,
    shortCode: randomUUID(), status: "placed", subtotalCents: states.length * 10000, totalCents: states.length * 10000,
    rounds: { create: { seq: 1, status: "placed" } },
  }, include: { rounds: true } });
  const round = order.rounds[0];
  const items = [];
  for (const kitchenStatus of states) items.push(await db.orderItem.create({ data: {
    orderId: order.id, roundId: round.id, menuItemId: options.free ? null : menuItemId,
    nameSnapshot: "Test dish", qty: 1, priceCentsSnapshot: 10000, kitchenStatus,
    servedAt: options.served ? new Date() : null,
  } }));
  return { order, round, items };
}
beforeAll(async () => {
  tenantId = (await db.restaurant.create({ data: { slug, name: "Cancellation test", compEnabled: true, compAllowedRoles: ["operator", "mesero"] } })).id;
  h.staffId = (await db.user.create({ data: { restaurantId: tenantId, email: `${slug}@example.test`, passwordHash: "unused-fixture", role: "mesero" } })).id;
  tableId = (await db.table.create({ data: { restaurantId: tenantId, number: 1, qrToken: randomUUID() } })).id;
  manualTableId = (await db.table.create({ data: { restaurantId: tenantId, number: -100, kind: "manual", qrToken: randomUUID() } })).id;
  const category = await db.category.create({ data: { restaurantId: tenantId, slug: "test", label: "Test" } });
  menuItemId = (await db.menuItem.create({ data: { restaurantId: tenantId, categoryId: category.id, name: "Test dish", priceCents: 10000 } })).id;
});
beforeEach(async () => {
  vi.clearAllMocks(); h.restaurantId = tenantId; h.role = "mesero"; h.access = true;
  await db.menuItem.update({ where: { id: menuItemId }, data: { available: true } });
});
afterAll(async () => {
  if (tenantId) await db.restaurant.delete({ where: { id: tenantId } });
  if (tenantId) await db.platformEvent.deleteMany({ where: { restaurantId: tenantId } });
  await db.$disconnect();
});

describe("prepared dish cancellation permissions on PostgreSQL", () => {
  it("backfills legacy preparation evidence, excluding technical manual/free lines and untouched siblings", async () => {
    const started = await fixture();
    const legacy = await fixture(["ready"], { served: true });
    const manual = await fixture(["ready"], { served: true, manual: true });
    const free = await fixture(["ready"], { served: true, free: true });
    const mixed = await fixture(["ready", "placed"]);
    const unrounded = await fixture(["ready"]);
    await db.orderItem.update({ where: { id: unrounded.items[0].id }, data: { roundId: null } });
    const timestamp = new Date("2026-10-01T12:00:00Z");
    await db.round.update({ where: { id: started.round.id }, data: { kitchenStartedAt: timestamp } });
    const sql = readFileSync(new URL("../prisma/migrations/20261002200000_preparation_cancellation_control/migration.sql", import.meta.url), "utf8").split(/;\s*/).slice(1).join(";");
    // Run only the backfill inside a rolled-back transaction, preserving
    // the rest of the isolated database used by other regression suites.
    await expect(db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(sql);
      const item = (id: string) => tx.orderItem.findUniqueOrThrow({ where: { id } });
      expect((await item(started.items[0].id)).preparationFirstStartedAt).toEqual(timestamp);
      expect((await item(legacy.items[0].id)).preparationFirstStartedAt).toEqual(legacy.items[0].servedAt);
      expect((await item(manual.items[0].id)).preparationFirstStartedAt).toBeNull();
      expect((await item(free.items[0].id)).preparationFirstStartedAt).toBeNull();
      expect((await item(mixed.items[0].id)).preparationFirstStartedAt).not.toBeNull();
      expect((await item(mixed.items[1].id)).preparationFirstStartedAt).toBeNull();
      expect((await item(unrounded.items[0].id)).preparationFirstStartedAt).not.toBeNull();
      throw new Error("ROLLBACK_BACKFILL_FIXTURE");
    })).rejects.toThrow("ROLLBACK_BACKFILL_FIXTURE");
  });
  it.each(["mesero", "kitchen", "bar"] as Role[])("%s can reject a never-started item but cannot cancel prepared or ready food", async (role) => {
    h.role = role;
    for (const state of ["in_kitchen", "ready"] as KitchenState[]) {
      const f = await fixture([state]);
      const before = await db.order.findUniqueOrThrow({ where: { id: f.order.id } });
      const res = await patchItem(f.items[0].id, cancel);
      expect(res.status).toBe(403);
      expect((await res.json()).error).toBe("cancellation_admin_required");
      expect((await db.orderItem.findUniqueOrThrow({ where: { id: f.items[0].id } })).cancelledAt).toBeNull();
      expect(await db.order.findUniqueOrThrow({ where: { id: f.order.id } })).toEqual(before);
      expect((await db.menuItem.findUniqueOrThrow({ where: { id: menuItemId } })).available).toBe(true);
    }
    expect(h.audit).not.toHaveBeenCalled(); expect(h.event).not.toHaveBeenCalled(); expect(h.print).not.toHaveBeenCalled();
    const pending = await fixture();
    expect((await patchItem(pending.items[0].id, cancel)).status).toBe(200);
    expect((await db.order.findUniqueOrThrow({ where: { id: pending.order.id } })).totalCents).toBe(0);
  });
  it.each(["operator", "platform_admin", "group_admin"] as Role[])("%s can cancel cooked food and comp served food with audit", async (role) => {
    h.role = role;
    const cooking = await fixture(["in_kitchen"]);
    expect((await patchItem(cooking.items[0].id, cancel)).status).toBe(200);
    const served = await fixture(["ready"], { served: true });
    expect((await patchItem(served.items[0].id, cancel)).status).toBe(409);
    expect((await patchItem(served.items[0].id, comp)).status).toBe(200);
    expect(await db.orderItem.findUniqueOrThrow({ where: { id: served.items[0].id } })).toMatchObject({ cancellationKind: "comp", cancelledByEmail: "staff@example.test" });
    expect(h.audit).toHaveBeenCalledWith(expect.objectContaining({ kind: "order_item.comp" }));
  });
  it("waiter courtesy configuration cannot override served-item or whole-bill restrictions", async () => {
    const f = await fixture(["ready"], { served: true });
    for (const res of [await patchItem(f.items[0].id, comp), await compOrder(f.order.id)]) {
      expect(res.status).toBe(403); expect((await res.json()).error).toBe("cancellation_admin_required");
    }
    expect((await db.order.findUniqueOrThrow({ where: { id: f.order.id } })).totalCents).toBe(10000);
    expect(h.audit).not.toHaveBeenCalled();
  });
  it("allows configured waiter courtesy for never-prepared food and group-admin courtesy for served food", async () => {
    const pending = await fixture();
    expect((await compOrder(pending.order.id)).status).toBe(200);
    h.role = "group_admin";
    const ready = await fixture(["ready"], { served: true });
    expect((await compOrder(ready.order.id)).status).toBe(200);
  });
  it("blocks mixed-round and whole-order cancellation as soon as any dish starts", async () => {
    const f = await fixture(["placed", "in_kitchen"]);
    for (const res of [await patchRound(f.round.id, { status: "cancelled", reason: "Test reason" }), await patchOrder(f.order.id, "cancelled")]) {
      expect(res.status).toBe(403); expect((await res.json()).error).toBe("cancellation_admin_required");
    }
    expect((await db.round.findUniqueOrThrow({ where: { id: f.round.id } })).status).toBe("placed");
    expect(await db.orderItem.count({ where: { orderId: f.order.id, cancelledAt: null } })).toBe(2);
    h.role = "operator";
    expect((await patchOrder(f.order.id, "cancelled")).status).toBe(409);
  });
  it("preserves normal never-started round and whole-order cancellation", async () => {
    const a = await fixture();
    expect((await patchRound(a.round.id, { status: "cancelled", reason: "Test reason" })).status).toBe(200);
    const b = await fixture();
    expect((await patchOrder(b.order.id, "cancelled")).status).toBe(200);
    expect((await db.orderItem.findUniqueOrThrow({ where: { id: b.items[0].id } })).cancellationKind).toBe("cancel");
  });
  it("item status reset and undo serving do not restore waiter or diner cancellation", async () => {
    const f = await fixture(["ready"], { served: true });
    expect((await patchItem(f.items[0].id, { served: false })).status).toBe(200);
    expect((await patchItem(f.items[0].id, { kitchenStatus: "placed" })).status).toBe(200);
    const reset = await db.orderItem.findUniqueOrThrow({ where: { id: f.items[0].id } });
    expect(reset.preparationFirstStartedAt).toEqual(f.items[0].servedAt);
    expect(reset.preparationStartedAt).toBeNull(); expect(reset.servedAt).toBeNull(); expect(reset.kitchenStatus).toBe("placed");
    expect((await patchItem(reset.id, cancel)).status).toBe(403);
    expect((await deleteItem(reset.id)).status).toBe(409);
    expect((await patchRound(f.round.id, { status: "cancelled", reason: "Test reason" })).status).toBe(403);
    expect((await compOrder(f.order.id)).status).toBe(403);
  });
  it("bulk and automatic preparation stamp each item, even if its timer is later reset", async () => {
    for (const automatic of [false, true]) {
      const f = await fixture(["placed", "placed"]);
      if (automatic) await db.$transaction(async (tx) => {
        await lockOrder(tx, f.order.id);
        await autoFireRoundInTx(tx, { roundId: f.round.id, flags: { kitchenAutoFire: true, barAutoFire: true }, now: new Date() });
      });
      else expect((await patchRound(f.round.id, { status: "in_kitchen" })).status).toBe(200);
      expect(await db.orderItem.count({ where: { orderId: f.order.id, preparationFirstStartedAt: { not: null } } })).toBe(2);
      expect((await patchRound(f.round.id, { status: "placed" })).status).toBe(200);
      expect((await patchItem(f.items[0].id, cancel)).status).toBe(403);
      expect((await patchOrder(f.order.id, "cancelled")).status).toBe(403);
    }
  });
  it("legacy whole-order delivery cannot bypass the preparation guard", async () => {
    const f = await fixture();
    expect((await patchOrder(f.order.id, "served")).status).toBe(200);
    expect((await patchItem(f.items[0].id, cancel)).status).toBe(403);
  });
  it("moving a reset prepared dish preserves its restriction and both totals", async () => {
    const f = await fixture();
    expect((await patchItem(f.items[0].id, { kitchenStatus: "in_kitchen" })).status).toBe(200);
    expect((await patchItem(f.items[0].id, { kitchenStatus: "placed" })).status).toBe(200);
    const first = (await db.orderItem.findUniqueOrThrow({ where: { id: f.items[0].id } })).preparationFirstStartedAt;
    const target = await db.table.create({ data: { restaurantId: tenantId, number: 500, qrToken: randomUUID() } });
    expect((await moveItem(f.items[0].id, target.id)).status).toBe(200);
    const moved = await db.orderItem.findUniqueOrThrow({ where: { id: f.items[0].id } });
    expect(moved.orderId).not.toBe(f.order.id);
    expect(moved.preparationFirstStartedAt).toEqual(first);
    expect(moved.kitchenStatus).toBe("placed");
    expect((await patchItem(moved.id, cancel)).status).toBe(403);
    expect((await deleteItem(moved.id)).status).toBe(409);
    expect((await patchOrder(moved.orderId, "cancelled")).status).toBe(403);
    expect(await db.order.findUniqueOrThrow({ where: { id: f.order.id } })).toMatchObject({ status: "cancelled", totalCents: 0 });
    expect((await db.order.findUniqueOrThrow({ where: { id: moved.orderId } })).totalCents).toBe(10000);
  });
  it("concurrent move cannot escape the cooking/cancellation order lock", async () => {
    const f = await fixture();
    const target = await db.table.create({ data: { restaurantId: tenantId, number: 501, qrToken: randomUUID() } });
    let unlock!: () => void, hasLock!: () => void;
    const locked = new Promise<void>((resolve) => { hasLock = resolve; });
    const gate = new Promise<void>((resolve) => { unlock = resolve; });
    const cook = db.$transaction(async (tx) => {
      await lockOrder(tx, f.order.id); hasLock(); await gate;
      await autoFireRoundInTx(tx, { roundId: f.round.id, flags: { kitchenAutoFire: true, barAutoFire: false }, now: new Date() });
    }, { timeout: 10000 });
    await locked;
    const moving = moveItem(f.items[0].id, target.id);
    const cancelling = patchItem(f.items[0].id, cancel);
    let waiting = 0;
    try {
      for (let attempt = 0; attempt < 100; attempt++) {
        const rows = await db.$queryRaw<{ count: bigint }[]>`SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE '%FOR UPDATE%'`;
        waiting = Number(rows[0].count);
        if (waiting >= 2) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    } finally { unlock(); }
    await cook;
    const [moveResponse, cancelResponse] = await Promise.all([moving, cancelling]);
    expect(waiting).toBeGreaterThanOrEqual(2);
    expect(moveResponse.status).toBe(200);
    expect([403, 409]).toContain(cancelResponse.status);
    const item = await db.orderItem.findUniqueOrThrow({ where: { id: f.items[0].id } });
    expect(item.cancelledAt).toBeNull(); expect(item.preparationFirstStartedAt).not.toBeNull();
    expect((await patchItem(item.id, cancel)).status).toBe(403);
  });
  it("manual invoice and free-charge technical served flags remain cancellable", async () => {
    for (const options of [{ manual: true }, { free: true }]) {
      const f = await fixture(["ready"], { ...options, served: true });
      expect((await patchItem(f.items[0].id, cancel)).status).toBe(200);
    }
    const manual = await fixture(["ready"], { manual: true, served: true });
    expect((await patchOrder(manual.order.id, "cancelled")).status).toBe(200);
  });
  it("diner can delete untouched food, but cannot delete cancelled-round food or pending payments", async () => {
    const untouched = await fixture(); expect((await deleteItem(untouched.items[0].id)).status).toBe(200);
    const cancelled = await fixture();
    await db.round.update({ where: { id: cancelled.round.id }, data: { status: "cancelled" } });
    expect((await deleteItem(cancelled.items[0].id)).status).toBe(409);
    const reserved = await fixture();
    await db.payment.create({ data: { orderId: reserved.order.id, amountCents: 10000, method: "kushki_card", status: "pending" } });
    for (const res of [await deleteItem(reserved.items[0].id), await patchOrder(reserved.order.id, "cancelled")]) expect(res.status).toBe(409);
    expect(await db.orderItem.count({ where: { orderId: reserved.order.id, cancelledAt: null } })).toBe(1);
  });
  it("closed bills and restaurant boundaries remain enforced", async () => {
    const f = await fixture();
    h.restaurantId = "other-restaurant";
    expect((await patchItem(f.items[0].id, cancel)).status).toBe(403);
    expect((await patchRound(f.round.id, { status: "cancelled", reason: "Test reason" })).status).toBe(403);
    expect((await patchOrder(f.order.id, "cancelled")).status).toBe(403);
    h.restaurantId = tenantId; h.access = false;
    expect((await deleteItem(f.items[0].id)).status).toBe(403);
    h.access = true;
    for (const status of ["paying", "paid", "cancelled"] as const) {
      await db.order.update({ where: { id: f.order.id }, data: { status } });
      expect((await patchItem(f.items[0].id, cancel)).status).toBe(409);
    }
  });
  it("rereads after waiting for kitchen under the order lock (stale item, round and order requests)", async () => {
    for (const path of ["item", "round", "order", "diner", "comp"] as const) {
      const f = await fixture();
      let unlock!: () => void, hasLock!: () => void;
      const locked = new Promise<void>((resolve) => { hasLock = resolve; });
      const gate = new Promise<void>((resolve) => { unlock = resolve; });
      const cook = db.$transaction(async (tx: Prisma.TransactionClient) => {
        await lockOrder(tx, f.order.id); hasLock(); await gate;
        await autoFireRoundInTx(tx, { roundId: f.round.id, flags: { kitchenAutoFire: true, barAutoFire: false }, now: new Date() });
      }, { timeout: 10000 });
      await locked;
      const pending = path === "item" ? patchItem(f.items[0].id, cancel) : path === "round"
        ? patchRound(f.round.id, { status: "cancelled", reason: "Test reason" }) : path === "order"
          ? patchOrder(f.order.id, "cancelled") : path === "diner" ? deleteItem(f.items[0].id) : compOrder(f.order.id);
      // Verify the request really reached a blocked row lock before allowing
      // preparation to commit; a fixed sleep alone would not prove the race.
      let waiting = false;
      try {
        for (let attempt = 0; attempt < 100; attempt++) {
          const rows = await db.$queryRaw<{ count: bigint }[]>`SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE '%FOR UPDATE%'`;
          if (Number(rows[0].count) > 0) { waiting = true; break; }
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      } finally { unlock(); }
      await cook;
      const response = await pending;
      expect(waiting).toBe(true);
      expect(response.status).toBe(path === "diner" ? 409 : 403);
      expect((await db.orderItem.findUniqueOrThrow({ where: { id: f.items[0].id } })).cancelledAt).toBeNull();
      expect((await db.order.findUniqueOrThrow({ where: { id: f.order.id } })).totalCents).toBe(10000);
    }
  });
});
