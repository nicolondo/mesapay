import { beforeEach, describe, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({
  context: vi.fn(), access: vi.fn(), tableAccess: vi.fn(), rate: vi.fn(),
  restaurant: vi.fn(), payment: vi.fn(),
}));
vi.mock("./db", () => ({ db: { restaurant: { findUnique: h.restaurant }, payment: { findUnique: h.payment } } }));
vi.mock("./activeRestaurant", () => ({ getActiveContext: h.context }));
vi.mock("./guestAccess", () => ({ canAccessOrder: h.access, canAccessTable: h.tableAccess }));
vi.mock("./rateLimit", () => ({ rateLimit: h.rate }));
import { secureApi } from "./secureApi";
import { staffForRestaurant, COLLECTOR_ROLES } from "./staffAccess";
beforeEach(() => {
  vi.clearAllMocks(); h.rate.mockResolvedValue(true); h.context.mockResolvedValue(null);
  h.access.mockResolvedValue(false); h.tableAccess.mockResolvedValue(false);
  h.restaurant.mockResolvedValue({ id: "rest-a", suspended: false, enabledPaymentMethods: ["cash"] });
});
const invoke = (path: string, body: unknown, method = "POST", headers: Record<string, string> = {}) => {
  const handler = vi.fn(async () => new Response("ok"));
  const result = secureApi(handler)(new Request(`http://localhost${path}`, { method, headers: { host: "localhost", "content-type": "application/json", ...headers }, ...(method === "GET" ? {} : { body: JSON.stringify(body) }) }));
  return { result, handler };
};
describe("HTTP authorization boundaries", () => {
  it("blocks a foreign origin before work or writes", async () => {
    const { result, handler } = invoke("/api/operator/settings", {}, "POST", { origin: "https://foreign.test" });
    expect((await result).status).toBe(403); expect(handler).not.toHaveBeenCalled(); expect(h.rate).not.toHaveBeenCalled();
  });
  it("never dispatches an unowned order", async () => {
    const { result, handler } = invoke("/api/tenant/local/pay", { orderId: "other-order", method: "demo_cash" });
    expect((await result).status).toBe(403); expect(handler).not.toHaveBeenCalled();
    expect(h.access).toHaveBeenCalledWith("rest-a", "other-order");
  });
  it("blocks a disabled payment method even with a valid order capability", async () => {
    h.access.mockResolvedValue(true);
    const { result, handler } = invoke("/api/tenant/local/pay/kushki-charge", { orderId: "o", method: "kushki_card" });
    expect((await result).status).toBe(403); expect(handler).not.toHaveBeenCalled();
  });
  it("requires a staff identity for operator requests", async () => {
    const { result, handler } = invoke("/api/operator/dian", {}, "GET");
    expect((await result).status).toBe(401); expect(handler).not.toHaveBeenCalled();
  });
  it("staff from another restaurant cannot collect, even if they know the order", async () => {
    h.context.mockResolvedValue({ restaurantId: "rest-b", session: { user: { id: "staff", role: "operator" } } });
    expect(await staffForRestaurant("rest-a", COLLECTOR_ROLES)).toBeNull();
  });
  it("group administrators can collect only inside the active restaurant", async () => {
    h.context.mockResolvedValue({ restaurantId: "rest-a", session: { user: { id: "group", role: "group_admin" } } });
    expect((await staffForRestaurant("rest-a", COLLECTOR_ROLES))?.user.id).toBe("group");
    expect(await staffForRestaurant("rest-b", COLLECTOR_ROLES)).toBeNull();
  });
  it("rate limits fail closed and carry a retry hint", async () => {
    h.rate.mockResolvedValue(false);
    const { result, handler } = invoke("/api/tenant/local/diner/login", {});
    const response = await result;
    expect(response.status).toBe(429); expect(response.headers.get("Retry-After")).toBe("60"); expect(handler).not.toHaveBeenCalled();
  });
});
