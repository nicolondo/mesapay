import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ auth: vi.fn(), active: vi.fn(), account: vi.fn(), rate: vi.fn(), load: vi.fn() }));
vi.mock("@/auth", () => ({ auth: m.auth }));
vi.mock("@/lib/activeRestaurant", () => ({ getActiveRestaurantId: m.active }));
vi.mock("@/lib/platformWallet/config", () => ({ activeAccount: m.account }));
vi.mock("@/lib/rateLimit", () => ({ rateLimit: m.rate }));
vi.mock("@/lib/walletIncoming/service", () => ({ loadWalletIncoming: m.load }));
vi.mock("@/lib/secureApi", () => ({ secureApi: (handler: unknown) => handler }));

import { GET as adminGET } from "@/app/api/admin/wallet/incoming/route";
import { GET as merchantGET } from "@/app/api/operator/wallet/incoming/route";

const request = (scope: "admin" | "operator", id = scope === "admin" ? "wallet-a" : "tenant-a") =>
  new Request(`http://localhost/api/${scope}/wallet/incoming?${scope === "admin" ? "accountId" : "restaurantId"}=${id}`);

beforeEach(() => {
  vi.resetAllMocks();
  m.auth.mockResolvedValue({ user: { id: "u", role: "platform_admin" } });
  m.active.mockResolvedValue("tenant-a");
  m.account.mockResolvedValue({ id: "wallet-a" });
  m.rate.mockResolvedValue(true);
  m.load.mockResolvedValue({ status: "permission_required", localCharges: [], reportComplete: false });
});

describe("wallet reconciliation report access", () => {
  it("does not reveal platform collections to merchant or service roles", async () => {
    for (const role of ["operator", "group_admin", "waiter", "kitchen", "bar"]) {
      m.auth.mockResolvedValue({ user: { id: "u", role } });
      expect((await adminGET(request("admin"))).status).toBe(401);
    }
    expect(m.load).not.toHaveBeenCalled();
  });

  it("does not accept a restaurant identifier as authorization", async () => {
    for (const session of [null, { user: { id: "u", role: "waiter" } }]) {
      m.auth.mockResolvedValue(session);
      expect((await merchantGET(request("operator"))).status).toBe(401);
    }
    m.auth.mockResolvedValue({ user: { id: "u", role: "operator" } });
    expect((await merchantGET(request("operator", "someone-else"))).status).toBe(409);
    m.active.mockResolvedValue(null);
    expect((await merchantGET(request("operator"))).status).toBe(401);
    expect(m.load).not.toHaveBeenCalled();
  });

  it("requires an explicit current account and rejects a changed account before and after reading", async () => {
    expect((await adminGET(new Request("http://localhost/api/admin/wallet/incoming"))).status).toBe(400);
    expect((await adminGET(request("admin", "old-wallet"))).status).toBe(409);
    expect(m.load).not.toHaveBeenCalled();
    m.account.mockResolvedValueOnce({ id: "wallet-a" }).mockResolvedValueOnce({ id: "wallet-b" });
    expect((await adminGET(request("admin"))).status).toBe(409);
  });

  it("scopes merchant reads and rejects a changed restaurant", async () => {
    m.auth.mockResolvedValue({ user: { id: "u", role: "group_admin" } });
    m.active.mockResolvedValueOnce("tenant-a").mockResolvedValueOnce("tenant-b");
    expect((await merchantGET(request("operator"))).status).toBe(409);
    expect(m.load).toHaveBeenCalledWith({ kind: "merchant", restaurantId: "tenant-a" });
  });

  it("bounds provider report requests and never caches private report responses", async () => {
    m.rate.mockResolvedValue(false);
    expect((await merchantGET(request("operator"))).status).toBe(429);
    expect(m.load).not.toHaveBeenCalled();
    m.rate.mockResolvedValue(true);
    for (const [get, scope] of [[adminGET, "admin"], [merchantGET, "operator"]] as const) {
      const response = await get(request(scope));
      expect(response.status).toBe(200);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      expect(await response.json()).toMatchObject({ status: "permission_required", [scope === "admin" ? "accountId" : "restaurantId"]: scope === "admin" ? "wallet-a" : "tenant-a" });
    }
  });

  it("does not disclose database errors or provider secrets", async () => {
    m.load.mockRejectedValue(new Error("credential-private-value, database details"));
    for (const [get, scope] of [[adminGET, "admin"], [merchantGET, "operator"]] as const) {
      const response = await get(request(scope));
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: "incoming_unavailable" });
    }
  });
});
