import { beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ fetch: vi.fn(), capture: vi.fn(), resolve: vi.fn(), update: vi.fn(), find: vi.fn(), credentials: vi.fn(), mode: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: { billingSubscription: { updateMany: m.update, findUnique: m.find } } }));
vi.mock("@/lib/platformConfig", () => ({ getBillingCredentials: m.credentials, getKushkiMode: m.mode }));
vi.mock("@/lib/payments/kushki/client", () => ({ kushkiFetch: m.fetch }));
vi.mock("@/lib/walletTracking/context", () => ({ captureWalletTrackingContext: m.capture, resolveTrackingContext: m.resolve }));
import { recurringTrackingContext } from "./subscriptionTracking";
const tracking = { trackingKey: "verified-opaque-binding", mode: "production" as const, currency: "COP" };
const subscription = { restaurantId: "restaurant-a", subscriptionId: "1574693127852000", currency: "COP", walletTrackingKey: null, walletTrackingMode: null };
beforeEach(() => {
  vi.resetAllMocks(); m.mode.mockResolvedValue("production"); m.credentials.mockResolvedValue({ privateKey: "test-only-private-key" });
  m.capture.mockResolvedValue(tracking); m.resolve.mockResolvedValue(tracking); m.update.mockResolvedValue({ count: 1 });
  m.fetch.mockResolvedValue({ subscriptionId: subscription.subscriptionId, amount: { currency: "COP" } });
});
describe("tracking existing recurring subscriptions", () => {
  it("binds only after authenticated lookup of this exact subscription and currency", async () => {
    expect(await recurringTrackingContext(subscription)).toEqual(tracking);
    expect(m.fetch).toHaveBeenCalledWith(`/subscriptions/v1/card/search/${subscription.subscriptionId}`, {
      method: "GET", mode: "production", auth: { kind: "billing", privateKey: "test-only-private-key" }, retries: 0,
    });
    expect(m.update).toHaveBeenCalledWith({ where: { restaurantId: "restaurant-a", kushkiSubscriptionId: subscription.subscriptionId, walletTrackingKey: null }, data: { walletTrackingKey: tracking.trackingKey, walletTrackingMode: "production" } });
  });
  it("preserves the original binding through account changes and never reassigns it", async () => {
    expect(await recurringTrackingContext({ ...subscription, walletTrackingKey: "original", walletTrackingMode: "sandbox" })).toEqual({ trackingKey: "original", mode: "sandbox", currency: "COP" });
    expect(m.fetch).not.toHaveBeenCalled();
  });
  it.each([{}, { subscriptionId: "other", amount: { currency: "COP" } }, { subscriptionId: subscription.subscriptionId, amount: { currency: "USD" } }])("rejects incomplete or mismatching provider evidence", async (response) => {
    m.fetch.mockResolvedValue(response);
    expect(await recurringTrackingContext(subscription)).toBeNull(); expect(m.update).not.toHaveBeenCalled();
  });
  it("does not interrupt billing on a provider failure", async () => {
    m.fetch.mockRejectedValue(new Error("unavailable"));
    expect(await recurringTrackingContext(subscription)).toBeNull(); expect(m.update).not.toHaveBeenCalled();
  });
  it("does not bind across a configuration change during lookup", async () => {
    m.resolve.mockResolvedValue({ ...tracking, trackingKey: "changed" });
    expect(await recurringTrackingContext(subscription)).toBeNull(); expect(m.update).not.toHaveBeenCalled();
  });
  it("accepts a concurrent identical verified binding, but not another subscription", async () => {
    m.update.mockResolvedValue({ count: 0 });
    m.find.mockResolvedValue({ kushkiSubscriptionId: subscription.subscriptionId, walletTrackingKey: tracking.trackingKey, walletTrackingMode: "production" });
    expect(await recurringTrackingContext(subscription)).toEqual(tracking);
    m.find.mockResolvedValue({ kushkiSubscriptionId: "replaced", walletTrackingKey: tracking.trackingKey, walletTrackingMode: "production" });
    expect(await recurringTrackingContext(subscription)).toBeNull();
  });
  it("does not contact the provider when tracking is unavailable or mode is mock", async () => {
    m.capture.mockResolvedValue(null); expect(await recurringTrackingContext(subscription)).toBeNull();
    m.mode.mockResolvedValue("mock"); expect(await recurringTrackingContext(subscription)).toBeNull();
    expect(m.fetch).not.toHaveBeenCalled();
  });
});
