import { beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ find: vi.fn(), decrypt: vi.fn(), mode: vi.fn(), currency: vi.fn(), fingerprint: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: { restaurant: { findUnique: m.find } } }));
vi.mock("@/lib/crypto", () => ({ decrypt: m.decrypt }));
vi.mock("@/lib/platformConfig", () => ({ getRestaurantKushkiMode: m.mode }));
vi.mock("@/lib/billing/countries", () => ({ getCurrencyForCountry: m.currency }));
vi.mock("@/lib/walletTracking/fingerprint", () => ({ walletAccountFingerprint: m.fingerprint }));
import { merchantWalletContext, merchantWalletLock } from "./context";
import type { Prisma } from "@prisma/client";
const tenant = { kushkiMerchantId: "merchant", kushkiMode: "sandbox", country: "MX", bankInfo: {}, kushkiPublicKey: "collection-public", kushkiPrivateKeyEnc: "collection-private", kushkiPayoutPublicKey: "payout-public", kushkiPayoutPrivateKeyEnc: "payout-private" };
beforeEach(() => { vi.clearAllMocks(); m.find.mockResolvedValue(tenant); m.mode.mockResolvedValue("sandbox"); m.currency.mockResolvedValue("MXN"); m.decrypt.mockImplementation((s) => `decrypted-${s}`); m.fingerprint.mockReturnValue("hash"); });
describe("merchant payout account context", () => {
  it("serializes reservations with a restaurant-specific lock key", async () => {
    const query = vi.fn(); await merchantWalletLock({ $queryRaw: query } as unknown as Prisma.TransactionClient, "r1");
    expect(query.mock.calls[0][1]).toBe("merchant-wallet:r1");
  });
  it("freezes effective payout pair, mode and existing country currency", async () => {
    expect(await merchantWalletContext("r1")).toMatchObject({ credentials: { mode: "sandbox", publicKey: "payout-public", privateKey: "decrypted-payout-private" }, fingerprint: "hash", currency: "MXN" });
    expect(m.find.mock.calls[0][0].where).toEqual({ id: "r1" });
  });
  it("preserves collection fallback only when a complete payout pair was never configured", async () => {
    m.find.mockResolvedValue({ ...tenant, kushkiPayoutPrivateKeyEnc: null });
    expect((await merchantWalletContext("r1")).credentials.publicKey).toBe("collection-public");
    expect(m.decrypt).toHaveBeenCalledWith("collection-private");
  });
  it("does not fall back to collection after decryption failure", async () => {
    m.decrypt.mockImplementation(() => { throw new Error("sensitive ciphertext"); });
    await expect(merchantWalletContext("r1")).rejects.toThrow("credentials_unavailable"); expect(m.decrypt).toHaveBeenCalledTimes(1);
  });
  it("fails closed for missing tenant, merchant or credentials and mock mode", async () => {
    m.find.mockResolvedValueOnce(null); await expect(merchantWalletContext("r1")).rejects.toThrow("not_onboarded");
    m.find.mockResolvedValueOnce({ ...tenant, kushkiMerchantId: null }); await expect(merchantWalletContext("r1")).rejects.toThrow("not_onboarded");
    m.mode.mockResolvedValueOnce("mock"); await expect(merchantWalletContext("r1")).rejects.toThrow("credentials_missing");
    m.find.mockResolvedValueOnce({ ...tenant, kushkiPayoutPublicKey: null, kushkiPrivateKeyEnc: null }); await expect(merchantWalletContext("r1")).rejects.toThrow("credentials_missing");
    m.decrypt.mockReturnValueOnce(""); await expect(merchantWalletContext("r1")).rejects.toThrow("credentials_missing");
  });
});
