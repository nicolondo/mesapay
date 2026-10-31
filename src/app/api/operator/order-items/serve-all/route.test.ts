import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * «Servir todo» del tablero de cocina / bar.
 *
 * La base es un almacén en memoria chiquito: entiende SÓLO los filtros que
 * usa el endpoint (y revienta con cualquier otro, para que un cambio de
 * consulta no pase en silencio). Las escrituras existen sólo en el cliente
 * de la transacción: si el endpoint escribiera por fuera, el test falla.
 */

type Row = Record<string, unknown> & { id: string };
type ItemRow = Row & {
  orderId: string;
  roundId: string | null;
  station: "kitchen" | "bar";
  servedAt: Date | null;
  cancelledAt: Date | null;
  menuItemId: string | null;
  kitchenStatus: "placed" | "in_kitchen" | "ready";
  preparationStartedAt: Date | null;
  preparationFirstStartedAt: Date | null;
  cancellationKind?: string | null;
  menuItem: { category: { barSubStation: string | null } | null } | null;
};

const m = vi.hoisted(() => ({
  auth: vi.fn(),
  active: vi.fn(),
  lock: vi.fn(),
  event: vi.fn(),
  audit: vi.fn(async () => {}),
  transaction: vi.fn(),
  inTx: false,
  store: {
    orders: [] as Array<{ id: string; restaurantId: string; status: string; servedAt: Date | null; table: { kind: string } }>,
    rounds: [] as Array<{ id: string; orderId: string; status: string; kitchenStartedAt: Date | null; readyAt: Date | null }>,
    items: [] as Array<Record<string, unknown> & { id: string }>,
  },
  writes: [] as Array<{ op: string; inTx: boolean; args: unknown }>,
  dbFindMany: vi.fn(),
}));

vi.mock("@/auth", () => ({ auth: m.auth }));
vi.mock("@/lib/activeRestaurant", () => ({ getActiveRestaurantId: m.active }));
vi.mock("@/lib/secureApi", () => ({ secureApi: (handler: unknown) => handler }));
vi.mock("@/lib/orderLock", () => ({ lockOrder: m.lock }));
vi.mock("@/lib/events", () => ({ publishOrderEvent: m.event }));
vi.mock("@/lib/auditLog", () => ({ recordAuditEvent: m.audit }));

// ── Almacén en memoria ───────────────────────────────────────────────────

function orderOf(orderId: string) {
  return m.store.orders.find((o) => o.id === orderId)!;
}
function roundOf(roundId: string | null) {
  return roundId ? m.store.rounds.find((r) => r.id === roundId) ?? null : null;
}
/** La fila con sus relaciones, como la devolvería el `select` del endpoint. */
function hydrate(item: Row) {
  const i = item as ItemRow;
  const order = orderOf(i.orderId);
  const round = roundOf(i.roundId);
  return {
    ...i,
    order: { restaurantId: order.restaurantId, table: { kind: order.table.kind } },
    round: round ? { status: round.status } : null,
  };
}

function matchItem(item: ItemRow, where: Record<string, unknown>): boolean {
  for (const [key, value] of Object.entries(where)) {
    if (key === "id" || key === "orderId") {
      const v = value as { in: string[] };
      if (!v || !Array.isArray(v.in)) throw new Error(`filtro no soportado: ${key}`);
      if (!v.in.includes(item[key])) return false;
    } else if (key === "order") {
      const v = value as Record<string, unknown>;
      if (Object.keys(v).join() !== "restaurantId") throw new Error("filtro de order no soportado");
      if (orderOf(item.orderId).restaurantId !== v.restaurantId) return false;
    } else if (key === "roundId") {
      if (item.roundId !== value) return false;
    } else if (key === "cancelledAt" || key === "servedAt") {
      if (value !== null) throw new Error(`filtro no soportado: ${key}`);
      if (item[key] !== null) return false;
    } else {
      throw new Error(`filtro no soportado: ${key}`);
    }
  }
  return true;
}

function findItems({ where }: { where: Record<string, unknown> }) {
  return (m.store.items as ItemRow[]).filter((i) => matchItem(i, where)).map(hydrate);
}

function write(op: string, args: unknown) {
  m.writes.push({ op, inTx: m.inTx, args });
}

