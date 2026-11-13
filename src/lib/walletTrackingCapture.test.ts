import { beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ capture: vi.fn() }));
vi.mock("@/lib/walletTracking/context", () => ({ captureWalletTrackingContext: m.capture }));
import { capturePaymentTrackingFields, captureLinkTrackingFields, captureDepositTrackingFields } from "./walletTrackingCapture";
const input = { restaurantId: "tenant-a", mode: "production" as const, currency: "COP", privateKey: "test-private-credential" };
beforeEach(() => { vi.resetAllMocks(); m.capture.mockResolvedValue({ trackingKey: "opaque-binding", mode: "production", currency: "COP" }); });
describe("capture the context actually used for a charge", () => {
  it("passes the effective provider context but persists no credential", async () => {
    expect(await capturePaymentTrackingFields(input)).toEqual({ walletTrackingKey: "opaque-binding", walletTrackingMode: "production", walletTrackingCurrency: "COP" });
    expect(m.capture).toHaveBeenCalledWith({ kind: "merchant", restaurantId: "tenant-a" }, { mode: "production", currency: "COP", collectionPrivateKey: "test-private-credential" });
    expect(await captureLinkTrackingFields(input)).toEqual({ walletTrackingKey: "opaque-binding", walletTrackingMode: "production" });
    expect(await captureDepositTrackingFields(input)).toEqual({ depositTrackingKey: "opaque-binding", depositSourceMode: "production", depositCurrency: "COP" });
  });
  it("leaves unsupported/unconfigured charges unbound instead of guessing a wallet or currency", async () => {
    m.capture.mockResolvedValue(null);
    for (const capture of [capturePaymentTrackingFields, captureLinkTrackingFields, captureDepositTrackingFields]) expect(await capture(input)).toEqual({});
  });
  it("binds terminal collections to the business code actually used by the terminal", async () => {
    await capturePaymentTrackingFields({ restaurantId: "tenant-a", mode: "production", currency: "COP", terminalBusinessCode: "actual-terminal-account" });
    expect(m.capture).toHaveBeenCalledWith({ kind: "merchant", restaurantId: "tenant-a" }, { mode: "production", currency: "COP", terminalBusinessCode: "actual-terminal-account" });
  });
});
