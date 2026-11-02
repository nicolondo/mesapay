import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  auth: vi.fn(),
  restaurantId: vi.fn(),
  restaurant: vi.fn(),
  findMany: vi.fn(),
}));
vi.mock("@/auth", () => ({ auth: m.auth }));
vi.mock("@/lib/activeRestaurant", () => ({ getActiveRestaurantId: m.restaurantId }));
vi.mock("@/lib/secureApi", () => ({ secureApi: (handler: unknown) => handler }));
vi.mock("@/lib/db", () => ({
  db: {
    restaurant: { findUnique: m.restaurant },
    aiConversation: { findMany: m.findMany },
  },
}));
import { GET } from "./route";

const list = () => GET(new Request("http://localhost/api/operator/insights/conversations"));

beforeEach(() => {
  vi.resetAllMocks();
  m.auth.mockResolvedValue({ user: { id: "user-1", role: "operator" } });
  m.restaurantId.mockResolvedValue("restaurant-a");
  m.restaurant.mockResolvedValue({ plan: "pro", aiInsightsEnabled: null });
  m.findMany.mockResolvedValue([]);
});

describe("GET /api/operator/insights/conversations", () => {
  it.each([undefined, "mesero", "kitchen", "terminal"])("rechaza el rol %s", async (role) => {
    m.auth.mockResolvedValue(role ? { user: { id: "u", role } } : null);
    const res = await list();
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("forbidden");
    expect(m.findMany).not.toHaveBeenCalled();
  });

  it("exige un comercio activo", async () => {
    m.restaurantId.mockResolvedValue(null);
    const res = await list();
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("no_restaurant");
  });

  it("responde con código cuando Pulso no está habilitado para el comercio", async () => {
    m.restaurant.mockResolvedValue({ plan: "basic", aiInsightsEnabled: null });
    const res = await list();
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("feature_disabled");
    expect(m.findMany).not.toHaveBeenCalled();
  });

  it("lista sólo las del comercio activo y del usuario en sesión, de la más reciente a la más vieja", async () => {
    m.findMany.mockResolvedValue([
      { id: "c2", title: "¿y el mes pasado?", updatedAt: new Date("2026-11-02T15:00:00Z"), _count: { messages: 4 } },
      { id: "c1", title: "Platos más vendidos", updatedAt: new Date("2026-10-30T12:00:00Z"), _count: { messages: 2 } },
    ]);
    const res = await list();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      conversations: [
        { id: "c2", title: "¿y el mes pasado?", updatedAt: "2026-11-02T15:00:00.000Z", messageCount: 4 },
        { id: "c1", title: "Platos más vendidos", updatedAt: "2026-10-30T12:00:00.000Z", messageCount: 2 },
      ],
    });
    expect(m.findMany).toHaveBeenCalledTimes(1);
    const args = m.findMany.mock.calls[0][0];
    expect(args.where).toMatchObject({ restaurantId: "restaurant-a", userId: "user-1" });
    expect(args.orderBy).toEqual({ updatedAt: "desc" });
    expect(args.take).toBe(50);
  });

  it("no manda los toolCalls ni el contenido de los mensajes en la lista", async () => {
    await list();
    const select = m.findMany.mock.calls[0][0].select;
    expect(select).not.toHaveProperty("toolCalls");
    expect(select).not.toHaveProperty("messages");
  });
});
