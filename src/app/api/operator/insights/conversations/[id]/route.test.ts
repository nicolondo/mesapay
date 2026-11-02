import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  auth: vi.fn(),
  restaurantId: vi.fn(),
  restaurant: vi.fn(),
  findFirst: vi.fn(),
  deleteMany: vi.fn(),
}));
vi.mock("@/auth", () => ({ auth: m.auth }));
vi.mock("@/lib/activeRestaurant", () => ({ getActiveRestaurantId: m.restaurantId }));
vi.mock("@/lib/secureApi", () => ({ secureApi: (handler: unknown) => handler }));
vi.mock("@/lib/db", () => ({
  db: {
    restaurant: { findUnique: m.restaurant },
    aiConversation: { findFirst: m.findFirst, deleteMany: m.deleteMany },
  },
}));
import { DELETE, GET } from "./route";

const params = { params: Promise.resolve({ id: "conv-1" }) };
const url = "http://localhost/api/operator/insights/conversations/conv-1";
const detail = () => GET(new Request(url), params);
const remove = () => DELETE(new Request(url, { method: "DELETE" }), params);

const conversation = {
  id: "conv-1",
  title: "Platos más vendidos",
  createdAt: new Date("2026-11-01T10:00:00Z"),
  updatedAt: new Date("2026-11-02T15:00:00Z"),
  messages: [
    { id: "m1", role: "user", content: "¿Cuáles son mis platos más vendidos?", createdAt: new Date("2026-11-01T10:00:00Z") },
    { id: "m2", role: "assistant", content: "La bandeja paisa…", createdAt: new Date("2026-11-01T10:00:05Z") },
  ],
};

beforeEach(() => {
  vi.resetAllMocks();
  m.auth.mockResolvedValue({ user: { id: "user-1", role: "operator" } });
  m.restaurantId.mockResolvedValue("restaurant-a");
  m.restaurant.mockResolvedValue({ plan: "trial", aiInsightsEnabled: null });
  m.findFirst.mockResolvedValue(conversation);
  m.deleteMany.mockResolvedValue({ count: 1 });
});

describe("GET /api/operator/insights/conversations/[id]", () => {
  it("rechaza a un mesero", async () => {
    m.auth.mockResolvedValue({ user: { id: "u", role: "mesero" } });
    expect((await detail()).status).toBe(403);
    expect(m.findFirst).not.toHaveBeenCalled();
  });

  it("devuelve la conversación con sus mensajes en orden cronológico, sin toolCalls", async () => {
    const res = await detail();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.conversation.id).toBe("conv-1");
    expect(body.conversation.messages.map((x: { role: string }) => x.role)).toEqual(["user", "assistant"]);
    expect(JSON.stringify(body)).not.toContain("toolCalls");

    const args = m.findFirst.mock.calls[0][0];
    expect(args.where).toEqual({ id: "conv-1", restaurantId: "restaurant-a", userId: "user-1" });
    expect(args.select.messages.orderBy).toEqual({ createdAt: "asc" });
    expect(args.select.messages.select).not.toHaveProperty("toolCalls");
  });

  it("404 si la conversación es de otro comercio o de otro usuario", async () => {
    m.findFirst.mockResolvedValue(null);
    const res = await detail();
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("not_found");
  });
});

describe("DELETE /api/operator/insights/conversations/[id]", () => {
  it("borra la propia, acotando por comercio y usuario en el mismo borrado", async () => {
    const res = await remove();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(m.deleteMany).toHaveBeenCalledWith({
      where: { id: "conv-1", restaurantId: "restaurant-a", userId: "user-1" },
    });
  });

  it("404 si no es suya (no borra nada ni revela que existe)", async () => {
    m.deleteMany.mockResolvedValue({ count: 0 });
    const res = await remove();
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("not_found");
  });

  it("no borra si Pulso está deshabilitado para el comercio", async () => {
    m.restaurant.mockResolvedValue({ plan: "basic", aiInsightsEnabled: false });
    expect((await remove()).status).toBe(403);
    expect(m.deleteMany).not.toHaveBeenCalled();
  });
});
