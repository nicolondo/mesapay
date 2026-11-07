import { beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ auth: vi.fn(), rateLimit: vi.fn() }));
vi.mock("@/auth", () => ({ auth: m.auth }));
vi.mock("@/lib/rateLimit", () => ({ rateLimit: m.rateLimit }));
vi.mock("@/lib/secureApi", () => ({ secureApi: (handler: unknown) => handler }));
import { adminWalletApi, walletJson, walletResponse } from "./api";
import { WalletError } from "./errors";
beforeEach(() => { vi.clearAllMocks(); m.auth.mockResolvedValue({ user: { id: "admin", email: "admin@example.test", role: "platform_admin" } }); m.rateLimit.mockResolvedValue(true); });
describe("platform wallet API isolation", () => {
  it("requires platform admin even when another restaurant context exists", async () => {
    const handler = vi.fn(); const route = adminWalletApi(handler);
    for (const role of ["operator", "group_admin", "waiter", null]) {
      m.auth.mockResolvedValueOnce(role ? { user: { id: "u", role } } : null);
      expect((await route(new Request("http://localhost/api/admin/wallet/config"))).status).toBe(401);
    }
    expect(handler).not.toHaveBeenCalled();
  });
  it("rate limits authenticated work and exposes only safe error codes", async () => {
    const route = adminWalletApi(async () => { throw new WalletError("credentials_unavailable", 503); });
    const res = await route(new Request("http://localhost/api/admin/wallet/config"));
    expect(res.status).toBe(503); expect(await res.json()).toEqual({ error: "credentials_unavailable" });
    m.rateLimit.mockResolvedValueOnce(false); expect((await route(new Request("http://localhost/api/admin/wallet/config"))).status).toBe(429);
  });
  it("uses no-store for financial data", () => expect(walletResponse({ balance: 1 }).headers.get("Cache-Control")).toBe("no-store"));
  it("rejects malformed and oversized bodies including missing size headers", async () => {
    await expect(walletJson(new Request("http://localhost", { method: "POST", body: "{" }))).rejects.toThrow("invalid_payload");
    await expect(walletJson(new Request("http://localhost", { method: "POST", body: JSON.stringify({ data: "x".repeat(20000) }) }))).rejects.toThrow("invalid_payload");
    expect(await walletJson(new Request("http://localhost", { method: "POST", body: '{"ok":true}' }))).toEqual({ ok: true });
    await expect(walletJson(new Request("http://localhost", { method: "POST" }))).rejects.toThrow("invalid_payload");
  });
});
