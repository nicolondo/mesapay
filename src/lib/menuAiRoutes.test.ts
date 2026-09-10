import { beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({
  role: "operator",
  category: vi.fn(),
  items: vi.fn(),
  generate: vi.fn(),
  allow: vi.fn(),
  save: vi.fn(),
  audit: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/secureApi", () => ({ secureApi: (fn: unknown) => fn }));
vi.mock("@/auth", () => ({
  auth: async () => ({ user: { id: "actor", role: m.role } }),
}));
vi.mock("@/lib/activeRestaurant", () => ({
  getActiveRestaurantId: async () => "restaurant-a",
}));
vi.mock("@/lib/db", () => ({
  db: { category: { findFirst: m.category }, menuItem: { findMany: m.items } },
}));
vi.mock("@/lib/menuDescribe", () => ({ generateMenuDescriptions: m.generate }));
vi.mock("@/lib/menuAiLimit", () => ({ allowMenuAi: m.allow }));
vi.mock("@/lib/menuAiConfig", () => ({
  MenuAiError: class extends Error {},
  setMenuAiConfig: m.save,
  getMenuAiStatus: async () => ({ enabled: true, source: "admin" }),
}));
vi.mock("@/lib/auditLog", () => ({ recordAuditEvent: m.audit }));
import { POST } from "@/app/api/operator/menu-items/describe/route";
import { POST as BULK } from "@/app/api/operator/menu-items/bulk/route";
import { PATCH } from "@/app/api/admin/menu-ai/route";
const req = (body: unknown) =>
  new Request("https://example.test/api", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
beforeEach(() => {
  vi.clearAllMocks();
  m.role = "operator";
  m.allow.mockResolvedValue(true);
  m.category.mockResolvedValue({ label: "Sopas", parent: null });
  m.generate.mockResolvedValue(new Map([["draft", "Sopa sugerida"]]));
});
describe("menu AI authorization and budget", () => {
  it("rejects staff generation and non-admin credential changes", async () => {
    m.role = "waiter";
    expect((await POST(req({ name: "Sopa", categoryId: "cat" }))).status).toBe(
      403,
    );
    m.role = "operator";
    expect(
      (await PATCH(req({ enabled: true, apiKey: "sk-ant-fixture" }))).status,
    ).toBe(403);
    expect(m.save).not.toHaveBeenCalled();
    expect(m.generate).not.toHaveBeenCalled();
  });
  it("checks category ownership before spending AI budget", async () => {
    m.category.mockResolvedValue(null);
    expect(
      (await POST(req({ name: "Sopa", categoryId: "foreign" }))).status,
    ).toBe(400);
    expect(m.category).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "foreign", restaurantId: "restaurant-a" },
      }),
    );
    expect(m.allow).not.toHaveBeenCalled();
  });
  it("returns a proposal without saving it and enforces the shared limit", async () => {
    expect(
      await (await POST(req({ name: "Sopa", categoryId: "cat" }))).json(),
    ).toEqual({ description: "Sopa sugerida" });
    m.allow.mockResolvedValue(false);
    expect((await POST(req({ name: "Sopa", categoryId: "cat" }))).status).toBe(
      429,
    );
    expect(m.generate).toHaveBeenCalledTimes(1);
    expect(m.allow).toHaveBeenCalledWith("restaurant-a");
  });
  it("bounds bulk requests and restricts lookups to the active restaurant", async () => {
    expect(
      (
        await BULK(
          req({
            action: "generate-descriptions",
            itemIds: Array.from({ length: 26 }, (_, i) => String(i)),
          }),
        )
      ).status,
    ).toBe(400);
    m.items.mockResolvedValue([
      {
        id: "own",
        name: "Sopa",
        description: "Actual",
        category: { label: "Sopas", parent: null },
      },
    ]);
    await BULK(
      req({ action: "generate-descriptions", itemIds: ["own", "foreign"] }),
    );
    expect(m.items).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: { in: ["own", "foreign"] }, restaurantId: "restaurant-a" },
      }),
    );
    expect(m.generate.mock.calls[0][0]).toHaveLength(1);
  });
  it("never returns keys or records them in the audit event", async () => {
    m.role = "platform_admin";
    const res = await PATCH(req({ enabled: true, apiKey: "sk-ant-fixture" }));
    expect(res.status).toBe(200);
    expect(await res.text()).not.toContain("sk-ant-fixture");
    expect(JSON.stringify(m.audit.mock.calls)).not.toContain("sk-ant-fixture");
    expect(m.save).toHaveBeenCalledWith(
      { enabled: true, apiKey: "sk-ant-fixture" },
      "actor",
    );
  });
});
