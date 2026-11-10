import { beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock("@/lib/secureApi", () => ({ secureApi: (fn: unknown) => fn }));
vi.mock("@/lib/walletTracking/service", () => ({ runWalletTrackingBatch: m.run }));
import { POST } from "./route";

beforeEach(() => { vi.resetAllMocks(); vi.stubEnv("CRON_SECRET", "wallet-cron-test-secret"); });
describe("automatic wallet tracking", () => {
  it("requires the configured secret before reading balances or writing tracking records", async () => {
    for (const value of ["", "wrong", "wallet-cron-test-secret-extra"]) {
      expect((await POST(new Request("http://localhost/api/cron/wallet-tracking", { method: "POST", headers: { "x-cron-secret": value } }))).status).toBe(401);
    }
    vi.stubEnv("CRON_SECRET", "");
    expect((await POST(new Request("http://localhost/api/cron/wallet-tracking", { method: "POST" }))).status).toBe(401);
    expect(m.run).not.toHaveBeenCalled();
  });
  it("runs the bounded automatic batch and never caches its summary", async () => {
    m.run.mockResolvedValue({ scanned: 2, synced: 1, failed: 0, busy: 1, truncated: false });
    const response = await POST(new Request("http://localhost/api/cron/wallet-tracking", { method: "POST", headers: { "x-cron-secret": "wallet-cron-test-secret" } }));
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({ ok: true, scanned: 2, synced: 1, failed: 0, busy: 1, truncated: false });
    expect(m.run).toHaveBeenCalledTimes(1);
  });
  it("does not expose provider credentials or database errors", async () => {
    m.run.mockRejectedValue(new Error("sensitive provider credential"));
    const response = await POST(new Request("http://localhost/api/cron/wallet-tracking", { method: "POST", headers: { "x-cron-secret": "wallet-cron-test-secret" } }));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "tracking_unavailable" });
  });
});