const tx = {
  orderItem: {
    findMany: vi.fn(async (args: { where: Record<string, unknown> }) => findItems(args)),
    updateMany: vi.fn(async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      write("orderItem.updateMany", args);
      const hits = (m.store.items as ItemRow[]).filter((i) => matchItem(i, args.where));
      for (const i of hits) Object.assign(i, args.data);
      return { count: hits.length };
    }),
  },
  round: {
    findUnique: vi.fn(async ({ where }: { where: { id: string } }) => roundOf(where.id)),
    findMany: vi.fn(async ({ where }: { where: { orderId: string } }) =>
      m.store.rounds.filter((r) => r.orderId === where.orderId),
    ),
    update: vi.fn(async (args: { where: { id: string }; data: Record<string, unknown> }) => {
      write("round.update", args);
      const r = roundOf(args.where.id)!;
      Object.assign(r, args.data);
      return r;
    }),
  },
  order: {
    updateMany: vi.fn(async (args: { where: { id: string; status: { notIn: string[] } }; data: Record<string, unknown> }) => {
      write("order.updateMany", args);
      const o = orderOf(args.where.id);
      if (args.where.status.notIn.includes(o.status)) return { count: 0 };
      Object.assign(o, args.data);
      return { count: 1 };
    }),
  },
};

vi.mock("@/lib/db", () => ({
  db: {
    // Fuera de la transacción sólo se puede LEER (no hay métodos de escritura).
    orderItem: { findMany: m.dbFindMany },
    $transaction: m.transaction,
  },
}));

import { POST } from "./route";

// ── Escenario ────────────────────────────────────────────────────────────

const EARLIER = new Date("2026-10-31T19:00:00Z");

function item(id: string, over: Partial<ItemRow> = {}): ItemRow {
  return {
    id,
    orderId: "o-1",
    roundId: "rd-1",
    station: "kitchen",
    servedAt: null,
    cancelledAt: null,
    menuItemId: `menu-${id}`,
    kitchenStatus: "in_kitchen",
    preparationStartedAt: EARLIER,
    preparationFirstStartedAt: EARLIER,
    menuItem: { category: { barSubStation: null } },
    ...over,
  };
}

function seed() {
  m.store.orders = [
    { id: "o-1", restaurantId: "r-1", status: "in_kitchen", servedAt: null, table: { kind: "standard" } },
    { id: "o-2", restaurantId: "r-1", status: "ready", servedAt: null, table: { kind: "standard" } },
    // Mostrador prepago: ya está pagado antes de que la cocina arranque.
    { id: "o-paid", restaurantId: "r-1", status: "paid", servedAt: null, table: { kind: "standard" } },
    // Otro comercio.
    { id: "o-x", restaurantId: "r-2", status: "placed", servedAt: null, table: { kind: "standard" } },
  ];
  m.store.rounds = [
    { id: "rd-1", orderId: "o-1", status: "in_kitchen", kitchenStartedAt: EARLIER, readyAt: null },
    { id: "rd-2", orderId: "o-2", status: "ready", kitchenStartedAt: EARLIER, readyAt: EARLIER },
    { id: "rd-paid", orderId: "o-paid", status: "in_kitchen", kitchenStartedAt: EARLIER, readyAt: null },
    { id: "rd-x", orderId: "o-x", status: "placed", kitchenStartedAt: null, readyAt: null },
  ];
  m.store.items = [
    item("k-1"),
    // Nunca empezado: servirlo deja sellada la historia de preparación.
    item("k-2", { kitchenStatus: "placed", preparationStartedAt: null, preparationFirstStartedAt: null }),
    item("k-served", { servedAt: EARLIER, kitchenStatus: "ready" }),
    // Cortesía ("no cobrar"): queda cancelada y no se toca.
    item("k-comp", { cancelledAt: EARLIER, cancellationKind: "comp" }),
    item("k-cancelled", { cancelledAt: EARLIER, cancellationKind: "cancel" }),
    // Mismo pedido y ronda, pero del bar.
    item("b-1", { station: "bar", menuItem: { category: { barSubStation: "Cocteles" } } }),
    item("k-3", { orderId: "o-2", roundId: "rd-2", kitchenStatus: "ready" }),
    item("k-paid", { orderId: "o-paid", roundId: "rd-paid" }),
    item("x-1", { orderId: "o-x", roundId: "rd-x" }),
  ];
}

