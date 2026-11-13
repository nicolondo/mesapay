import { beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ fetch: vi.fn(), credentials: vi.fn(), capture: vi.fn() }));
vi.mock("./client", () => ({ kushkiFetch: m.fetch }));
vi.mock("@/lib/platformConfig", () => ({ getBillingCredentials: m.credentials, getKushkiMode: async () => "production" }));
vi.mock("@/lib/walletTracking/context", () => ({ captureWalletTrackingContext: m.capture }));
import { LiveSubscriptionProvider } from "./subscriptionLive";
const tracking = { trackingKey: "opaque-tracking-key", mode: "production", currency: "COP" };
beforeEach(() => { vi.resetAllMocks(); m.credentials.mockResolvedValue({ privateKey: "effective-test-key" }); m.capture.mockResolvedValue(tracking); });
describe("subscription collection tracking context", () => {
  it("captures the same credential and mode sent to the provider before a successful charge", async () => {
    m.fetch.mockImplementation(async (_path, options) => {
      expect(m.capture).toHaveBeenCalledWith({ kind: "platform" }, { mode: "production", currency: "COP", collectionPrivateKey: "effective-test-key" });
      expect(options.auth.privateKey).toBe("effective-test-key");
      expect(options.body).not.toHaveProperty("tracking");
      return { transactionReference: "real-charge-ref" };
    });
    const result = await new LiveSubscriptionProvider("production").chargeSubscriptionNow({ subscriptionId: "subscription-a", amountCents: 10000, currency: "COP" });
    expect(result).toMatchObject({ status: "approved", tracking });
  });
  it("keeps the future recurring subscription binding even when there is no initial charge", async () => {
    m.fetch.mockResolvedValue({ subscriptionId: "subscription-b", card: {} });
    const result = await new LiveSubscriptionProvider("production").createCardSubscription({ token: "opaque-token", amountCents: 10000, currency: "COP", planName: "pro", startDateIso: "2026-12-10", contactDetails: { firstName: "Test", lastName: "User", email: "test@example.test" } });
    expect(result).toMatchObject({ subscriptionId: "subscription-b", tracking });
  });
  it("does not invent a binding when a wallet is not configured", async () => {
    m.capture.mockResolvedValue(null); m.fetch.mockResolvedValue({ ticketNumber: "approved-reference" });
    expect(await new LiveSubscriptionProvider("production").chargeSubscriptionNow({ subscriptionId: "subscription-a", amountCents: 10000, currency: "COP" })).toEqual({ status: "approved", transactionId: "approved-reference" });
  });
});
