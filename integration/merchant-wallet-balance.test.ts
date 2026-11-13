import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { db } from "../src/lib/db";
import { encrypt } from "../src/lib/crypto";
import { GET } from "../src/app/api/operator/wallet/balance/route";

const session = vi.hoisted(() => {
  process.env.MESAPAY_SECRET_KEY = "ab".repeat(32);
  return { role: "operator" as string | null, restaurantId: "", cookie: "" };
});
vi.mock("../src/auth", () => ({ auth: async () => session.role ? { user: { id: "wallet-local-test", role: session.role, restaurantId: session.restaurantId } } : null }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => session.cookie ? { value: session.cookie } : undefined }) }));
vi.mock("../src/lib/rateLimit", () => ({ rateLimit: async () => true }));
const database = new URL(process.env.DATABASE_URL ?? "postgresql://localhost/invalid");
if (!["localhost", "127.0.0.1"].includes(database.hostname) || !/^\/mesapay_.*(?:test|validation)$/.test(database.pathname)) throw new Error("Isolated local test database required");
const fetchMock = vi.fn<typeof fetch>();
let ownId = "";
let otherId = "";
const request = () => new Request(`http://localhost/api/operator/wallet/balance?restaurantId=${otherId}`);

beforeAll(async () => {
  const uid = randomUUID();
  const rows = await Promise.all(["own", "other"].map(scope => db.restaurant.create({ data: {
    name: `Wallet ${scope} fixture`, slug: `wallet-balance-${scope}-${uid}`, country: "CO", kushkiMode: "sandbox",
    kushkiMerchantId: `merchant-${scope}`, kushkiPrivateKeyEnc: encrypt(`collections-${scope}`),
    kushkiPayoutPublicKey: `payout-public-${scope}`, kushkiPayoutPrivateKeyEnc: encrypt(`payout-private-${scope}`),
  } })));
  [ownId, otherId] = rows.map(row => row.id);
  vi.stubGlobal("fetch", fetchMock);
});
beforeEach(() => {
  session.role = "operator"; session.restaurantId = ownId; session.cookie = otherId;
  fetchMock.mockReset().mockImplementation(async (url, init) => {
    expect(String(url)).toBe("https://api-uat.kushkipagos.com/wallet/v1/merchant/balance");
    const key = new Headers(init?.headers).get("Private-Merchant-Id");
    expect(["payout-private-own", "payout-private-other"]).toContain(key);
    return new Response(JSON.stringify({ currentBalance: key === "payout-private-own" ? 1000 : 9000, currency: "COP" }), { status: 200 });
  });
});
afterAll(async () => {
  await db.restaurant.deleteMany({ where: { id: { in: [ownId, otherId] } } });
  vi.unstubAllGlobals();
  await db.$disconnect();
});

describe("merchant wallet balance isolation and unknown incoming funds", () => {
  it("uses only the operator's payout account even if a different restaurant is supplied", async () => {
    const response = await GET(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ availableCents: 100000, pendingCents: null, pendingStatus: "not_reported", pendingUpdatedAt: null, currency: "COP" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(new Headers(fetchMock.mock.calls[0][1]?.headers).get("Private-Merchant-Id")).toBe("payout-private-own");
  });
  it("selects the impersonated account only for the platform administrator", async () => {
    session.role = "platform_admin";
    const response = await GET(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ availableCents: 900000, pendingCents: null, pendingStatus: "not_reported" });
    expect(new Headers(fetchMock.mock.calls[0][1]?.headers).get("Private-Merchant-Id")).toBe("payout-private-other");
  });
  it("does not expose balances to unauthenticated users or restaurant staff", async () => {
    for (const role of [null, "mesero", "chef"]) {
      session.role = role;
      expect((await GET(request())).status).toBe(401);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("does not turn missing onboarding into a confirmed zero incoming balance", async () => {
    await db.restaurant.update({ where: { id: ownId }, data: { kushkiMerchantId: null } });
    try {
      const response = await GET(request());
      expect(await response.json()).toMatchObject({ onboarded: false, pendingCents: null, pendingStatus: "not_reported", pendingUpdatedAt: null });
      expect(fetchMock).not.toHaveBeenCalled();
    } finally { await db.restaurant.update({ where: { id: ownId }, data: { kushkiMerchantId: "merchant-own" } }); }
  });
  it("keeps unavailable balance responses as errors", async () => {
    fetchMock.mockResolvedValueOnce(new Response('{"code":"WLT400"}', { status: 403 }));
    const response = await GET(request());
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ error: "balance_failed" });
  });
});