const post = (body: unknown) =>
  POST(
    new Request("http://localhost/api/operator/order-items/serve-all", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

function setRole(role: string) {
  m.auth.mockResolvedValue({ user: { id: `user-${role}`, email: `${role}@test.co`, role } });
}

const servedIds = () =>
  (m.store.items as ItemRow[]).filter((i) => i.servedAt && i.servedAt !== EARLIER).map((i) => i.id).sort();

beforeEach(() => {
  vi.clearAllMocks();
  seed();
  m.writes = [];
  m.inTx = false;
  setRole("operator");
  m.active.mockResolvedValue("r-1");
  m.lock.mockResolvedValue(undefined);
  m.dbFindMany.mockImplementation(async (args: { where: Record<string, unknown> }) => findItems(args));
  m.transaction.mockImplementation(async (fn: (client: typeof tx) => Promise<unknown>) => {
    m.inTx = true;
    try {
      return await fn(tx);
    } finally {
      m.inTx = false;
    }
  });
});

const ALL_REQUESTED = ["k-1", "k-2", "k-served", "k-comp", "k-cancelled", "b-1", "k-3", "x-1", "no-existe"];

describe("POST /api/operator/order-items/serve-all — qué sirve", () => {
  it("sirve sólo los ids válidos de la estación y del comercio; ignora servidos, cancelados, cortesías, otra estación y otro comercio", async () => {
    const res = await post({ station: "kitchen", itemIds: ALL_REQUESTED });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, served: 3, skipped: ALL_REQUESTED.length - 3 });
    expect(servedIds()).toEqual(["k-1", "k-2", "k-3"]);

    const byId = Object.fromEntries((m.store.items as ItemRow[]).map((i) => [i.id, i]));
    // Mismo efecto que el PATCH individual: servido y "listo".
    expect(byId["k-1"]).toMatchObject({ kitchenStatus: "ready" });
    expect(byId["k-3"]).toMatchObject({ kitchenStatus: "ready" });
    // El plato que nunca empezó queda con su historia de preparación sellada
    // (desde ahí sólo el administrador puede cancelarlo / no cobrarlo).
    expect(byId["k-2"].preparationFirstStartedAt).toBeInstanceOf(Date);
    expect(byId["k-2"].preparationFirstStartedAt).toEqual(byId["k-2"].servedAt);
    // El que ya tenía historia no se re-sella.
    expect(byId["k-1"].preparationFirstStartedAt).toBe(EARLIER);
    // Nada de lo ignorado cambió.
    expect(byId["k-served"].servedAt).toBe(EARLIER);
    expect(byId["k-comp"].servedAt).toBeNull();
    expect(byId["k-cancelled"].servedAt).toBeNull();
    expect(byId["b-1"].servedAt).toBeNull();
    expect(byId["x-1"].servedAt).toBeNull();
    // Nunca se bloqueó (ni se escribió) un pedido de otro comercio.
    expect(m.lock.mock.calls.map((c) => c[1])).toEqual(["o-1", "o-2"]);
  });

  it("no sirve lo que no venía en la lista, aunque esté pendiente en el mismo pedido (entró después de abrir la confirmación)", async () => {
    m.store.items.push(item("k-late", { orderId: "o-2", roundId: "rd-2" }));
    const res = await post({ station: "kitchen", itemIds: ["k-3"] });
    expect(await res.json()).toMatchObject({ served: 1 });
    expect(servedIds()).toEqual(["k-3"]);
    // Como queda algo vivo sin servir, ni la ronda ni el pedido pasan a "served".
    expect(m.store.rounds.find((r) => r.id === "rd-2")!.status).not.toBe("served");
    expect(m.store.orders.find((o) => o.id === "o-2")!.status).toBe("ready");
  });

  it("ignora lo que alguien más sirvió o canceló entre abrir la confirmación y bloquear el pedido", async () => {
    m.lock.mockImplementation(async (_tx: unknown, orderId: string) => {
      if (orderId !== "o-1") return;
      const k1 = (m.store.items as ItemRow[]).find((i) => i.id === "k-1")!;
      k1.servedAt = EARLIER; // lo sirvió un mesero
      const k2 = (m.store.items as ItemRow[]).find((i) => i.id === "k-2")!;
      k2.cancelledAt = EARLIER; // lo canceló el administrador
    });
    const res = await post({ station: "kitchen", itemIds: ["k-1", "k-2", "k-3"] });
    expect(await res.json()).toEqual({ ok: true, served: 1, skipped: 2 });
    expect(servedIds()).toEqual(["k-3"]);
  });

  it("en el bar con sub-estación sirve sólo lo de ESA sub-estación (según la categoría actual del plato)", async () => {
    m.store.items.push(
      item("b-cafe", { station: "bar", menuItem: { category: { barSubStation: "Cafetería" } } }),
      item("b-libre", { station: "bar", menuItemId: null, menuItem: null }),
    );
    const res = await post({
      station: "bar",
      barSubStation: "Cocteles",
      itemIds: ["b-1", "b-cafe", "b-libre", "k-1"],
    });
    expect(await res.json()).toEqual({ ok: true, served: 1, skipped: 3 });
    expect(servedIds()).toEqual(["b-1"]);
  });

  it("el bar sin sub-estación activa sirve todo el bar (y nada de la cocina)", async () => {
    m.store.items.push(item("b-cafe", { station: "bar", menuItem: { category: { barSubStation: "Cafetería" } } }));
    const res = await post({ station: "bar", barSubStation: null, itemIds: ["b-1", "b-cafe", "k-1"] });
    expect(await res.json()).toMatchObject({ served: 2 });
    expect(servedIds()).toEqual(["b-1", "b-cafe"]);
  });

  it("en cocina una sub-estación no aplica (no filtra ni deja afuera nada)", async () => {
    const res = await post({ station: "kitchen", barSubStation: "Cocteles", itemIds: ["k-1", "k-3"] });
    expect(await res.json()).toMatchObject({ served: 2 });
  });

  it("si nada es válido no abre transacción, no publica ni audita", async () => {
    const res = await post({ station: "kitchen", itemIds: ["k-served", "b-1", "x-1"] });
    expect(await res.json()).toEqual({ ok: true, served: 0, skipped: 3 });
    expect(m.transaction).not.toHaveBeenCalled();
    expect(m.event).not.toHaveBeenCalled();
    expect(m.audit).not.toHaveBeenCalled();
  });

  it("rechaza un cuerpo inválido sin tocar nada", async () => {
    for (const body of [
      { station: "salon", itemIds: ["k-1"] },
      { station: "kitchen", itemIds: [] },
      { station: "kitchen" },
      { station: "kitchen", itemIds: Array.from({ length: 1001 }, (_, i) => `id-${i}`) },
    ]) {
      const res = await post(body);
      expect(res.status).toBe(400);
    }
    expect(m.dbFindMany).not.toHaveBeenCalled();
    expect(m.transaction).not.toHaveBeenCalled();
  });
});

