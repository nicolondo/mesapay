import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Una FACTURA MANUAL (mesa `kind = manual`) es un documento, no un pedido a
 * preparar. Al mandarle una ronda desde la carta, sus platos tienen que
 * nacer como una línea libre — servidos, en "counter" — y no puede haber
 * marchado automático ni comanda, aunque la estación tenga auto-fire. Una
 * mesa física con la misma configuración sigue el camino de siempre.
 */
const h = vi.hoisted(() => {
  const created = { items: [] as Record<string, unknown>[], rounds: [] as Record<string, unknown>[] };
  const tx = {
    order: {
      findUnique: vi.fn(),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        id: "order-1",
        status: "open",
        placedAt: null,
        servedAt: null,
        shortCode: "AAAAAA-BBBBBB",
        ...data,
      })),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        id: "order-1",
        shortCode: "AAAAAA-BBBBBB",
        ...data,
      })),
    },
    round: {
      aggregate: vi.fn(async () => ({ _max: { seq: null } })),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const round = { id: "round-1", ...data };
        created.rounds.push(round);
        return round;
      }),
      update: vi.fn(async () => ({})),
    },
    orderItem: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const item = { id: `item-${created.items.length + 1}`, ...data };
        created.items.push(item);
        return item;
      }),
      findMany: vi.fn(async () => created.items),
    },
  };
  return {
    created,
    tx,
    tenant: {
      id: "rest-1",
      slug: "chefburger",
      serviceMode: "table",
      hasBar: true,
      barSubStations: [] as string[],
      kitchenAutoFire: true,
      barAutoFire: true,
    },
    table: vi.fn(),
    autoFire: vi.fn(async () => [{ station: "kitchen", barSubStation: null }]),
    tickets: vi.fn(async () => {}),
    recompute: vi.fn(async (_tx: unknown, id: string) => ({ id, shortCode: "AAAAAA-BBBBBB" })),
  };
});

vi.mock("@/lib/secureApi", () => ({ secureApi: (handler: unknown) => handler }));
vi.mock("@/lib/db", () => ({
  db: {
    restaurant: { findUnique: vi.fn(async () => h.tenant) },
    table: { findUnique: h.table },
    menuItem: {
      findMany: vi.fn(async () => [
        {
          id: "item-lomo",
          restaurantId: "rest-1",
          name: "Lomo",
          priceCents: 3200000,
          prepStation: null,
          prepMinutes: 15,
          modifiers: null,
          available: true,
          category: { kind: "food", prepStation: "kitchen", barSubStation: null },
        },
      ]),
    },
    $transaction: vi.fn(async (fn: (t: typeof h.tx) => Promise<unknown>) => fn(h.tx)),
  },
}));
vi.mock("@/lib/dinerSession", () => ({ getDiner: vi.fn(async () => null) }));
vi.mock("@/lib/dinerDiscount", () => ({ getActiveDiscountPct: vi.fn(async () => null) }));
vi.mock("@/lib/events", () => ({ publishOrderEvent: vi.fn() }));
vi.mock("@/lib/orderLock", () => ({ lockOrder: vi.fn(async () => {}) }));
vi.mock("@/lib/orders", () => ({ recomputeOrderLinesInTx: h.recompute }));
vi.mock("@/lib/kds/autoFire", () => ({ autoFireRoundInTx: h.autoFire }));
vi.mock("@/lib/kds/autoFireTickets", () => ({ notifyAutoFiredTickets: h.tickets }));
vi.mock("next-intl/server", () => ({ getLocale: vi.fn(async () => "es") }));

import { POST } from "./route";

const send = () =>
  POST(
    new Request("http://localhost/api/tenant/chefburger/orders", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        tableId: "table-x",
        items: [{ menuItemId: "item-lomo", qty: 2 }],
      }),
    }),
    { params: Promise.resolve({ slug: "chefburger" }) },
  );

beforeEach(() => {
  vi.clearAllMocks();
  h.created.items.length = 0;
  h.created.rounds.length = 0;
});

describe("POST /api/tenant/[slug]/orders — factura manual", () => {
  it("los platos nacen servidos en counter, la ronda ya entregada, sin marchado ni comanda", async () => {
    h.table.mockResolvedValue({
      id: "table-x",
      restaurantId: "rest-1",
      number: -100,
      kind: "manual",
    });

    const res = await send();
    expect(res.status).toBe(200);

    // El plato: como una línea libre — nadie lo prepara ni lo entrega.
    expect(h.created.items).toHaveLength(1);
    expect(h.created.items[0]).toMatchObject({
      menuItemId: "item-lomo",
      qty: 2,
      station: "counter",
      barSubStation: null,
      kitchenStatus: "ready",
    });
    expect(h.created.items[0].servedAt).toBeInstanceOf(Date);

    // La ronda nace entregada: el Salón busca "listo sin entregar" y el
    // tablero de cocina rondas placed/in_kitchen/ready.
    expect(h.created.rounds[0]).toMatchObject({ status: "served" });
    expect(h.created.rounds[0].readyAt).toBeInstanceOf(Date);
    expect(h.tx.round.update).not.toHaveBeenCalled();

    // La cuenta queda "served" con su sello.
    expect(h.tx.order.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "served", servedAt: expect.any(Date) }),
      }),
    );

    // Con auto-fire activo en cocina y barra igual NO se marcha nada ni
    // sale comanda: ticket.printable / PrintJob nunca se disparan.
    expect(h.autoFire).not.toHaveBeenCalled();
    expect(h.tickets).toHaveBeenCalledWith(
      expect.objectContaining({ rounds: [{ roundId: "round-1", groups: [] }] }),
    );
  });

  it("una mesa física con la misma configuración sigue yendo a cocina", async () => {
    h.table.mockResolvedValue({
      id: "table-x",
      restaurantId: "rest-1",
      number: 4,
      kind: "standard",
    });

    const res = await send();
    expect(res.status).toBe(200);

    expect(h.created.items[0]).toMatchObject({
      station: "kitchen",
      kitchenStatus: "placed",
    });
    expect(h.created.items[0].servedAt).toBeUndefined();
    expect(h.created.rounds[0]).toMatchObject({ status: "placed" });
    expect(h.created.rounds[0].readyAt).toBeUndefined();
    expect(h.tx.order.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "placed" }) }),
    );
    expect(h.autoFire).toHaveBeenCalledTimes(1);
    expect(h.tickets).toHaveBeenCalledWith(
      expect.objectContaining({
        rounds: [{ roundId: "round-1", groups: [{ station: "kitchen", barSubStation: null }] }],
      }),
    );
  });
});
