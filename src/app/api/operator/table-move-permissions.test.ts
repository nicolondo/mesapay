import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  auth: vi.fn(),
  context: vi.fn(),
  tenant: vi.fn(),
  user: vi.fn(),
  order: vi.fn(),
  item: vi.fn(),
  table: vi.fn(),
  liveOrder: vi.fn(),
  updateOrder: vi.fn(),
  updateItem: vi.fn(),
  countItem: vi.fn(),
  updateMany: vi.fn(),
  roundFind: vi.fn(),
  roundCreate: vi.fn(),
  transaction: vi.fn(),
  audit: vi.fn(),
  event: vi.fn(),
  sync: vi.fn(),
  lock: vi.fn(),
  mutable: vi.fn(),
  advisory: vi.fn(),
}));

vi.mock("@/lib/secureApi", () => ({ secureApi: (handler: unknown) => handler }));
vi.mock("@/auth", () => ({ auth: m.auth }));
vi.mock("@/lib/activeRestaurant", () => ({
  getActiveRestaurantId: async () => "r",
  getActiveContext: m.context,
}));
vi.mock("@/lib/events", () => ({ publishOrderEvent: m.event }));
vi.mock("@/lib/auditLog", () => ({ recordAuditEvent: m.audit }));
vi.mock("@/lib/orderTotals", () => ({ syncOrderSubtotalFromLiveItems: m.sync }));
vi.mock("next-intl/server", () => ({ getLocale: async () => "es" }));
vi.mock("@/lib/orderLock", () => ({ lockOrder: m.lock }));
vi.mock("@/lib/orders", () => ({ requireMutableOrderInTx: m.mutable, recomputeOrderLinesInTx: m.sync }));
vi.mock("@/lib/db", () => ({
  db: {
    restaurant: { findUnique: m.tenant },
    user: { findUnique: m.user },
    table: { findUnique: m.table },
    order: {
      findUnique: m.order,
      findFirst: m.liveOrder,
      update: m.updateOrder,
      updateMany: m.updateMany,
    },
    orderItem: {
      findUnique: m.item,
      update: m.updateItem,
      count: m.countItem,
    },
    $transaction: m.transaction,
  },
}));

import { POST as moveOrder } from "./orders/[id]/move/route";
import { POST as moveItem } from "./order-items/[id]/move/route";

const order = {
  id: "o",
  restaurantId: "r",
  tableId: "source",
  status: "placed",
  locale: "es",
  servingMode: "as_ready",
  table: { number: 2, kind: "standard" },
};
const target = {
  id: "target",
  number: 3,
  restaurantId: "r",
  kind: "standard",
};
const item = {
  id: "i",
  orderId: "o",
  roundId: null,
  qty: 1,
  nameSnapshot: "Plato",
  priceCentsSnapshot: 1000,
  cancelledAt: null,
  servedAt: null,
  kitchenStatus: "placed",
  preparationStartedAt: null,
  order,
};
const request = () => new Request("http://localhost/api/operator/move", {
  method: "POST",
  body: JSON.stringify({ targetTableId: "target" }),
});
const params = { params: Promise.resolve({ id: "resource" }) };

function setRole(role: string) {
  const session = { user: { id: "u", role, restaurantId: "r" } };
  m.auth.mockResolvedValue(session);
  m.context.mockResolvedValue({ session, restaurantId: "r" });
}

function expectNoMovement() {
  expect(m.updateOrder).not.toHaveBeenCalled();
  expect(m.updateItem).not.toHaveBeenCalled();
  expect(m.transaction).not.toHaveBeenCalled();
  expect(m.event).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.resetAllMocks();
  setRole("mesero");
  m.tenant.mockResolvedValue({ adminOnlyTableMove: false });
  m.user.mockResolvedValue({
    restaurantId: "r",
    role: "mesero",
    assignedTableNumbers: [2, 3],
  });
  m.order.mockResolvedValue(order);
  m.table.mockResolvedValue(target);
  m.liveOrder.mockResolvedValue(null);
  m.item.mockResolvedValue(item);
  m.countItem.mockResolvedValue(1);
  m.roundFind.mockResolvedValue(null);
  m.roundCreate.mockResolvedValue({ id: "round" });
  m.transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn({
    $executeRaw: m.advisory,
    restaurant: { findUnique: m.tenant },
    user: { findUnique: m.user },
    table: { findUnique: m.table },
    order: {
      findUnique: m.order,
      findFirst: m.liveOrder,
      create: async () => ({ id: "target-order", status: "placed" }),
      update: m.updateOrder,
    },
    orderItem: { findUnique: m.item, update: m.updateItem, count: m.countItem },
    round: { findFirst: m.roundFind, create: m.roundCreate },
  }));
});