describe("POST /api/operator/order-items/serve-all — roll-up de rondas y pedidos", () => {
  it("la ronda y el pedido pasan a 'served' cuando ya no queda nada vivo sin servir", async () => {
    await post({ station: "kitchen", itemIds: ["k-3"] });
    expect(m.store.rounds.find((r) => r.id === "rd-2")!.status).toBe("served");
    expect(m.store.orders.find((o) => o.id === "o-2")).toMatchObject({ status: "served" });
    expect(m.store.orders.find((o) => o.id === "o-2")!.servedAt).toBeInstanceOf(Date);
  });

  it("una ronda con algo de otra estación pendiente no pasa a 'served'", async () => {
    await post({ station: "kitchen", itemIds: ["k-1", "k-2"] });
    // b-1 (bar) sigue sin servir en rd-1.
    expect(m.store.rounds.find((r) => r.id === "rd-1")!.status).not.toBe("served");
    expect(m.store.orders.find((o) => o.id === "o-1")!.status).toBe("in_kitchen");
  });

  it("nunca pisa un pedido ya pagado (mostrador prepago)", async () => {
    await post({ station: "kitchen", itemIds: ["k-paid"] });
    expect(m.store.rounds.find((r) => r.id === "rd-paid")!.status).toBe("served");
    expect(m.store.orders.find((o) => o.id === "o-paid")!.status).toBe("paid");
  });
});

