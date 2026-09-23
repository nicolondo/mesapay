// PATCH /order-items/[id] con cancel.kind="comp": sólo los roles que el
// comercio eligió (Restaurant.compAllowedRoles) pueden NO COBRAR un plato.
// La cancelación normal (kind="cancel") no pasa por esa política.
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  auth: vi.fn(),
  activeRestaurantId: vi.fn(),
  itemFindUnique: vi.fn(),
  restaurantFindUnique: vi.fn(),
  txItemUpdate: vi.fn(),
  txItemCount: vi.fn(),
  txRoundUpdate: vi.fn(),
  recordAuditEvent: vi.fn(),
  publishOrderEvent: vi.fn(),
}));

vi.mock("@/lib/secureApi", () => ({ secureApi: (h: unknown) => h }));
vi.mock("@/auth", () => ({ auth: m.auth }));
vi.mock("@/lib/activeRestaurant", () => ({
  getActiveRestaurantId: m.activeRestaurantId,
}));
vi.mock("@/lib/orderLock", () => ({ lockOrder: async () => {} }));
vi.mock("@/lib/orders", () => ({
  requireMutableOrderInTx: async () => {},
  recomputeOrderLinesInTx: async () => {},
}));
vi.mock("@/lib/events", () => ({ publishOrderEvent: m.publishOrderEvent }));
vi.mock("@/lib/push", () => ({ sendPushToMeserosForTable: async () => {} }));
vi.mock("@/lib/auditLog", () => ({ recordAuditEvent: m.recordAuditEvent }));
vi.mock("@/lib/print/enqueue", () => ({
  notifyAcceptedRoundTicketSafe: async () => {},
}));
vi.mock("@/lib/kds/roundStatus", () => ({ itemKitchenStatusData: () => ({}) }));
vi.mock("@/lib/kds/transition", () => ({
  recomputeRoundStatusInTx: async () => null,
}));
vi.mock("@/lib/db", () => ({
  db: {
    orderItem: { findUnique: m.itemFindUnique },
    // Lo lee el guard de "no cobrar" (src/lib/compGuard.ts).
    restaurant: { findUnique: m.restaurantFindUnique },
    $transaction: async (fn: (tx: unknown) => unknown) =>
      fn({
        orderItem: {
          findUniqueOrThrow: m.itemFindUnique,
          update: m.txItemUpdate,
          count: m.txItemCount,
        },
        round: { update: m.txRoundUpdate },
        menuItem: { update: vi.fn() },
      }),
  },
}));

import { PATCH } from "./route";

const patch = (body: Record<string, unknown>) =>
  PATCH(
    new Request("http://localhost/api/operator/order-items/it-1", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: "it-1" }) },
  );

// Plato ya entregado: es el caso donde la UI ofrece "No cobrar".
const servedItem = {
  id: "it-1",
  orderId: "o-1",
  roundId: "rd-1",
  qty: 1,
  nameSnapshot: "Lomo",
  priceCentsSnapshot: 45000,
  kitchenStatus: "ready",
  servedAt: new Date("2026-09-18T20:00:00Z"),
  cancelledAt: null,
  menuItemId: "mi-1",
  station: "kitchen",
  barSubStation: null,
  order: {
    id: "o-1",
    restaurantId: "r1",
    tableId: "t-1",
    status: "served",
    table: { kind: "regular" },
  },
};

const comp = { cancel: { reason: "Plato frío / mal preparado", kind: "comp" } };
const cancel = { cancel: { reason: "Cliente cambió de opinión", kind: "cancel" } };

// ¿Alguna lectura de Restaurant pidió la política de "no cobrar"? La ruta
// también lee Restaurant por otros motivos (flags de impresión), así que
// "no llamó a findUnique" no alcanza para afirmar que no consultó la política.
function readCompPolicy(): boolean {
  return m.restaurantFindUnique.mock.calls.some(
    (c) => !!(c[0] as { select?: { compAllowedRoles?: boolean } }).select?.compAllowedRoles,
  );
}

