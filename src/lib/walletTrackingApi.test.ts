import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ auth: vi.fn(), active: vi.fn(), account: vi.fn(), rate: vi.fn(), get: vi.fn(), sync: vi.fn(), history: vi.fn(), incorporate: vi.fn(), adjust: vi.fn(), operation: vi.fn() }));
vi.mock("@/auth", () => ({ auth: m.auth }));
vi.mock("@/lib/activeRestaurant", () => ({ getActiveRestaurantId: m.active }));
vi.mock("@/lib/platformWallet/config", () => ({ activeAccount: m.account }));
vi.mock("@/lib/rateLimit", () => ({ rateLimit: m.rate }));
vi.mock("@/lib/secureApi", () => ({ secureApi: (handler: unknown) => handler }));
vi.mock("@/lib/walletTracking/service", () => ({ getWalletTracking: m.get, syncWalletTracking: m.sync, adjustWalletTracking: m.adjust, listTrackingHistoryCandidates: m.history, incorporateTrackingHistory: m.incorporate, findWalletTrackingOperation: m.operation }));

import { createTrackingHandler } from "./walletTrackingApi";
import { TrackingError } from "./walletTracking/errors";

const actor = { id: "user-a", email: "admin@example.test", role: "platform_admin" };
const view = { trackingId: "tracking-a", estimatedPendingCents: 12500, status: "active" };
function request(kind: "platform" | "merchant", method = "GET", extra: Record<string, unknown> = {}) {
  const field = kind === "platform" ? "accountId" : "restaurantId";
  const id = kind === "platform" ? "wallet-a" : "tenant-a";
  const url = `http://localhost/api/${kind === "platform" ? "admin" : "operator"}/wallet/tracking`;
  return method === "GET" ? new Request(`${url}?${new URLSearchParams({ [field]: id, ...extra as Record<string, string> })}`)
    : new Request(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ [field]: id, ...extra }) });
}

beforeEach(() => {
  vi.resetAllMocks();
  m.auth.mockResolvedValue({ user: actor });
  m.active.mockResolvedValue("tenant-a");
  m.account.mockResolvedValue({ id: "wallet-a" });
  m.rate.mockResolvedValue(true);
  for (const fn of [m.get, m.sync, m.adjust, m.incorporate]) fn.mockResolvedValue(view);
  m.history.mockResolvedValue({ trackingId: "tracking-a", candidates: [], nextCursor: null });
});

