import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Prisma } from "@prisma/client";

/**
 * Marchado automático contra un doble de la DB en memoria. Lo que importa:
 *   - sin auto-fire en ninguna estación no lee ni escribe nada;
 *   - una estación con auto-fire marcha SÓLO sus ítems "placed";
 *   - el recálculo de la ronda es el mismo que hace el PATCH del tablero:
 *     se corre el helper sobre una ronda y la ruta REAL sobre una gemela y
 *     las dos terminan igual (estado, cronómetros, sellos de la ronda y las
 *     mismas comandas).
 */

const h = vi.hoisted(() => {
  type Station = "kitchen" | "bar" | "counter";
  type Status = "placed" | "in_kitchen" | "ready";
  type Item = {
    id: string;
    orderId: string;
    roundId: string;
    menuItemId: string;
    nameSnapshot: string;
    qty: number;
    station: Station;
    barSubStation: string | null;
    kitchenStatus: Status;
    preparationStartedAt: Date | null;
    servedAt: Date | null;
    cancelledAt: Date | null;
    expediteRequestedAt: Date | null;
  };
  type Round = {
    id: string;
    orderId: string;
    seq: number;
    status: string;
    kitchenStartedAt: Date | null;
    readyAt: Date | null;
    placedAt: Date;
  };
  const state = { items: [] as Item[], rounds: [] as Round[] };
  const order = () => ({
    id: "order",
    restaurantId: "merchant",
    status: "placed",
    tableId: null,
    locale: "es",
  });
  const matches = (item: Item, where: Record<string, unknown>) =>
    Object.entries(where).every(([key, value]) => {
      const actual = (item as unknown as Record<string, unknown>)[key];
      if (value !== null && typeof value === "object" && "in" in value) {
        return (value as { in: unknown[] }).in.includes(actual);
      }
      return actual === value;
    });
  const byId = (id: string) => state.items.find((i) => i.id === id)!;
  const tx = {
    orderItem: {
      findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
        state.items.filter((i) => matches(i, where)),
      ),
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => ({
        ...byId(where.id),
        order: order(),
      })),
      findUniqueOrThrow: vi.fn(async ({ where }: { where: { id: string } }) => ({
        ...byId(where.id),
        order: order(),
      })),
      update: vi.fn(
        async ({ where, data }: { where: { id: string }; data: Partial<Item> }) =>
          Object.assign(byId(where.id), data),
      ),
      count: vi.fn(async () => 0),
    },
    round: {
      findUnique: vi.fn(
        async ({ where }: { where: { id: string } }) =>
          state.rounds.find((r) => r.id === where.id) ?? null,
      ),
      update: vi.fn(
        async ({ where, data }: { where: { id: string }; data: Partial<Round> }) =>
          Object.assign(state.rounds.find((r) => r.id === where.id)!, data),
      ),
    },
    restaurant: {
      findUnique: vi.fn(async () => ({
        kitchenPrintEnabled: true,
        barPrintEnabled: true,
        country: "CO",
      })),
    },
  };
  type Ticket = {
    restaurantId: string;
    orderId: string;
    roundId: string;
    station: string;
    barSubStation: string | null;
    locale?: string;
  };
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const notify = vi.fn(async (_ticket: Ticket) => {});
  return { state, tx, notify, event: vi.fn() };
});

