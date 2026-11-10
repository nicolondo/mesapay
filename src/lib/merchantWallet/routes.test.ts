import { beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ auth: vi.fn(), restaurant: vi.fn(), limit: vi.fn(), submit: vi.fn(), find: vi.fn(), refresh: vi.fn(), authorize: vi.fn() }));
vi.mock("@/auth", () => ({ auth: m.auth })); vi.mock("@/lib/activeRestaurant", () => ({ getActiveRestaurantId: m.restaurant }));
vi.mock("@/lib/secureApi", () => ({ secureApi: (handler: unknown) => handler })); vi.mock("@/lib/rateLimit", () => ({ rateLimit: m.limit }));
vi.mock("@/lib/db", () => ({ db: { payout: { findUnique: m.find } } }));
vi.mock("@/lib/payments", () => ({})); vi.mock("@/lib/platformConfig", () => ({})); vi.mock("@/lib/env", () => ({ env: {} }));
vi.mock("./service", () => ({ submitMerchantPayout: m.submit }));
vi.mock("./status", () => ({ refreshMerchantPayout: m.refresh, authorizeMerchantWebhook: m.authorize }));
import { GET, POST } from "@/app/api/operator/wallet/disperse/route";
import { POST as webhook } from "@/app/api/webhooks/kushki-payout/route";
import { WalletError } from "@/lib/platformWallet/errors";
const key = "89fcb4e0-414a-4505-937d-bd716f6c3660";
const dto = { ok: true, payoutId: "p1", idempotencyKey: key, amountCents: 10000, currency: "COP", status: "unknown", providerRef: null, responseText: "payout_unknown" };
const post = (body: unknown) => new Request("https://example.test/api/operator/wallet/disperse", { method: "POST", body: JSON.stringify(body) });
const get = (query = `restaurantId=r1&idempotencyKey=${key}`) => new Request(`https://example.test/api/operator/wallet/disperse?${query}`);
const hook = (body: unknown = {}, query = "?payoutId=p1", authorization = "Bearer secret") => new Request(`https://example.test/api/webhooks/kushki-payout${query}`, { method: "POST", headers: { authorization }, body: JSON.stringify(body) });
beforeEach(() => { vi.clearAllMocks(); m.auth.mockResolvedValue({ user: { id: "u1", email: "u@example.test", role: "operator" } }); m.restaurant.mockResolvedValue("r1"); m.limit.mockResolvedValue(true); m.submit.mockResolvedValue(dto); m.find.mockResolvedValue({ ...dto, id: "p1", restaurantId: "r1" }); m.refresh.mockResolvedValue(dto); m.authorize.mockResolvedValue("r1"); });
describe("merchant wallet API", () => {
  it("authenticates before parsing or provider work", async () => {
    m.auth.mockResolvedValue({ user: { id: "u1", role: "waiter" } }); expect((await POST(post({}))).status).toBe(401); expect((await GET(get())).status).toBe(401); expect(m.submit).not.toHaveBeenCalled();
  });
  it("requires a selected restaurant and rate quota", async () => {
    m.restaurant.mockResolvedValueOnce(null); expect((await POST(post({}))).status).toBe(400);
    m.limit.mockResolvedValueOnce(false); expect((await POST(post({}))).status).toBe(429); expect(m.submit).not.toHaveBeenCalled();
  });
  it("bounds chunked bodies before submission and disables caches", async () => {
    expect((await POST(post({ noise: "x".repeat(17000) }))).status).toBe(413);
    const res = await POST(post({ restaurantId: "r1", idempotencyKey: key, amountCents: 10000 })); expect(res.headers.get("cache-control")).toBe("no-store"); expect(await res.json()).toEqual(dto);
  });
  it("sanitizes unexpected failures and returns explicit known errors", async () => {
    m.submit.mockRejectedValueOnce(new Error("secret provider body")); expect(await (await POST(post({}))).json()).toEqual({ error: "payout_unavailable" });
    m.submit.mockRejectedValueOnce(new WalletError("idempotency_conflict")); expect((await POST(post({}))).status).toBe(409);
  });
  it("validates recovery tenant and UUID before lookup", async () => {
    expect((await GET(get(`restaurantId=other&idempotencyKey=${key}`))).status).toBe(409); expect((await GET(get("restaurantId=r1&idempotencyKey=bad"))).status).toBe(400); expect(m.find).not.toHaveBeenCalled();
  });
  it("never reveals another merchant or performs another init from recovery", async () => {
    m.find.mockResolvedValueOnce({ ...dto, id: "p1", restaurantId: "other" }); expect(await (await GET(get())).json()).toEqual({ payout: null });
    expect(await (await GET(get())).json()).toEqual({ payout: dto }); expect(m.submit).not.toHaveBeenCalled();
  });
  it("returns latest persisted state with sanitized refresh failure", async () => {
    m.refresh.mockRejectedValue(new Error("private provider data")); const res = await GET(get()); expect(await res.json()).toEqual({ payout: dto, refreshError: "payout_status_unavailable" });
  });
});
describe("merchant payout authenticated webhook", () => {
  it("limits guessed IDs before DB and remote work", async () => { m.limit.mockResolvedValueOnce(false); expect((await webhook(hook())).status).toBe(429); expect(m.authorize).not.toHaveBeenCalled(); });
  it("does not accept unsigned legacy callbacks or malformed IDs", async () => {
    expect((await webhook(hook({}, ""))).status).toBe(401); expect((await webhook(hook({}, "?payoutId=%20"))).status).toBe(401); expect(m.refresh).not.toHaveBeenCalled();
  });
  it("authenticates before reading body and applies payout quota", async () => {
    m.authorize.mockRejectedValueOnce(new WalletError("invalid_webhook", 401)); expect((await webhook(hook({ x: "x".repeat(20000) }))).status).toBe(401);
    m.limit.mockResolvedValueOnce(true).mockResolvedValueOnce(false); expect((await webhook(hook())).status).toBe(429); expect(m.refresh).not.toHaveBeenCalled();
  });
  it("bounds authenticated payload and uses only a ticket as query hint", async () => {
    expect((await webhook(hook({ x: "x".repeat(17000) }))).status).toBe(413);
    expect((await webhook(hook({ ticketNumber: "ticket", status: "APPROVED", totalAmount: 9 })) ).status).toBe(200);
    expect(m.refresh).toHaveBeenCalledWith("r1", "p1", { authorization: "Bearer secret", ticket: "ticket" });
  });
  it("does not echo upstream bodies or references on errors", async () => {
    m.refresh.mockRejectedValue(new Error("private body")); const res = await webhook(hook()); expect(res.status).toBe(503); expect(await res.json()).toEqual({ error: "payout_status_unavailable" });
  });
});