describe.each([
  ["whole order", moveOrder],
  ["single item", moveItem],
] as const)("%s permission enforcement", (_, handler) => {
  it("rejects an old waiter session when the current policy is admin-only", async () => {
    m.tenant.mockResolvedValue({ adminOnlyTableMove: true });
    const response = await handler(request(), params);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "table_move_admin_only" });
    expect(m.tenant).toHaveBeenCalledWith({
      where: { id: "r" },
      select: { adminOnlyTableMove: true },
    });
    expectNoMovement();
  });

  it.each(["operator", "platform_admin", "group_admin"])(
    "allows %s when admin-only is active",
    async (role) => {
      setRole(role);
      m.tenant.mockResolvedValue({ adminOnlyTableMove: true });
      expect((await handler(request(), params)).status).toBe(200);
      expect(m.user).not.toHaveBeenCalled();
    },
  );

  it("allows waiter moves with both assigned tables", async () => {
    expect((await handler(request(), params)).status).toBe(200);
  });

  it("allows an unrestricted waiter while the policy allows waiters", async () => {
    m.user.mockResolvedValue({
      restaurantId: "r",
      role: "mesero",
      assignedTableNumbers: [],
    });
    expect((await handler(request(), params)).status).toBe(200);
  });

  it.each([3, 99])("rejects the source when only table %i is assigned", async (number) => {
    m.user.mockResolvedValue({
      restaurantId: "r",
      role: "mesero",
      assignedTableNumbers: [number],
    });
    const response = await handler(request(), params);
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: "source_out_of_scope" });
    expectNoMovement();
  });

  it("rejects a target outside the assigned section", async () => {
    m.user.mockResolvedValue({
      restaurantId: "r",
      role: "mesero",
      assignedTableNumbers: [2],
    });
    const response = await handler(request(), params);
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: "target_out_of_scope" });
    expectNoMovement();
  });

  it.each([
    null,
    { restaurantId: "foreign", role: "mesero", assignedTableNumbers: [] },
    { restaurantId: "r", role: "kitchen", assignedTableNumbers: [] },
  ])("fails closed when the waiter record is missing or changed: %j", async (user) => {
    m.user.mockResolvedValue(user);
    expect((await handler(request(), params)).status).toBe(403);
    expectNoMovement();
  });

  it("fails closed for a missing tenant", async () => {
    m.tenant.mockResolvedValue(null);
    expect((await handler(request(), params)).status).toBe(403);
    expectNoMovement();
  });

  it("keeps tenant isolation for destination tables", async () => {
    m.table.mockResolvedValue({ ...target, restaurantId: "foreign" });
    expect((await handler(request(), params)).status).toBe(404);
    expectNoMovement();
  });

  it("keeps tenant isolation for source orders and items", async () => {
    const foreignOrder = { ...order, restaurantId: "foreign" };
    m.order.mockResolvedValue(foreignOrder);
    m.item.mockResolvedValue({ ...item, order: foreignOrder });
    const response = await handler(request(), params);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not_found" });
    expect(m.table).not.toHaveBeenCalled();
    expectNoMovement();
  });

  it("requires an authenticated staff session", async () => {
    m.auth.mockResolvedValue(null);
    m.context.mockResolvedValue(null);
    const response = await handler(request(), params);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "forbidden" });
    expect(m.tenant).not.toHaveBeenCalled();
    expectNoMovement();
  });

  it("denies kitchen even when waiters are allowed", async () => {
    setRole("kitchen");
    expect((await handler(request(), params)).status).toBe(403);
    expectNoMovement();
  });
});


describe("whole account transfer rereads after taking the shared movement lock", () => {
  function expectNoWrites() {
    expect(m.updateOrder).not.toHaveBeenCalled();
    expect(m.updateItem).not.toHaveBeenCalled();
    expect(m.event).not.toHaveBeenCalled();
  }
  it("rejects a source moved outside the waiter section while waiting", async () => {
    m.order.mockResolvedValueOnce(order).mockResolvedValue({ ...order, tableId: "other", table: { kind: "standard", number: 4 } });
    const response = await moveOrder(request(), params);
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: "source_out_of_scope" });
    expectNoWrites();
  });
  it("rechecks administrator-only policy after the lock", async () => {
    m.tenant.mockResolvedValueOnce({ adminOnlyTableMove: false }).mockResolvedValue({ adminOnlyTableMove: true });
    const response = await moveOrder(request(), params);
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: "table_move_admin_only" });
    expectNoWrites();
  });
  it("rechecks the current waiter role and table assignments", async () => {
    m.user.mockResolvedValueOnce({ restaurantId: "r", role: "mesero", assignedTableNumbers: [2, 3] }).mockResolvedValue({ restaurantId: "r", role: "kitchen", assignedTableNumbers: [] });
    expect((await moveOrder(request(), params)).status).toBe(403);
    expectNoWrites();
  });
  it("does not transfer a paid account using its old placed snapshot", async () => {
    m.order.mockResolvedValueOnce(order).mockResolvedValue({ ...order, status: "paid" });
    expect((await moveOrder(request(), params)).status).toBe(409);
    expectNoWrites();
  });
  it("rechecks target occupancy before committing the transfer", async () => {
    m.liveOrder.mockResolvedValueOnce(null).mockResolvedValue({ id: "now-occupied" });
    const response = await moveOrder(request(), params);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "target_busy" });
    expectNoWrites();
  });
  it("takes the same restaurant advisory lock as dish transfers and locks the account before rereading", async () => {
    expect((await moveOrder(request(), params)).status).toBe(200);
    expect(m.advisory).toHaveBeenCalledOnce();
    expect(m.advisory.mock.calls[0][1]).toBe("order-item-move:r");
    expect(m.lock).toHaveBeenCalledWith(expect.anything(), "o");
    expect(m.lock.mock.invocationCallOrder[0]).toBeLessThan(m.order.mock.invocationCallOrder[1]);
    expect(m.mutable).toHaveBeenCalledWith(expect.anything(), "o");
    expect(m.updateOrder).toHaveBeenCalledWith({ where: { id: "o" }, data: { tableId: "target" } });
  });
});
