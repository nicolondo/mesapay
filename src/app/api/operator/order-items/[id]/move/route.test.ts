import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  tx: {} as ReturnType<typeof createTx>,
  outer: {} as ReturnType<typeof createItem>,
  live: {} as ReturnType<typeof createItem>,
  log: [] as string[],
  payments: new Set<string>(),
  role: "mesero",
}));
vi.mock("@/lib/secureApi", () => ({ secureApi: (handler: (request: Request, context: { params: Promise<{ id: string }> }) => Promise<Response>) => async (request: Request, context: { params: Promise<{ id: string }> }) => {
  try { return await handler(request, context); } catch (error) {
    if ((error as Error).message === "operation_conflict") return Response.json({ error: "operation_conflict" }, { status: 409 });
    throw error;
  }
} }));
vi.mock("@/auth", () => ({ auth: async () => ({ user: { id: "user", role: h.role } }) }));
vi.mock("@/lib/activeRestaurant", () => ({ getActiveContext: async () => ({ restaurantId: "restaurant" }) }));
vi.mock("next-intl/server", () => ({ getLocale: async () => "es" }));
vi.mock("@/lib/orders/placedBy", () => ({ resolvePlacedBy: () => ({}), roundPlacedByData: () => ({}) }));
vi.mock("@/lib/auditLog", () => ({ recordAuditEvent: vi.fn() }));
vi.mock("@/lib/events", () => ({ publishOrderEvent: vi.fn() }));
vi.mock("@/lib/orderTotals", () => ({ syncOrderSubtotalFromLiveItems: vi.fn() }));
vi.mock("@/lib/orderLock", () => ({ lockOrder: async (_tx: unknown, id: string) => { h.log.push(`lock:${id}`); } }));
vi.mock("@/lib/orders", () => ({
  requireMutableOrderInTx: async (_tx: unknown, id: string) => {
    h.log.push(`mutable:${id}`);
    if (h.payments.has(id)) throw new Error("operation_conflict");
  },
  recomputeOrderLinesInTx: async (_tx: unknown, id: string) => { h.log.push(`totals:${id}`); },
}));
vi.mock("@/lib/db", () => ({ db: {
  orderItem: { findUnique: async () => h.outer, count: async () => 1 },
  table: { findUnique: async () => ({ id: "target-table", number: 2, kind: "standard", restaurantId: "restaurant" }) },
  user: { findUnique: async () => ({ assignedTableNumbers: [] }) },
  order: { findFirst: async () => ({ id: "a-dest", status: "placed" }) },
  $transaction: async (fn: (tx: unknown) => unknown) => { const result = await fn(h.tx); h.log.push("commit"); return result; },
} }));
import { POST } from "./route";

function createItem() {
  return {
    id: "item", orderId: "z-source", roundId: "source-round", qty: 1, nameSnapshot: "Dish", cancelledAt: null as Date | null,
    servedAt: null as Date | null, kitchenStatus: "placed", preparationStartedAt: null as Date | null, preparationFirstStartedAt: null as Date | null,
    round: { status: "placed" },
    order: { restaurantId: "restaurant", tableId: "source-table", status: "placed", locale: "es", servingMode: "a_la_carte", table: { number: 1, kind: "standard" } },
  };
}
function createTx() {
  const dest = { id: "a-dest", status: "placed", restaurantId: "restaurant", tableId: "target-table" };
  return {
    $executeRaw: vi.fn(async () => 1),
    orderItem: {
      findUnique: vi.fn(async () => { h.log.push("read:item"); return h.live; }),
      update: vi.fn(async () => { h.log.push("move"); return {}; }),
      count: vi.fn(async () => 1),
    },
    order: { create: vi.fn(async () => ({ id: "new-dest", status: "placed" })), findFirst: vi.fn(async (): Promise<typeof dest | null> => dest), findUnique: vi.fn(async () => dest), update: vi.fn(), updateMany: vi.fn() },
    round: { findFirst: vi.fn(async () => ({ seq: 1 })), create: vi.fn(async () => ({ id: "new-round" })), delete: vi.fn() },
  };
}
beforeEach(() => {
  vi.clearAllMocks(); h.log = []; h.payments.clear(); h.role = "mesero";
  h.outer = createItem(); h.live = structuredClone(h.outer); h.tx = createTx();
});
const move = () => POST(new Request("http://localhost/api/operator/order-items/item/move", {
  method: "POST", body: JSON.stringify({ targetTableId: "target-table" }),
}), { params: Promise.resolve({ id: "item" }) });

