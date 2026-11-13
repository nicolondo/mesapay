import { beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ findUnique: vi.fn(), findFirst: vi.fn(), create: vi.fn(), updateMany: vi.fn(), audit: vi.fn(), context: vi.fn(), banks: vi.fn(), token: vi.fn(), init: vi.fn(), rejected: vi.fn() }));
vi.mock("@/lib/db", () => { const tx = { $queryRaw: vi.fn(), payout: { findUnique: m.findUnique, findFirst: m.findFirst, create: m.create, updateMany: m.updateMany }, auditEvent: { create: m.audit } }; return { db: { ...tx, $transaction: (fn: (t: typeof tx) => unknown) => fn(tx) } }; });
vi.mock("./context", () => ({ merchantWalletContext: m.context, merchantWalletLock: vi.fn() }));
vi.mock("./provider", () => ({ merchantBanks: m.banks, tokenizeMerchantPayout: m.token, initializePayout: m.init, definiteInitRejection: m.rejected }));
vi.mock("@/lib/crypto", () => ({ encrypt: () => "encrypted-secret", decrypt: () => "secret" }));
vi.mock("@/lib/env", () => ({ env: { APP_PUBLIC_BASE_URL: "https://example.test" }, requireSecretKey: () => "11".repeat(32) }));
import { submitMerchantPayout } from "./service";
import { ownDestinationFingerprint } from "./ownDestination";
const input = { restaurantId: "r1", idempotencyKey: "89fcb4e0-414a-4505-937d-bd716f6c3660", amountCents: 100000, destination: { bankId: "51", bankName: "Bank", accountType: "ahorros" as const, accountNumber: "123456789", docType: "CC" as const, docNumber: "12345678", holderName: "Test Person" } };
const actor = { id: "admin", email: "admin@example.test", role: "operator" };
const context = { credentials: { mode: "sandbox", publicKey: "public", privateKey: "private" }, fingerprint: "frozen", currency: "COP", bankInfo: { bankName: "Bank", accountType: "ahorros", accountNumber: "123456789", holderDocType: "CC", holderDocNumber: "12345678", holderName: "Test Person" } };
let row: Record<string, unknown> | null;
beforeEach(() => {
  vi.clearAllMocks(); row = null; m.context.mockResolvedValue(context); m.findUnique.mockImplementation(async () => row); m.findFirst.mockResolvedValue(null);
  m.create.mockImplementation(async ({ data }) => { row = { ...data, id: "p1", createdAt: new Date(), settledAt: null, ticketNumber: null, providerRef: null, responseText: null, providerVerifiedAt: null, initStartedAt: null }; return row; });
  m.updateMany.mockImplementation(async ({ data, where }) => { if (row && (!where.status || row.status === where.status || where.status.in?.includes(row.status))) { row = { ...row, ...data }; return { count: 1 }; } return { count: 0 }; });
  m.banks.mockResolvedValue([{ id: "51", name: "Bank" }]); m.token.mockResolvedValue("token"); m.init.mockResolvedValue({ ticketNumber: "ticket", providerRef: "reference" }); m.rejected.mockReturnValue(false);
});
describe("merchant payout durable submission", () => {
  it("reserves before token/init, freezes account and never persists full bank/document", async () => {
    m.token.mockImplementation(async () => { expect(row?.status).toBe("submitting"); return "token"; });
    expect((await submitMerchantPayout("r1", input, actor)).status).toBe("initialized");
    expect(row).toMatchObject({ walletAccountFingerprint: "frozen", sourceMode: "sandbox", bankId: "51" });
    expect(JSON.stringify(m.create.mock.calls)).not.toContain("123456789"); expect(JSON.stringify(m.create.mock.calls)).not.toContain("12345678");
    expect(m.init.mock.calls[0][1].webhookUrl).toBe("https://example.test/api/webhooks/kushki-payout?payoutId=p1");
  });
  it("replays without config lookup or another send", async () => {
    await submitMerchantPayout("r1", input, actor); m.context.mockClear();
    await submitMerchantPayout("r1", input, actor); expect(m.init).toHaveBeenCalledTimes(1); expect(m.context).not.toHaveBeenCalled();
  });
  it("rejects changed payload and cross-tenant UUID", async () => {
    await submitMerchantPayout("r1", input, actor);
    await expect(submitMerchantPayout("r1", { ...input, amountCents: 200000 }, actor)).rejects.toThrow("idempotency_conflict");
    await expect(submitMerchantPayout("r2", { ...input, restaurantId: "r2" }, actor)).rejects.toThrow("idempotency_conflict");
    expect(m.init).toHaveBeenCalledTimes(1);
  });
  it("rejects stale tenant, invalid input, or another uncertain attempt", async () => {
    await expect(submitMerchantPayout("r2", input, actor)).rejects.toThrow("tenant_changed");
    await expect(submitMerchantPayout("r1", { ...input, idempotencyKey: "bad" }, actor)).rejects.toThrow("invalid_payload");
    m.findFirst.mockResolvedValue({ id: "other" }); await expect(submitMerchantPayout("r1", input, actor)).rejects.toThrow("payout_in_progress"); expect(m.token).not.toHaveBeenCalled();
  });
  it("keeps timeouts unknown and never resubmits", async () => {
    m.init.mockRejectedValueOnce(new Error("private secret timeout"));
    expect((await submitMerchantPayout("r1", input, actor)).status).toBe("unknown");
    expect((await submitMerchantPayout("r1", input, actor)).responseText).toBe("payout_unknown");
    expect(m.init).toHaveBeenCalledTimes(1); expect(JSON.stringify(row)).not.toContain("private secret timeout");
  });
  it("does not overwrite an authenticated callback during init", async () => {
    m.init.mockImplementation(async () => { row = { ...row, status: "approved", providerVerifiedAt: new Date() }; return { ticketNumber: "ticket", providerRef: "reference" }; });
    expect((await submitMerchantPayout("r1", input, actor)).status).toBe("approved");
  });
  it("fails safely before init for token errors and rotated credentials", async () => {
    m.token.mockRejectedValueOnce(new Error("secret")); expect((await submitMerchantPayout("r1", input, actor)).responseText).toBe("payout_token_failed"); expect(m.init).not.toHaveBeenCalled();
    row = null; m.context.mockResolvedValueOnce(context).mockResolvedValueOnce({ ...context, fingerprint: "changed" });
    expect((await submitMerchantPayout("r1", input, actor)).responseText).toBe("account_changed"); expect(m.init).not.toHaveBeenCalled();
  });
  it("marks a definitive rejected init failed", async () => {
    m.init.mockRejectedValueOnce(new Error("declined")); m.rejected.mockReturnValue(true);
    expect((await submitMerchantPayout("r1", input, actor)).status).toBe("failed");
  });
  it("cannot claim expired preparation lease", async () => {
    m.updateMany.mockImplementation(async ({ data }) => { if (data.initStartedAt) return { count: 0 }; row = { ...row, ...data }; return { count: 1 }; });
    await submitMerchantPayout("r1", input, actor); expect(m.init).not.toHaveBeenCalled();
  });
  it("resolves own bank uniquely and rejects ambiguous/unknown names", async () => {
    const own = { ...input, destination: undefined, ownDestinationFingerprint: ownDestinationFingerprint(context.bankInfo) };
    expect((await submitMerchantPayout("r1", own, actor)).status).toBe("initialized");
    row = null; m.banks.mockResolvedValue([{ id: "51", name: "Bank" }, { id: "52", name: "Bank" }]);
    expect((await submitMerchantPayout("r1", own, actor)).responseText).toBe("invalid_bank"); expect(m.init).toHaveBeenCalledTimes(1);
  });
  it("requires the displayed own destination and rejects changes before reservation or init", async () => {
    const own = { ...input, destination: undefined, ownDestinationFingerprint: ownDestinationFingerprint(context.bankInfo) };
    await expect(submitMerchantPayout("r1", { ...own, ownDestinationFingerprint: undefined }, actor)).rejects.toThrow("invalid_payload");
    m.context.mockResolvedValueOnce({ ...context, bankInfo: { ...context.bankInfo, accountNumber: "987654321" } });
    await expect(submitMerchantPayout("r1", own, actor)).rejects.toThrow("own_destination_changed"); expect(m.create).not.toHaveBeenCalled();
    m.context.mockResolvedValueOnce(context).mockResolvedValueOnce({ ...context, bankInfo: { ...context.bankInfo, accountNumber: "987654321" } });
    expect((await submitMerchantPayout("r1", own, actor)).responseText).toBe("own_destination_changed"); expect(m.init).not.toHaveBeenCalled();
  });
});
