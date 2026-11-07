import { beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ rate: vi.fn(), authorize: vi.fn(), refresh: vi.fn() }));
vi.mock("@/lib/rateLimit", () => ({ rateLimit: m.rate }));
vi.mock("@/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/secureApi", () => ({ secureApi: (handler: unknown) => handler }));
vi.mock("@/lib/platformWallet/status", () => ({ authorizePlatformWebhook: m.authorize, refreshPlatformPayout: m.refresh }));
import { POST } from "./route";
import { WalletError } from "@/lib/platformWallet/errors";
const context = { params: Promise.resolve({ id: "payout-1" }) };
function request(body = '{"ticketNumber":"1234"}') { return new Request("http://localhost/api/webhooks/kushki-platform-payout/payout-1", { method: "POST", headers: { authorization: "Bearer secret", "x-real-ip": "127.0.0.1" }, body }); }
beforeEach(() => { vi.resetAllMocks(); m.rate.mockResolvedValue(true); m.authorize.mockResolvedValue(undefined); m.refresh.mockResolvedValue({ status: "approved" }); });
describe("platform payout callback", () => {
  it("limits guesses by IP before accessing database or parsing the payload", async () => {
    m.rate.mockResolvedValueOnce(false);
    expect((await POST(request("not-json"), context)).status).toBe(429);
    expect(m.rate).toHaveBeenCalledWith("platform-wallet-webhook-ip:127.0.0.1", 120, 60);
    expect(m.authorize).not.toHaveBeenCalled();
  });
  it("authenticates before parsing untrusted bodies", async () => {
    m.authorize.mockRejectedValueOnce(new WalletError("invalid_webhook", 401));
    expect((await POST(request("not-json"), context)).status).toBe(401); expect(m.refresh).not.toHaveBeenCalled();
  });
  it("uses callback only as a verified lookup signal, ignoring claimed status", async () => {
    expect((await POST(request('{"ticketNumber":"1234","status":"APPROVED"}'), context)).status).toBe(200);
    expect(m.refresh).toHaveBeenCalledWith("payout-1", { authorization: "Bearer secret", ticket: "1234" });
  });
  it("rejects oversized payloads and malformed payout IDs", async () => {
    expect((await POST(request(JSON.stringify({ x: "a".repeat(20000) })), context)).status).toBe(413);
    expect((await POST(request(), { params: Promise.resolve({ id: "x".repeat(101) }) })).status).toBe(401);
    expect(m.refresh).not.toHaveBeenCalled();
  });
});