describe("POST /api/operator/order-items/serve-all — transacción, evento y auditoría", () => {
  it("corre en UNA transacción: bloquea los pedidos (en orden fijo) y todas las escrituras van adentro", async () => {
    await post({ station: "kitchen", itemIds: ["k-3", "k-1", "k-2"] });
    expect(m.transaction).toHaveBeenCalledTimes(1);
    expect(m.lock).toHaveBeenCalledTimes(2);
    for (const call of m.lock.mock.calls) expect(call[0]).toBe(tx);
    expect(m.lock.mock.calls.map((c) => c[1])).toEqual(["o-1", "o-2"]);
    expect(m.writes.length).toBeGreaterThan(0);
    expect(m.writes.every((w) => w.inTx)).toBe(true);
  });

  it("si una escritura falla, el error sale de la transacción (rollback) y no se publica ni audita nada", async () => {
    tx.round.update.mockRejectedValueOnce(new Error("db_down"));
    await expect(post({ station: "kitchen", itemIds: ["k-3"] })).rejects.toThrow("db_down");
    expect(m.event).not.toHaveBeenCalled();
    expect(m.audit).not.toHaveBeenCalled();
  });

  it("publica UN solo evento para todo el lote, no uno por ítem", async () => {
    await post({ station: "kitchen", itemIds: ["k-1", "k-2", "k-3"] });
    expect(m.event).toHaveBeenCalledTimes(1);
    expect(m.event).toHaveBeenCalledWith("r-1", { type: "order.updated", orderId: expect.any(String) });
  });

  it("deja auditoría con quién, cuántos ítems y en qué estación", async () => {
    await post({ station: "kitchen", itemIds: ["k-1", "k-2", "k-3", "k-served"] });
    expect(m.audit).toHaveBeenCalledTimes(1);
    expect(m.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "order_item.serve_all",
        restaurantId: "r-1",
        actor: { userId: "user-operator", email: "operator@test.co", role: "operator" },
        target: { type: "station", id: "kitchen" },
        summary: "Sirvió todo en cocina: 3 platos de 2 pedidos",
        diff: {
          after: expect.objectContaining({
            station: "kitchen",
            barSubStation: null,
            itemCount: 3,
            orderCount: 2,
            skipped: 1,
            itemIds: expect.arrayContaining(["k-1", "k-2", "k-3"]),
          }),
        },
      }),
    );
  });

  it("la auditoría del bar dice la sub-estación", async () => {
    await post({ station: "bar", barSubStation: "Cocteles", itemIds: ["b-1"] });
    expect(m.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        target: { type: "station", id: "bar:Cocteles" },
        summary: "Sirvió todo en bar · Cocteles: 1 plato de 1 pedido",
        diff: { after: expect.objectContaining({ station: "bar", barSubStation: "Cocteles", itemCount: 1 }) },
      }),
    );
  });
});

describe("POST /api/operator/order-items/serve-all — permisos", () => {
  it.each(["operator", "group_admin", "platform_admin"])("%s (administración, también impersonando) puede", async (role) => {
    setRole(role);
    const res = await post({ station: "kitchen", itemIds: ["k-1"] });
    expect(res.status).toBe(200);
    expect(servedIds()).toEqual(["k-1"]);
  });

  it.each(["kitchen", "bar", "mesero", "terminal", "comercial", "customer"])(
    "%s recibe 403 y la base queda sin cambios",
    async (role) => {
      setRole(role);
      const before = JSON.stringify(m.store);
      const res = await post({ station: role === "bar" ? "bar" : "kitchen", itemIds: ["k-1", "k-2", "b-1"] });
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: "forbidden" });
      expect(JSON.stringify(m.store)).toBe(before);
      expect(m.dbFindMany).not.toHaveBeenCalled();
      expect(m.transaction).not.toHaveBeenCalled();
      expect(m.event).not.toHaveBeenCalled();
      expect(m.audit).not.toHaveBeenCalled();
    },
  );

  it("sin sesión responde 401 y no toca nada", async () => {
    m.auth.mockResolvedValue(null);
    const res = await post({ station: "kitchen", itemIds: ["k-1"] });
    expect(res.status).toBe(401);
    expect(m.dbFindMany).not.toHaveBeenCalled();
  });

  it("sin comercio activo responde 401 y no toca nada", async () => {
    m.active.mockResolvedValue(null);
    const res = await post({ station: "kitchen", itemIds: ["k-1"] });
    expect(res.status).toBe(401);
    expect(m.dbFindMany).not.toHaveBeenCalled();
  });
});
