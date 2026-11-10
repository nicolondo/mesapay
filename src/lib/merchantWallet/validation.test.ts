import { describe, expect, it } from "vitest";
import { merchantPayoutSchema, merchantStatusMatches } from "./validation";
const payout = { amountCents: 100000, currency: "MXN", reference: "ours", ticketNumber: "ticket", providerRef: "ref", bankId: "51" };
const status = { ticketNumber: "ticket", transactionReference: "ref", totalAmount: 1000, currency: "MXN", bankId: "51", transactionType: "PAYOUT", transactionStatus: "APPROVED" };
describe("merchant payout validation", () => {
  it("accepts the stored currency rather than imposing COP", () => { expect(merchantStatusMatches(payout, status)).toBe(true); });
  it.each([1000.001, Number.MAX_SAFE_INTEGER, -1])("rejects non-cent-exact or unsafe provider amount %s", (totalAmount) => { expect(merchantStatusMatches(payout, { ...status, totalAmount })).toBe(false); });
  it("requires persisted reference and bank", () => { expect(merchantStatusMatches({ ...payout, reference: null }, status)).toBe(false); expect(merchantStatusMatches({ ...payout, bankId: null }, status)).toBe(false); });
  it("refuses numbers that cannot be persisted, unsafe destinations and extra input", () => {
    const input = { restaurantId: "r1", idempotencyKey: "89fcb4e0-414a-4505-937d-bd716f6c3660", amountCents: 10000, ownDestinationFingerprint: "f".repeat(64) };
    expect(merchantPayoutSchema.safeParse(input).success).toBe(true);
    expect(merchantPayoutSchema.safeParse({ ...input, amountCents: 2147483648 }).success).toBe(false);
    expect(merchantPayoutSchema.safeParse({ ...input, amountCents: 100.5 }).success).toBe(false);
    expect(merchantPayoutSchema.safeParse({ ...input, status: "approved" }).success).toBe(false);
  });
});
