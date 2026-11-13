import { beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ get: vi.fn(), query: vi.fn(), update: vi.fn(), updateMany: vi.fn(), audit: vi.fn() }));
vi.mock("@/lib/db", () => { const tx = { $queryRaw: vi.fn(), platformPayout: { findUnique: m.get, findUniqueOrThrow: m.get, updateMany: m.updateMany, update: m.update }, auditEvent: { create: m.audit } }; return { db: { ...tx, $transaction: (fn: (client: typeof tx) => unknown) => fn(tx) } }; });
vi.mock("./config", () => ({ credentials: () => ({ privateKey: "private" }), webhookSecret: () => "secret" }));
vi.mock("./provider", () => ({ queryPayout: m.query }));
vi.mock("./service", () => ({ payoutDTO: (p: unknown) => p }));
vi.mock("@/lib/walletTracking/fingerprint", () => ({ walletAccountFingerprint: () => "verified-wallet-context" }));
import { authorizePlatformWebhook, refreshPlatformPayout } from "./status";
let row: Record<string, unknown>;
const result = { ticketNumber: "1234", transactionReference: "provider-ref", totalAmount: 1000, currency: "COP", bankId: "000051", metadata: { reference: "our-ref" }, transactionStatus: "APPROVAL", transactionType: "PAYOUT" };
beforeEach(() => {
  vi.clearAllMocks(); row = { id: "p1", account: {}, amountCents: BigInt(100000), reference: "our-ref", ticketNumber: "1234", providerRef: "provider-ref", bankId: "000051", status: "initialized", initStartedAt: new Date(), submissionLeaseUntil: new Date(Date.now() + 120000) };
  m.get.mockImplementation(async () => row); m.query.mockResolvedValue(result);
  m.update.mockImplementation(async ({ data }) => { row = { ...row, ...data }; return row; });
  m.updateMany.mockImplementation(async ({ data, where }) => {
    if ("ticketNumber" in where && where.ticketNumber !== row.ticketNumber) return { count: 0 };
    row = { ...row, ...data }; return { count: 1 };
  });
});
describe("verified payout reconciliation", () => {
  it("does not accept anonymous or incorrect callback bearer", async () => {
    await expect(authorizePlatformWebhook("p1", null)).rejects.toThrow("invalid_webhook");
    await expect(refreshPlatformPayout("p1", { authorization: "Bearer bad", ticket: "1234" })).rejects.toThrow("invalid_webhook");
    expect(m.query).not.toHaveBeenCalled();
  });
  it("fetches authority status then persists final state once", async () => {
    expect((await refreshPlatformPayout("p1")).status).toBe("approved");
    expect((await refreshPlatformPayout("p1")).status).toBe("approved");
    expect(m.query).toHaveBeenCalledTimes(1); expect(m.audit).toHaveBeenCalledTimes(1);
    expect(row.providerVerifiedAt).toBeInstanceOf(Date);
    expect(row.walletAccountFingerprint).toBe("verified-wallet-context");
  });
  it("rejects foreign tickets, amounts, currency and reference", async () => {
    for (const change of [{ ticketNumber: "9999" }, { totalAmount: 1 }, { currency: "MXN" }, { transactionReference: "foreign" }]) {
      m.query.mockResolvedValueOnce({ ...result, ...change });
      await expect(refreshPlatformPayout("p1")).rejects.toThrow("payout_status_mismatch");
    }
    expect(m.update).not.toHaveBeenCalled();
  });
  it("binds authenticated early callback only by stable metadata reference", async () => {
    row = { ...row, status: "unknown", ticketNumber: null, providerRef: null };
    m.query.mockResolvedValueOnce({ ...result, metadata: {} });
    await expect(refreshPlatformPayout("p1", { authorization: "Bearer secret", ticket: "1234" })).rejects.toThrow("payout_status_mismatch");
    expect((await refreshPlatformPayout("p1", { authorization: "Bearer secret", ticket: "1234" })).status).toBe("approved");
  });
  it("rechecks under lock when init stores identifiers during callback query", async () => {
    row = { ...row, status: "submitting", ticketNumber: null, providerRef: null };
    m.query.mockImplementationOnce(async () => { row = { ...row, status: "initialized", ticketNumber: "1234", providerRef: "provider-ref" }; return result; });
    expect((await refreshPlatformPayout("p1", { authorization: "Bearer secret", ticket: "1234" })).status).toBe("approved");
    expect(m.audit).toHaveBeenCalledTimes(1);
  });
  it("expires only preparation that never claimed provider initialization", async () => {
    row = { ...row, status: "submitting", ticketNumber: null, providerRef: null, initStartedAt: null, submissionLeaseUntil: new Date(Date.now() - 1000) };
    expect((await refreshPlatformPayout("p1")).errorCode).toBe("payout_not_sent"); expect(m.query).not.toHaveBeenCalled();
  });
  it("does not release an ambiguous initialization; manual ticket must match metadata", async () => {
    row = { ...row, status: "unknown", ticketNumber: null, providerRef: null, submissionLeaseUntil: new Date(0) };
    await expect(refreshPlatformPayout("p1")).rejects.toThrow("payout_status_unavailable");
    expect((await refreshPlatformPayout("p1", undefined, "1234")).status).toBe("approved");
  });
  it("keeps status unchanged for unsupported provider states", async () => {
    m.query.mockResolvedValueOnce({ ...result, transactionStatus: "UNRECOGNIZED" });
    await expect(refreshPlatformPayout("p1")).rejects.toThrow("payout_status_unavailable"); expect(m.update).not.toHaveBeenCalled();
  });
  it("checks explicitly supplied ticket even when own ticket is stored", async () => {
    await expect(refreshPlatformPayout("p1", undefined, "other")).rejects.toThrow("payout_status_mismatch");
    expect(m.query).not.toHaveBeenCalled();
  });
});
