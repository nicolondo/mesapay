import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  auth: vi.fn(),
  restaurantId: vi.fn(),
  restaurant: vi.fn(),
  convFindFirst: vi.fn(),
  convCreate: vi.fn(),
  convUpdate: vi.fn(),
  convDelete: vi.fn(),
  msgFindMany: vi.fn(),
  msgCreate: vi.fn(),
  transaction: vi.fn(),
  run: vi.fn(),
  limit: vi.fn(),
  used: vi.fn(),
}));
vi.mock("@/auth", () => ({ auth: m.auth }));
vi.mock("@/lib/activeRestaurant", () => ({ getActiveRestaurantId: m.restaurantId }));
vi.mock("@/lib/secureApi", () => ({ secureApi: (handler: unknown) => handler }));
vi.mock("next-intl/server", () => ({
  getLocale: async () => "es",
  getTranslations: async () => (key: string) => key,
}));
// Nunca se habla con Anthropic desde los tests: cliente y agente son mocks.
vi.mock("@/lib/anthropic", () => ({ getClient: () => ({}), INSIGHTS_MODEL: "test-model" }));
vi.mock("@/lib/ai/toolRegistry", () => ({ anthropicTools: () => [], executeTool: vi.fn() }));
vi.mock("@/lib/ai/insightsAgent", () => ({ runInsightsAgent: m.run }));
vi.mock("@/lib/ai/tools/dateRange", () => ({ timezoneForCountry: () => "America/Bogota" }));
vi.mock("@/lib/ai/aiAccess", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ai/aiAccess")>()),
  dailyMessageLimit: m.limit,
  messagesUsedToday: m.used,
}));
vi.mock("@/lib/db", () => ({
  db: {
    restaurant: { findUnique: m.restaurant },
    aiConversation: {
      findFirst: m.convFindFirst,
      create: m.convCreate,
      update: m.convUpdate,
      delete: m.convDelete,
    },
    aiMessage: { findMany: m.msgFindMany, create: m.msgCreate },
    $transaction: m.transaction,
  },
}));
import { POST } from "./route";

const post = (body: unknown) =>
  POST(
    new Request("http://localhost/api/operator/insights/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

type Op = { op: "msg" | "touch"; args: Record<string, unknown> };

beforeEach(() => {
  vi.resetAllMocks();
  m.auth.mockResolvedValue({ user: { id: "user-1", role: "operator" } });
  m.restaurantId.mockResolvedValue("restaurant-a");
  m.restaurant.mockResolvedValue({
    plan: "pro",
    aiInsightsEnabled: null,
    aiDailyMessageLimit: null,
    name: "Son y Melona",
    country: "CO",
  });
  m.limit.mockResolvedValue(50);
  m.used.mockResolvedValue(3);
  m.msgFindMany.mockResolvedValue([]);
  m.run.mockResolvedValue({ text: "La bandeja paisa lidera.", toolCalls: [] });
  // Las operaciones de Prisma se devuelven como marcadores para comprobar
  // qué entra en la transacción.
  m.msgCreate.mockImplementation((args: Record<string, unknown>): Op => ({ op: "msg", args }));
  m.convUpdate.mockImplementation((args: Record<string, unknown>): Op => ({ op: "touch", args }));
  m.transaction.mockResolvedValue([]);
  m.convDelete.mockResolvedValue({});
});

describe("POST /api/operator/insights/chat", () => {
  it("al continuar una conversación toca su updatedAt en la misma transacción que guarda los mensajes", async () => {
    m.convFindFirst.mockResolvedValue({ id: "conv-1", restaurantId: "restaurant-a", userId: "user-1" });
    const res = await post({ message: "¿y el mes pasado?", conversationId: "conv-1" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ conversationId: "conv-1", text: "La bandeja paisa lidera." });

    expect(m.convCreate).not.toHaveBeenCalled();
    expect(m.convUpdate).toHaveBeenCalledWith({
      where: { id: "conv-1" },
      data: { updatedAt: expect.any(Date) },
    });
    expect(m.transaction).toHaveBeenCalledTimes(1);
    const ops = m.transaction.mock.calls[0][0] as Op[];
    expect(ops.filter((o) => o.op === "msg")).toHaveLength(2);
    expect(ops.filter((o) => o.op === "touch")).toHaveLength(1);
  });

  it("crea la conversación para el comercio activo y el usuario en sesión con el primer mensaje como título", async () => {
    m.convFindFirst.mockResolvedValue(null);
    m.convCreate.mockResolvedValue({ id: "conv-new" });
    const res = await post({ message: "¿Cuáles son mis platos más vendidos este mes?" });
    expect(res.status).toBe(200);
    expect((await res.json()).conversationId).toBe("conv-new");
    expect(m.convCreate).toHaveBeenCalledWith({
      data: {
        restaurantId: "restaurant-a",
        userId: "user-1",
        title: "¿Cuáles son mis platos más vendidos este mes?",
      },
    });
    const ops = m.transaction.mock.calls[0][0] as Op[];
    expect(ops.filter((o) => o.op === "touch")[0].args).toMatchObject({ where: { id: "conv-new" } });
  });

  it("si el agente falla en una conversación recién creada, la borra y no toca nada más", async () => {
    m.convFindFirst.mockResolvedValue(null);
    m.convCreate.mockResolvedValue({ id: "conv-new" });
    m.run.mockRejectedValue(new Error("boom"));
    const res = await post({ message: "hola" });
    expect(res.status).toBe(500);
    expect(m.convDelete).toHaveBeenCalledWith({ where: { id: "conv-new" } });
    expect(m.transaction).not.toHaveBeenCalled();
    expect(m.convUpdate).not.toHaveBeenCalled();
  });

  it("respeta el límite diario con código, sin guardar", async () => {
    m.used.mockResolvedValue(50);
    const res = await post({ message: "hola" });
    expect(res.status).toBe(429);
    expect((await res.json()).error).toBe("daily_limit");
    expect(m.run).not.toHaveBeenCalled();
    expect(m.transaction).not.toHaveBeenCalled();
  });
});
