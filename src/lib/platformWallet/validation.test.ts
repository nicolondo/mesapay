import { describe, expect, it } from "vitest";
import { configSchema, payoutSchema, payloadFingerprint, statusMatches, safeCents, callbackTicket, verifyWebhookToken } from "./validation";

const input = { accountId: "account-1", idempotencyKey: "89fcb4e0-414a-4505-937d-bd716f6c3660", amountCents: 100000,
  destination: { bankId: "000051", accountType: "ahorros", accountNumber: "123456789", docType: "CC", docNumber: "12345678", holderName: "Test Person" }, confirmed: true };
const payout = { amountCents: BigInt(100000), reference: "platform-ref", ticketNumber: "1234", providerRef: "provider-ref", bankId: "000051" };
const status = { ticketNumber: "1234", transactionReference: "provider-ref", totalAmount: 1000, currency: "COP", bankId: "000051", metadata: { reference: "platform-ref" }, transactionStatus: "APPROVAL", transactionType: "PAYOUT" };
describe("platform wallet validation", () => {
  it("requires confirmation, supported COP bounds, safe integers and complete recipient", () => {
    expect(payoutSchema.safeParse(input).success).toBe(true);
    for (const amountCents of [0, 99999, 1390000000001, 100000.5, Infinity]) expect(payoutSchema.safeParse({ ...input, amountCents }).success).toBe(false);
    expect(payoutSchema.safeParse({ ...input, confirmed: false }).success).toBe(false);
    expect(payoutSchema.safeParse({ ...input, destination: { ...input.destination, accountNumber: "abc123" } }).success).toBe(false);
    expect(payoutSchema.safeParse({ ...input, restaurantId: "r1" }).success).toBe(false);
  });
  it("rejects mock/global config and excessive secret values", () => {
    expect(configSchema.safeParse({ label: "Wallet", mode: "sandbox", publicKey: "public" }).success).toBe(true);
    expect(configSchema.safeParse({ label: "Wallet", mode: "mock", publicKey: "public" }).success).toBe(false);
    expect(configSchema.safeParse({ label: "Wallet", mode: "sandbox", publicKey: "public", privateKey: "x".repeat(501) }).success).toBe(false);
  });
  it("fingerprints all beneficiary fields and amount but not request key", () => {
    const parsed = payoutSchema.parse(input);
    expect(payloadFingerprint(parsed)).toBe(payloadFingerprint({ ...parsed, idempotencyKey: "90fcb4e0-414a-4505-937d-bd716f6c3660" }));
    expect(payloadFingerprint(parsed)).not.toBe(payloadFingerprint({ ...parsed, amountCents: 200000 }));
    expect(payloadFingerprint(parsed)).not.toBe(payloadFingerprint({ ...parsed, destination: { ...parsed.destination, accountNumber: "999999999" } }));
  });
  it("matches identity, amount, currency and payout type before applying provider status", () => {
    expect(statusMatches(payout, status)).toBe(true);
    for (const change of [{ totalAmount: 999 }, { currency: "MXN" }, { transactionReference: "other" }, { ticketNumber: "other" }, { transactionType: "CHARGE" }, { bankId: "other" }]) expect(statusMatches(payout, { ...status, ...change })).toBe(false);
    expect(statusMatches(payout, { ...status, metadata: {} })).toBe(true);
  });
  it("requires stable metadata reference for early callback binding", () => {
    const unbound = { ...payout, ticketNumber: null, providerRef: null };
    expect(statusMatches(unbound, status)).toBe(true);
    expect(statusMatches(unbound, { ...status, metadata: {} })).toBe(false);
    expect(statusMatches(unbound, { ...status, metadata: { reference: "someone-else" } })).toBe(false);
  });
  it("converts BigInt only when safe", () => {
    expect(safeCents(BigInt(1390000000000))).toBe(1390000000000);
    expect(() => safeCents(BigInt(Number.MAX_SAFE_INTEGER) + BigInt(1))).toThrow();
  });
  it("accepts exact authenticated webhook secrets and bounded ticket strings", () => {
    expect(verifyWebhookToken("Bearer abc", "abc")).toBe(true);
    expect(verifyWebhookToken("Bearer abd", "abc")).toBe(false);
    expect(verifyWebhookToken(null, "abc")).toBe(false);
    expect(callbackTicket({ ticketNumber: "1234" })).toBe("1234");
    expect(callbackTicket({ ticketNumber: 1234 })).toBeNull();
    expect(callbackTicket({ ticketNumber: "../secrets" })).toBeNull();
  });
});
