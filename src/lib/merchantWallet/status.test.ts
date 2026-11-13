import { beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ find: vi.fn(), findFirst: vi.fn(), update: vi.fn(), updateMany: vi.fn(), query: vi.fn(), context: vi.fn(), audit: vi.fn() }));
vi.mock("@/lib/db", () => { const tx = { $queryRaw: vi.fn(), payout: { findUnique: m.find, findUniqueOrThrow: m.find, findFirst: m.findFirst, update: m.update, updateMany: m.updateMany }, auditEvent: { create: m.audit } }; return { db: { ...tx, $transaction: (fn: (t: typeof tx) => unknown) => fn(tx) } }; });
vi.mock("./context", () => ({ merchantWalletContext: m.context }));
vi.mock("./provider", () => ({ queryPayout: m.query }));
vi.mock("@/lib/crypto", () => ({ decrypt: () => "secret" }));
import { authorizeMerchantWebhook, refreshMerchantPayout } from "./status";
const original = { id: "p1", restaurantId: "r1", idempotencyKey: "key", walletAccountFingerprint: "frozen", sourceMode: "sandbox", webhookSecretEnc: "enc", amountCents: 100000, currency: "COP", reference: "ours", bankId: "51", ticketNumber: "ticket", providerRef: "reference", status: "initialized", initStartedAt: new Date(), submissionLeaseUntil: new Date(Date.now() + 120000), providerVerifiedAt: null, responseText: null, createdAt: new Date(), settledAt: null };
const verified = { ticketNumber: "ticket", transactionReference: "reference", totalAmount: 1000, currency: "COP", bankId: "51", transactionType: "PAYOUT", transactionStatus: "APPROVED", metadata: { reference: "ours" } };
let row: Record<string, unknown>;
beforeEach(() => { vi.clearAllMocks(); row = { ...original }; m.find.mockImplementation(async () => row); m.findFirst.mockResolvedValue(null); m.update.mockImplementation(async ({ data }) => { row = { ...row, ...data }; return row; }); m.updateMany.mockImplementation(async ({ data }) => { row = { ...row, ...data }; return { count: 1 }; }); m.context.mockResolvedValue({ credentials: { mode: "sandbox" }, currency: "COP", fingerprint: "frozen" }); m.query.mockResolvedValue(verified); });
describe("merchant payouts require verified provider status", () => {
  it("authorizes exactly one merchant callback without accepting token reuse", async () => {
    expect(await authorizeMerchantWebhook("p1", "Bearer secret")).toBe("r1");
    await expect(refreshMerchantPayout("r1", "p1", { authorization: "Bearer other", ticket: "ticket" })).rejects.toThrow("invalid_webhook");
    expect(m.query).not.toHaveBeenCalled();
  });
  it("rejects forged headers and legacy rows before network access", async () => {
    await expect(authorizeMerchantWebhook("p1", "Bearer fake")).rejects.toThrow("invalid_webhook");
    row.webhookSecretEnc = null; await expect(authorizeMerchantWebhook("p1", "Bearer secret")).rejects.toThrow("invalid_webhook");
    await expect(refreshMerchantPayout("r1", "p1")).rejects.toThrow("payout_legacy_unverified"); expect(m.query).not.toHaveBeenCalled();
  });
  it("records only server verified status and preserves one terminal audit", async () => {
    m.query.mockResolvedValue({ ...verified, transactionStatus: "DECLINED" });
    const result = await refreshMerchantPayout("r1", "p1", { authorization: "Bearer secret", ticket: "ticket" });
    expect(result.status).toBe("declined"); expect(row.providerVerifiedAt).toBeInstanceOf(Date);
    await refreshMerchantPayout("r1", "p1"); expect(m.audit).toHaveBeenCalledTimes(1); expect(m.query).toHaveBeenCalledTimes(1);
  });
  it.each([{ ticketNumber: "other" }, { transactionReference: "other" }, { totalAmount: 999 }, { currency: "MXN" }, { transactionType: "PAYMENT" }, { bankId: "52" }, { metadata: { reference: "other" } }])("rejects mismatched remote identity %j", async (patch) => {
    m.query.mockResolvedValue({ ...verified, ...patch }); await expect(refreshMerchantPayout("r1", "p1")).rejects.toThrow("payout_status_mismatch"); expect(m.update).not.toHaveBeenCalled();
  });
  it("requires own metadata when binding an early callback ticket", async () => {
    row.ticketNumber = null; row.providerRef = null; row.status = "unknown";
    m.query.mockResolvedValueOnce({ ...verified, metadata: undefined });
    await expect(refreshMerchantPayout("r1", "p1", { authorization: "Bearer secret", ticket: "ticket" })).rejects.toThrow("payout_status_mismatch");
    expect((await refreshMerchantPayout("r1", "p1", { authorization: "Bearer secret", ticket: "ticket" })).status).toBe("approved");
  });
  it("rejects another tenant and changed account before and after GET", async () => {
    await expect(refreshMerchantPayout("other", "p1")).rejects.toThrow("payout_not_found"); expect(m.query).not.toHaveBeenCalled();
    m.context.mockResolvedValueOnce({ fingerprint: "changed" }); await expect(refreshMerchantPayout("r1", "p1")).rejects.toThrow("account_changed");
    m.context.mockResolvedValueOnce({ fingerprint: "frozen", credentials: { mode: "sandbox" }, currency: "COP" }).mockResolvedValueOnce({ fingerprint: "changed" });
    await expect(refreshMerchantPayout("r1", "p1")).rejects.toThrow("account_changed"); expect(m.update).not.toHaveBeenCalled();
  });
  it("rereads identifiers after remote query and rejects concurrent conflicting init", async () => {
    m.query.mockImplementation(async () => { row.providerRef = "other"; return verified; });
    await expect(refreshMerchantPayout("r1", "p1")).rejects.toThrow("payout_status_mismatch"); expect(m.update).not.toHaveBeenCalled();
  });
  it("never treats an unknown provider status as approved", async () => {
    m.query.mockResolvedValue({ ...verified, transactionStatus: "not_approved" }); await expect(refreshMerchantPayout("r1", "p1")).rejects.toThrow("payout_status_unavailable");
  });
  it("rejects conflicting callback tickets before GET and reused provider identities after GET", async () => {
    await expect(refreshMerchantPayout("r1", "p1", { authorization: "Bearer secret", ticket: "other" })).rejects.toThrow("payout_status_mismatch"); expect(m.query).not.toHaveBeenCalled();
    m.findFirst.mockResolvedValueOnce({ id: "another-payout" }); await expect(refreshMerchantPayout("r1", "p1")).rejects.toThrow("payout_status_mismatch"); expect(m.update).not.toHaveBeenCalled();
  });
  it("does not add an audit or terminal verification for unchanged initialized status", async () => {
    m.query.mockResolvedValue({ ...verified, transactionStatus: "INITIALIZED" });
    expect((await refreshMerchantPayout("r1", "p1")).status).toBe("initialized"); expect(m.update).not.toHaveBeenCalled(); expect(row.providerVerifiedAt).toBeNull();
    row = { ...row, status: "unknown", ticketNumber: null, providerRef: null };
    expect((await refreshMerchantPayout("r1", "p1", { authorization: "Bearer secret", ticket: "ticket" })).status).toBe("initialized"); expect(row.providerVerifiedAt).toBeNull();
  });
  it("does not regress a terminal callback completed while another GET was running", async () => {
    m.query.mockImplementationOnce(async () => { row = { ...row, status: "declined", providerVerifiedAt: new Date() }; return verified; });
    expect((await refreshMerchantPayout("r1", "p1")).status).toBe("declined"); expect(m.update).not.toHaveBeenCalled();
  });
  it("expires an unsent lease but preserves ambiguity after init started", async () => {
    row = { ...row, status: "submitting", initStartedAt: null, ticketNumber: null, submissionLeaseUntil: new Date(0) };
    expect((await refreshMerchantPayout("r1", "p1")).status).toBe("failed"); expect(m.query).not.toHaveBeenCalled();
    row = { ...original, status: "submitting", ticketNumber: null, submissionLeaseUntil: new Date(0) };
    await expect(refreshMerchantPayout("r1", "p1")).rejects.toThrow("payout_status_unavailable"); expect(row.status).not.toBe("failed");
  });
  it("rereads when another worker claims init as the lease expires", async () => {
    row = { ...row, status: "submitting", initStartedAt: null, submissionLeaseUntil: new Date(0) };
    m.updateMany.mockImplementationOnce(async () => { row.initStartedAt = new Date(); return { count: 0 }; });
    expect((await refreshMerchantPayout("r1", "p1")).status).toBe("approved"); expect(m.query).toHaveBeenCalledTimes(1);
  });
});