describe("wallet tracking request boundaries", () => {
  it("requires the correct role before reading or mutating either scope", async () => {
    for (const role of ["waiter", "kitchen", "bar", "diner"]) {
      m.auth.mockResolvedValue({ user: { ...actor, role } });
      for (const kind of ["platform", "merchant"] as const) expect((await createTrackingHandler(kind, "sync")(request(kind, "POST", { action: "sync" }))).status).toBe(401);
    }
    m.auth.mockResolvedValue({ user: { ...actor, role: "operator" } });
    expect((await createTrackingHandler("platform", "get")(request("platform"))).status).toBe(401);
    expect(m.sync).not.toHaveBeenCalled();
    expect(m.get).not.toHaveBeenCalled();
  });

  it("requires an explicit current scope and never accepts an arbitrary tenant as authorization", async () => {
    expect((await createTrackingHandler("platform", "get")(new Request("http://localhost/api/admin/wallet/tracking"))).status).toBe(400);
    expect((await createTrackingHandler("platform", "get")(request("platform", "GET", { accountId: "other" }))).status).toBe(409);
    expect((await createTrackingHandler("merchant", "sync")(request("merchant", "POST", { action: "sync", restaurantId: "other" }))).status).toBe(409);
    m.active.mockResolvedValue(null);
    expect((await createTrackingHandler("merchant", "get")(request("merchant"))).status).toBe(401);
    expect(m.get).not.toHaveBeenCalled();
    expect(m.sync).not.toHaveBeenCalled();
  });

  it("keeps GET read-only and sends actor plus scope only to authorized mutations", async () => {
    const get = await createTrackingHandler("merchant", "get")(request("merchant"));
    expect(await get.json()).toEqual({ ...view, restaurantId: "tenant-a" });
    expect(get.headers.get("Cache-Control")).toBe("no-store");
    expect(m.get).toHaveBeenCalledWith({ kind: "merchant", restaurantId: "tenant-a" });
    expect(m.sync).not.toHaveBeenCalled();
    const sync = await createTrackingHandler("platform", "sync")(request("platform", "POST", { action: "sync" }));
    expect(sync.status).toBe(200);
    expect(m.sync).toHaveBeenCalledWith({ kind: "platform" }, actor);
  });

  it("forwards bounded history and financial adjustments without trusting context fields in the payload", async () => {
    const payload = { trackingId: "tracking-a", idempotencyKey: "nonce-a", kind: "fee", amountCents: 300, reason: "Provider commission" };
    expect((await createTrackingHandler("merchant", "adjust")(request("merchant", "POST", payload))).status).toBe(200);
    expect(m.adjust).toHaveBeenCalledWith({ kind: "merchant", restaurantId: "tenant-a" }, payload, actor);
    const history = { trackingId: "tracking-a", idempotencyKey: "nonce-b", source: "order", sourceId: "payment-a", remainingCents: 100, reason: "Reviewed previous collection" };
    expect((await createTrackingHandler("platform", "incorporate")(request("platform", "POST", history))).status).toBe(200);
    expect(m.incorporate).toHaveBeenCalledWith({ kind: "platform" }, history, actor);
    expect((await createTrackingHandler("platform", "history")(request("platform", "GET", { cursor: "opaque", limit: "20" }))).status).toBe(200);
    expect(m.history).toHaveBeenCalledWith({ kind: "platform" }, { cursor: "opaque", limit: 20 });
  });

  it("rejects invalid sync bodies, pagination and oversized streams before service work", async () => {
    expect((await createTrackingHandler("platform", "sync")(request("platform", "POST", { action: "disperse" }))).status).toBe(400);
    for (const limit of ["0", "10000", "NaN", "1.5"]) expect((await createTrackingHandler("platform", "history")(request("platform", "GET", { limit }))).status).toBe(400);
    const huge = request("platform", "POST", { action: "sync", padding: "x".repeat(20_000) });
    expect((await createTrackingHandler("platform", "sync")(huge)).status).toBe(413);
    expect(m.sync).not.toHaveBeenCalled();
    expect(m.history).not.toHaveBeenCalled();
  });

  it("passes a historical review acknowledgement only when explicitly supplied as a boolean", async () => {
    const adjustment = { trackingId: "tracking-a", idempotencyKey: "nonce-review", kind: "external_debit", amountCents: 1000, reason: "Reviewed old refund", acknowledgeHistoricalChanges: true, historicalChangeToken: "opaque-reviewed-state" };
    expect((await createTrackingHandler("merchant", "adjust")(request("merchant", "POST", adjustment))).status).toBe(200);
    expect(m.adjust).toHaveBeenCalledWith({ kind: "merchant", restaurantId: "tenant-a" }, adjustment, actor);
    expect((await createTrackingHandler("merchant", "adjust")(request("merchant", "POST", { ...adjustment, acknowledgeHistoricalChanges: "true" }))).status).toBe(400);
    expect(m.adjust).toHaveBeenCalledTimes(1);
  });

  it("guards rate limits and rejects responses after the active context changes", async () => {
    m.rate.mockResolvedValueOnce(false);
    expect((await createTrackingHandler("merchant", "sync")(request("merchant", "POST", { action: "sync" }))).status).toBe(429);
    expect(m.sync).not.toHaveBeenCalled();
    m.account.mockResolvedValueOnce({ id: "wallet-a" }).mockResolvedValueOnce({ id: "wallet-b" });
    expect((await createTrackingHandler("platform", "get")(request("platform"))).status).toBe(409);
    m.active.mockResolvedValueOnce("tenant-a").mockResolvedValueOnce("tenant-b");
    expect((await createTrackingHandler("merchant", "get")(request("merchant"))).status).toBe(409);
  });

  it("returns expected conflicts but never database details or private credentials", async () => {
    m.sync.mockRejectedValueOnce(new TrackingError("tracking_busy", 409));
    expect(await (await createTrackingHandler("platform", "sync")(request("platform", "POST", { action: "sync" }))).json()).toEqual({ error: "tracking_busy" });
    m.sync.mockRejectedValueOnce(new Error("private-key database connection details"));
    const failed = await createTrackingHandler("platform", "sync")(request("platform", "POST", { action: "sync" }));
    expect(failed.status).toBe(503);
    expect(await failed.json()).toEqual({ error: "tracking_unavailable" });
  });

  it("recovers a lost adjustment response by opaque operation id within the current scope", async () => {
    m.operation.mockResolvedValue(true);
    const recovered = await createTrackingHandler("merchant", "get")(request("merchant", "GET", { operationId: "opaque-operation-a" }));
    expect(await recovered.json()).toEqual({ ...view, restaurantId: "tenant-a", operationFound: true });
    expect(m.operation).toHaveBeenCalledWith({ kind: "merchant", restaurantId: "tenant-a" }, "opaque-operation-a");
    expect((await createTrackingHandler("merchant", "get")(request("merchant", "GET", { operationId: "x".repeat(200) }))).status).toBe(400);
    expect(m.adjust).not.toHaveBeenCalled();
  });
});