vi.mock("@/lib/db", () => ({
  db: {
    ...h.tx,
    $transaction: async (fn: (tx: typeof h.tx) => unknown) => fn(h.tx),
  },
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/print/enqueue", () => ({ notifyAcceptedRoundTicketSafe: h.notify }));
vi.mock("@/lib/events", () => ({ publishOrderEvent: h.event }));
vi.mock("@/lib/secureApi", () => ({ secureApi: (fn: unknown) => fn }));
vi.mock("@/auth", () => ({
  auth: async () => ({ user: { role: "bar", email: "bar@example.test" } }),
}));
vi.mock("@/lib/activeRestaurant", () => ({
  getActiveRestaurantId: async () => "merchant",
}));
vi.mock("@/lib/orderLock", () => ({ lockOrder: vi.fn() }));
vi.mock("@/lib/orders", () => ({
  requireMutableOrderInTx: vi.fn(),
  recomputeOrderLinesInTx: vi.fn(),
}));
vi.mock("@/lib/auditLog", () => ({ recordAuditEvent: vi.fn() }));
vi.mock("@/lib/push", () => ({ sendPushToMeserosForTable: vi.fn() }));

import { autoFireRoundInTx } from "./autoFire";
import { notifyAutoFiredTickets } from "./autoFireTickets";
import { PATCH } from "@/app/api/operator/order-items/[id]/route";

const tx = h.tx as unknown as Prisma.TransactionClient;
const NOW = new Date("2026-09-14T20:00:00Z");
const YESTERDAY = new Date("2026-09-13T20:00:00Z");
const NONE = { kitchenAutoFire: false, barAutoFire: false };
const BAR = { kitchenAutoFire: false, barAutoFire: true };
const BOTH = { kitchenAutoFire: true, barAutoFire: true };

type Spec = {
  id: string;
  station: "kitchen" | "bar" | "counter";
  barSubStation?: string | null;
  kitchenStatus?: "placed" | "in_kitchen" | "ready";
  preparationStartedAt?: Date | null;
  cancelledAt?: Date | null;
};

/** Una ronda con sus ítems. Los ids quedan prefijados con la ronda. */
function seed(roundId: string, specs: Spec[]) {
  h.state.rounds.push({
    id: roundId,
    orderId: "order",
    seq: 1,
    status: "placed",
    kitchenStartedAt: null,
    readyAt: null,
    placedAt: NOW,
  });
  for (const s of specs) {
    h.state.items.push({
      id: `${roundId}:${s.id}`,
      orderId: "order",
      roundId,
      menuItemId: "menu",
      nameSnapshot: s.id,
      qty: 1,
      station: s.station,
      barSubStation: s.barSubStation ?? null,
      kitchenStatus: s.kitchenStatus ?? (s.station === "counter" ? "ready" : "placed"),
      preparationStartedAt: s.preparationStartedAt ?? null,
      servedAt: null,
      cancelledAt: s.cancelledAt ?? null,
      expediteRequestedAt: null,
    });
  }
}
const item = (id: string) => h.state.items.find((i) => i.id === id)!;
const round = (id: string) => h.state.rounds.find((r) => r.id === id)!;
/** Una ronda de bar típica: dos sub-estaciones, un plato de cocina, un refri. */
const MIXED: Spec[] = [
  { id: "mojito", station: "bar", barSubStation: "cocteles" },
  { id: "club", station: "bar", barSubStation: "cervezas" },
  { id: "patacones", station: "kitchen" },
  { id: "agua", station: "counter" },
];
const patch = (id: string, body: object) =>
  PATCH(
    new Request("https://fixture.test", { method: "PATCH", body: JSON.stringify(body) }),
    { params: Promise.resolve({ id }) },
  );

beforeEach(() => {
  vi.clearAllMocks();
  h.state.items = [];
  h.state.rounds = [];
});

describe("autoFireRoundInTx", () => {
  it("sin auto-fire en ninguna estación no lee ni escribe nada", async () => {
    seed("A", MIXED);
    expect(await autoFireRoundInTx(tx, { roundId: "A", flags: NONE, now: NOW })).toEqual([]);
    expect(h.tx.orderItem.findMany).not.toHaveBeenCalled();
    expect(h.tx.orderItem.update).not.toHaveBeenCalled();
    expect(h.tx.round.update).not.toHaveBeenCalled();
    expect(item("A:mojito").kitchenStatus).toBe("placed");
  });

  it("con auto-fire en el bar marcha sólo los ítems del bar", async () => {
    seed("A", MIXED);
    const groups = await autoFireRoundInTx(tx, { roundId: "A", flags: BAR, now: NOW });

    expect(groups).toEqual([
      { station: "bar", barSubStation: "cocteles" },
      { station: "bar", barSubStation: "cervezas" },
    ]);
    expect(item("A:mojito")).toMatchObject({ kitchenStatus: "in_kitchen", preparationStartedAt: NOW });
    expect(item("A:club")).toMatchObject({ kitchenStatus: "in_kitchen", preparationStartedAt: NOW });
    // Cocina sigue esperando a que alguien toque el tablero; el refri ya nació listo.
    expect(item("A:patacones")).toMatchObject({ kitchenStatus: "placed", preparationStartedAt: null });
    expect(item("A:agua")).toMatchObject({ kitchenStatus: "ready", preparationStartedAt: null });
    // Con un plato de cocina todavía "placed", la ronda no entra a preparación.
    expect(round("A")).toMatchObject({ status: "placed", kitchenStartedAt: null });
  });

  it("cuando todo lo pendiente se marcha, la ronda entra a preparación con su sello", async () => {
    seed("A", [
      { id: "mojito", station: "bar" },
      { id: "agua", station: "counter" },
    ]);
    expect(await autoFireRoundInTx(tx, { roundId: "A", flags: BAR, now: NOW })).toEqual([
      { station: "bar", barSubStation: null },
    ]);
    expect(round("A")).toMatchObject({ status: "in_kitchen", kitchenStartedAt: NOW, readyAt: null });
  });

  it("no re-marcha lo que ya estaba en preparación, ni lo cancelado, ni lo listo", async () => {
    seed("A", [
      { id: "mojito", station: "bar", kitchenStatus: "in_kitchen", preparationStartedAt: YESTERDAY },
      { id: "club", station: "bar", cancelledAt: YESTERDAY },
      { id: "agua", station: "counter" },
    ]);
    expect(await autoFireRoundInTx(tx, { roundId: "A", flags: BOTH, now: NOW })).toEqual([]);
    expect(h.tx.orderItem.update).not.toHaveBeenCalled();
    expect(item("A:mojito").preparationStartedAt).toBe(YESTERDAY);
    expect(item("A:club").kitchenStatus).toBe("placed");
  });

  it("deja la ronda y los ítems exactamente como los deja el PATCH del tablero", async () => {
    seed("A", MIXED);
    seed("B", MIXED);

    const groups = await autoFireRoundInTx(tx, { roundId: "A", flags: BOTH, now: NOW });
    await notifyAutoFiredTickets({
      restaurantId: "merchant",
      orderId: "order",
      rounds: [{ roundId: "A", groups }],
    });
    const autoTickets = h.notify.mock.calls.map((c) => c[0]);
    h.notify.mockClear();

    for (const id of ["mojito", "club", "patacones"]) {
      expect((await patch(`B:${id}`, { kitchenStatus: "in_kitchen" })).status).toBe(200);
    }
    const boardTickets = h.notify.mock.calls.map((c) => c[0]);

    for (const id of ["mojito", "club", "patacones", "agua"]) {
      const a = item(`A:${id}`);
      const b = item(`B:${id}`);
      expect(a.kitchenStatus).toBe(b.kitchenStatus);
      expect(a.preparationStartedAt === null).toBe(b.preparationStartedAt === null);
    }
    expect(round("A").status).toBe(round("B").status);
    expect(round("A").status).toBe("in_kitchen");
    expect(round("A").kitchenStartedAt).toEqual(NOW);
    expect(round("B").kitchenStartedAt).toBeInstanceOf(Date);
    expect(round("A").readyAt).toBeNull();
    expect(round("B").readyAt).toBeNull();

    // Mismas comandas: una por (estación, sub-estación). El tablero avisa
    // en cada plato aceptado (el helper de impresión dedupea); el marchado
    // automático avisa una vez por grupo — el conjunto es el mismo.
    const key = (t: { station: string; barSubStation: string | null }) =>
      `${t.station}:${t.barSubStation ?? ""}`;
    expect(new Set(autoTickets.map(key))).toEqual(new Set(boardTickets.map(key)));
    expect(autoTickets.every((t) => t.roundId === "A" && t.orderId === "order")).toBe(true);
    expect(boardTickets.every((t) => t.roundId === "B" && t.orderId === "order")).toBe(true);
  });

  it("el tablero sigue mandando: un plato marchado solo se marca listo como cualquier otro", async () => {
    seed("A", [{ id: "mojito", station: "bar" }, { id: "club", station: "bar" }]);
    await autoFireRoundInTx(tx, { roundId: "A", flags: BAR, now: NOW });

    expect((await patch("A:mojito", { kitchenStatus: "ready" })).status).toBe(200);
    expect(round("A")).toMatchObject({ status: "in_kitchen", kitchenStartedAt: NOW, readyAt: null });
    expect((await patch("A:club", { kitchenStatus: "ready" })).status).toBe(200);
    expect(round("A").status).toBe("ready");
    expect(round("A").kitchenStartedAt).toEqual(NOW);
    expect(round("A").readyAt).toBeInstanceOf(Date);
    // Ya estaban marchados: el tablero no vuelve a disparar la comanda.
    expect(h.notify).not.toHaveBeenCalled();
  });
});

describe("notifyAutoFiredTickets", () => {
  it("sin grupos marchados no toca la base", async () => {
    await notifyAutoFiredTickets({ restaurantId: "merchant", orderId: "order", rounds: [] });
    await notifyAutoFiredTickets({
      restaurantId: "merchant",
      orderId: "order",
      rounds: [{ roundId: "A", groups: [] }],
    });
    expect(h.tx.restaurant.findUnique).not.toHaveBeenCalled();
    expect(h.notify).not.toHaveBeenCalled();
  });

  it("imprime sólo las estaciones con impresión activa, en el idioma del comercio", async () => {
    h.tx.restaurant.findUnique.mockResolvedValueOnce({
      kitchenPrintEnabled: true,
      barPrintEnabled: false,
      country: "BR",
    });
    await notifyAutoFiredTickets({
      restaurantId: "merchant",
      orderId: "order",
      rounds: [
        {
          roundId: "A",
          groups: [
            { station: "bar", barSubStation: "cocteles" },
            { station: "kitchen", barSubStation: null },
          ],
        },
      ],
    });
    expect(h.notify).toHaveBeenCalledTimes(1);
    expect(h.notify).toHaveBeenCalledWith({
      restaurantId: "merchant",
      orderId: "order",
      roundId: "A",
      station: "kitchen",
      barSubStation: null,
      locale: "pt",
    });
  });

  it("con la impresión de la estación apagada deja rastro en el log y no imprime", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      h.tx.restaurant.findUnique.mockResolvedValueOnce({
        kitchenPrintEnabled: true,
        barPrintEnabled: false,
        country: "CO",
      });
      await notifyAutoFiredTickets({
        restaurantId: "merchant",
        orderId: "order",
        rounds: [
          {
            roundId: "A",
            groups: [
              { station: "bar", barSubStation: null },
              { station: "kitchen", barSubStation: null },
            ],
          },
        ],
      });
      expect(info).toHaveBeenCalledTimes(1);
      expect(info).toHaveBeenCalledWith(
        "[kds:auto-fire] impresión de bar apagada; comanda marchada sin imprimir",
        { restaurantId: "merchant", roundId: "A", station: "bar" },
      );
      expect(h.notify).toHaveBeenCalledTimes(1);
      expect(h.notify.mock.calls[0][0].station).toBe("kitchen");
    } finally {
      info.mockRestore();
    }
  });

  it("una impresora caída no rompe el pedido", async () => {
    h.notify.mockRejectedValueOnce(new Error("printer down"));
    await expect(
      notifyAutoFiredTickets({
        restaurantId: "merchant",
        orderId: "order",
        rounds: [{ roundId: "A", groups: [{ station: "bar", barSubStation: null }] }],
      }),
    ).resolves.toBeUndefined();
  });
});