describe("moving dishes serializes with preparation, cancellation and payment", () => {
  it("locks both accounts in stable order before live item reads, then totals before commit", async () => {
    expect((await move()).status).toBe(200);
    expect(h.log).toEqual(["lock:a-dest", "lock:z-source", "read:item", "mutable:z-source", "mutable:a-dest", "move", "totals:z-source", "totals:a-dest", "commit"]);
  });
  it("does not move an item already transferred by a concurrent request", async () => {
    h.live.orderId = "other-order";
    expect((await move()).status).toBe(409);
    expect(h.tx.orderItem.update).not.toHaveBeenCalled();
  });
  it("rejects cancellation committed while the request waited for the order lock", async () => {
    h.live.cancelledAt = new Date();
    const response = await move();
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "item_cancelled" });
    expect(h.tx.orderItem.update).not.toHaveBeenCalled();
  });
  it("rejects a round canceled while waiting", async () => {
    h.live.round.status = "cancelled";
    expect((await move()).status).toBe(409);
    expect(h.tx.orderItem.update).not.toHaveBeenCalled();
  });
  it.each(["z-source", "a-dest"])("rejects pending/approved payment in %s under the lock", async id => {
    h.payments.add(id);
    expect((await move()).status).toBe(409);
    expect(h.tx.orderItem.update).not.toHaveBeenCalled();
  });
  it("uses current preparation state for its destination round and leaves sticky history untouched", async () => {
    const startedAt = new Date("2026-10-02T15:00:00Z");
    h.live.kitchenStatus = "in_kitchen"; h.live.preparationStartedAt = startedAt; h.live.preparationFirstStartedAt = startedAt;
    expect((await move()).status).toBe(200);
    expect(h.tx.round.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "in_kitchen", kitchenStartedAt: startedAt }) }));
    expect(h.tx.orderItem.update).toHaveBeenCalledWith({ where: { id: "item" }, data: { orderId: "a-dest", roundId: "new-round" } });
  });
  it("rejects a source that entered payment while waiting for its lock", async () => {
    h.live.order.status = "paying";
    const response = await move();
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "order_paying" });
    expect(h.tx.orderItem.update).not.toHaveBeenCalled();
  });
  it("does not switch to a newly opened destination without locking it", async () => {
    h.tx.order.findFirst.mockResolvedValueOnce({ id: "a-dest", status: "placed", restaurantId: "restaurant", tableId: "target-table" });
    h.tx.order.findFirst.mockResolvedValueOnce({ id: "another", status: "placed", restaurantId: "restaurant", tableId: "target-table" });
    expect((await move()).status).toBe(409);
    expect(h.tx.orderItem.update).not.toHaveBeenCalled();
  });
  it("serializes creation of an empty destination and recomputes its new account atomically", async () => {
    h.tx.order.findFirst.mockResolvedValue(null);
    expect((await move()).status).toBe(200);
    expect(h.tx.$executeRaw).toHaveBeenCalledOnce();
    expect(h.tx.order.create).toHaveBeenCalledOnce();
    expect(h.log).toContain("totals:new-dest");
    expect(h.log.indexOf("totals:new-dest")).toBeLessThan(h.log.indexOf("commit"));
  });
  it("preserves the existing restriction on group_admin move requests", async () => {
    h.role = "group_admin";
    expect((await move()).status).toBe(403);
    expect(h.tx.orderItem.update).not.toHaveBeenCalled();
  });
});
