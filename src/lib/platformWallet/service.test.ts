import { beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({
  account: { id: "account1", label: "Test", mode: "sandbox", publicKey: "public", privateKeyEnc: "encrypted", webhookSecretEnc: "secret", createdAt: new Date() },
  findUnique: vi.fn(), findFirst: vi.fn(), create: vi.fn(), updateMany: vi.fn(),
  balance: vi.fn(), banks: vi.fn(), token: vi.fn(), init: vi.fn(), query: vi.fn(), config: vi.fn(), audit: vi.fn(),
}));
vi.mock("@/lib/db", () => { const tx = { $queryRaw: vi.fn(), platformConfig: { findUnique: m.config }, platformPayout: { findUnique: m.findUnique, findFirst: m.findFirst, create: m.create, updateMany: m.updateMany }, auditEvent: { create: m.audit } }; return { db: { ...tx, $transaction: (fn: (client: typeof tx) => unknown) => fn(tx) } }; });
vi.mock("./config", () => ({ walletLock: vi.fn(), credentials: () => ({ mode: "sandbox", publicKey: "public", privateKey: "private" }), webhookSecret: () => "secret" }));
vi.mock("./provider", () => ({ walletBalance: m.balance, walletBanks: m.banks, tokenizePayout: m.token, initializePayout: m.init, queryPayout: m.query, definiteInitRejection: () => false }));
vi.mock("@/lib/env", () => ({ env: { APP_PUBLIC_BASE_URL: "https://mesapay.co" } }));
vi.mock("@/lib/walletTracking/fingerprint", () => ({ walletAccountFingerprint: () => "frozen-wallet-context" }));
import { submitPlatformPayout } from "./service";
import { WalletError } from "./errors";
import { payloadFingerprint } from "./validation";
const input = { accountId: "account1", idempotencyKey: "89fcb4e0-414a-4505-937d-bd716f6c3660", amountCents: 100000, destination: { bankId: "000051", accountType: "ahorros" as const, accountNumber: "123456789", docType: "CC" as const, docNumber: "12345678", holderName: "Test Person" }, confirmed: true as const };
const actor = { id: "admin", email: "admin@example.test" };
let row: Record<string, unknown> | null;
beforeEach(() => {
  vi.clearAllMocks(); row = null;
  m.config.mockResolvedValue({ platformWalletAccountId: "account1", platformWalletAccount: m.account });
  m.findUnique.mockImplementation(async () => row);
  m.findFirst.mockResolvedValue(null);
  m.create.mockImplementation(async ({ data }) => { row = { ...data, id: "payout1", createdAt: new Date(), updatedAt: new Date(), settledAt: null, ticketNumber: null, providerRef: null, errorCode: null, description: null, account: m.account }; return row; });
  m.updateMany.mockImplementation(async ({ data, where }) => { if (row && (!where.status || row.status === where.status || where.status.in?.includes(row.status))) { row = { ...row, ...data }; return { count: 1 }; } return { count: 0 }; });
  m.balance.mockResolvedValue({ availableCents: 500000 }); m.banks.mockResolvedValue([{ id: "000051", name: "Bank" }]);
  m.token.mockResolvedValue("token"); m.init.mockResolvedValue({ ticketNumber: "1234", providerRef: "provider-ref" });
});
describe("platform payouts are durable and never duplicated on uncertain results", () => {
  it("records before external calls and omits account/document numbers from persistence", async () => {
    m.token.mockImplementation(async () => { expect(row?.status).toBe("submitting"); expect(row?.walletAccountFingerprint).toBe("frozen-wallet-context"); return "token"; });
    const result = await submitPlatformPayout(input, actor);
    expect(result.status).toBe("initialized"); expect(result.amountCents).toBe(100000);
    expect(JSON.stringify(m.create.mock.calls, (_key, value) => typeof value === "bigint" ? String(value) : value)).not.toContain("123456789");
    expect(m.init).toHaveBeenCalledTimes(1);
  });
  it("replays the same row without consulting account settings or sending again", async () => {
    const first = await submitPlatformPayout(input, actor); m.config.mockClear();
    const replay = await submitPlatformPayout(input, actor);
    expect(replay.id).toBe(first.id); expect(m.init).toHaveBeenCalledTimes(1); expect(m.config).not.toHaveBeenCalled();
  });
  it("rejects reuse with another payload", async () => {
    await submitPlatformPayout(input, actor);
    await expect(submitPlatformPayout({ ...input, amountCents: 200000 }, actor)).rejects.toThrow("idempotency_conflict");
    expect(m.init).toHaveBeenCalledTimes(1);
  });
  it("rejects account changes and an existing uncertain transfer before network calls", async () => {
    m.config.mockResolvedValueOnce({ platformWalletAccountId: "another", platformWalletAccount: m.account });
    await expect(submitPlatformPayout(input, actor)).rejects.toThrow("account_changed");
    m.findFirst.mockResolvedValueOnce({ id: "uncertain-old-account" });
    await expect(submitPlatformPayout(input, actor)).rejects.toThrow("payout_in_progress");
    expect(m.token).not.toHaveBeenCalled();
  });
  it("fails before token/init when balance is insufficient or bank is unknown", async () => {
    m.balance.mockResolvedValueOnce({ availableCents: 500 });
    expect((await submitPlatformPayout(input, actor)).errorCode).toBe("insufficient_funds"); expect(m.token).not.toHaveBeenCalled();
    row = null; m.banks.mockResolvedValueOnce([]);
    expect((await submitPlatformPayout(input, actor)).errorCode).toBe("invalid_bank"); expect(m.init).not.toHaveBeenCalled();
  });
  it("does not initiate when token request fails", async () => {
    m.token.mockRejectedValueOnce(new Error("sensitive provider text"));
    expect((await submitPlatformPayout(input, actor)).errorCode).toBe("payout_token_failed"); expect(m.init).not.toHaveBeenCalled();
  });
  it("persists unknown when init times out and returns it on retry", async () => {
    m.init.mockRejectedValueOnce(new Error("timeout private secrets"));
    expect((await submitPlatformPayout(input, actor)).status).toBe("unknown");
    expect((await submitPlatformPayout(input, actor)).errorCode).toBe("payout_unknown");
    expect(m.init).toHaveBeenCalledTimes(1); expect(JSON.stringify(row, (_key, value) => typeof value === "bigint" ? String(value) : value)).not.toContain("timeout private secrets");
  });
  it("does not overwrite an early callback that already approved", async () => {
    m.init.mockImplementationOnce(async () => { row = { ...row, status: "approved", settledAt: new Date() }; return { ticketNumber: "1234", providerRef: "provider-ref" }; });
    expect((await submitPlatformPayout(input, actor)).status).toBe("approved");
  });
  it("returns safe preparation errors without provider bodies", async () => {
    m.balance.mockRejectedValueOnce(new WalletError("balance_failed", 502));
    expect((await submitPlatformPayout(input, actor)).errorCode).toBe("balance_failed");
    expect(payloadFingerprint(input)).toHaveLength(64);
  });
  it("does not send if the preparation lease expired before its atomic claim", async () => {
    m.updateMany.mockImplementation(async ({ data }) => {
      if (data.initStartedAt) return { count: 0 };
      row = { ...row, ...data }; return { count: 1 };
    });
    await submitPlatformPayout(input, actor);
    expect(m.token).toHaveBeenCalledTimes(1); expect(m.init).not.toHaveBeenCalled();
  });
});