function asRole(role: string) {
  m.auth.mockResolvedValue({
    user: { id: "u-1", role, email: `${role}@x.com` },
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  m.activeRestaurantId.mockResolvedValue("r1");
  m.itemFindUnique.mockResolvedValue(servedItem);
  m.txItemCount.mockResolvedValue(1);
  // Política por defecto: sólo el administrador.
  m.restaurantFindUnique.mockResolvedValue({ compAllowedRoles: ["operator"] });
});

describe("PATCH /order-items/[id] — no cobrar (kind=comp) por rol", () => {
  it("rebota al mesero con 403 comp_not_allowed si no está en la lista", async () => {
    asRole("mesero");
    const res = await patch(comp);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "comp_not_allowed" });
    // Ni tocó el plato ni dejó rastro en auditoría.
    expect(m.txItemUpdate).not.toHaveBeenCalled();
    expect(m.recordAuditEvent).not.toHaveBeenCalled();
  });

  it("deja pasar al administrador (default) y audita con kind order_item.comp", async () => {
    asRole("operator");
    const res = await patch(comp);
    expect(res.status).toBe(200);
    expect(m.txItemUpdate).toHaveBeenCalledOnce();
    expect(m.txItemUpdate.mock.calls[0][0].data).toMatchObject({
      cancellationKind: "comp",
      cancelledByEmail: "operator@x.com",
    });
    expect(m.recordAuditEvent).toHaveBeenCalledOnce();
    expect(m.recordAuditEvent.mock.calls[0][0]).toMatchObject({
      kind: "order_item.comp",
      restaurantId: "r1",
      target: { type: "order_item", id: "it-1" },
    });
  });

  it("deja pasar al mesero cuando el comercio lo puso en la lista", async () => {
    asRole("mesero");
    m.restaurantFindUnique.mockResolvedValue({
      compAllowedRoles: ["operator", "mesero"],
    });
    const res = await patch(comp);
    expect(res.status).toBe(200);
    expect(m.txItemUpdate.mock.calls[0][0].data).toMatchObject({
      cancellationKind: "comp",
    });
  });

  it("con la lista vacía ni el administrador puede", async () => {
    asRole("operator");
    m.restaurantFindUnique.mockResolvedValue({ compAllowedRoles: [] });
    const res = await patch(comp);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "comp_not_allowed" });
  });

  it("platform_admin impersonando pasa sin leer la política", async () => {
    asRole("platform_admin");
    m.restaurantFindUnique.mockResolvedValue({ compAllowedRoles: [] });
    const res = await patch(comp);
    expect(res.status).toBe(200);
    expect(readCompPolicy()).toBe(false);
  });

  it("cocina nunca puede no cobrar, esté o no en la lista", async () => {
    asRole("kitchen");
    m.restaurantFindUnique.mockResolvedValue({
      compAllowedRoles: ["operator", "kitchen"],
    });
    const res = await patch(comp);
    expect(res.status).toBe(403);
  });

  it("la cancelación normal (kind=cancel) no pasa por la política", async () => {
    asRole("mesero");
    // Plato que todavía no salió: es el caso de "Cancelar".
    m.itemFindUnique.mockResolvedValue({
      ...servedItem,
      kitchenStatus: "placed",
      servedAt: null,
    });
    const res = await patch(cancel);
    expect(res.status).toBe(200);
    expect(readCompPolicy()).toBe(false);
    expect(m.txItemUpdate.mock.calls[0][0].data).toMatchObject({
      cancellationKind: "cancel",
    });
    expect(m.recordAuditEvent.mock.calls[0][0]).toMatchObject({
      kind: "order_item.cancel",
    });
  });

  it("marcar entregado (served) tampoco consulta la política", async () => {
    asRole("mesero");
    // Sin ronda para no entrar al roll-up de ronda/orden, que no es lo que
    // se prueba acá.
    m.itemFindUnique.mockResolvedValue({
      ...servedItem,
      roundId: null,
      servedAt: null,
    });
    const res = await patch({ served: true });
    expect(res.status).toBe(200);
    expect(readCompPolicy()).toBe(false);
  });
});
