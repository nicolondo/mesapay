import { describe, expect, it, vi } from "vitest";
vi.mock("@/lib/env", () => ({ requireSecretKey: () => "ab".repeat(32) }));
import { walletAccountFingerprint, trackingFingerprint } from "./fingerprint";
const creds = { mode: "production" as const, publicKey: "public", privateKey: "secret" };
describe("versioned wallet identity", () => {
  it("is deterministic and does not contain credentials", () => {
    const fingerprint = walletAccountFingerprint(creds);
    expect(fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(fingerprint).toBe(walletAccountFingerprint(creds));
    expect(fingerprint).not.toContain("secret");
  });
  it("separates key rotation and sandbox", () => {
    expect(walletAccountFingerprint({ ...creds, privateKey: "rotated" })).not.toBe(walletAccountFingerprint(creds));
    expect(walletAccountFingerprint({ ...creds, mode: "sandbox" })).not.toBe(walletAccountFingerprint(creds));
  });
  it("separates owners, collection accounts, and currencies", () => {
    const first = trackingFingerprint({ scopeKey: "platform", mode: "production", currency: "COP", collection: "c", payout: "p" });
    for (const change of [{ scopeKey: "restaurant:r" }, { collection: "other" }, { currency: "MXN" }]) {
      expect(trackingFingerprint({ scopeKey: "platform", mode: "production", currency: "COP", collection: "c", payout: "p", ...change })).not.toBe(first);
    }
  });
});
