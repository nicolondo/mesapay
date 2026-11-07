import { beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("@/lib/platformConfig", () => ({ getKushkiModeSync: () => "sandbox" }));
vi.mock("@/lib/env", () => ({ requireKushkiKey: () => "unused" }));
vi.mock("@/lib/payments/kushki/client", async (original) => ({ ...await original<typeof import("@/lib/payments/kushki/client")>(), kushkiFetch: m.fetch }));
import { KushkiHttpError } from "@/lib/payments/kushki/client";
import { walletBalance, walletBanks, tokenizePayout, initializePayout, queryPayout } from "./provider";
const account = { mode: "sandbox" as const, publicKey: "public-test", privateKey: "private-test" };
beforeEach(() => vi.resetAllMocks());
describe("platform wallet provider boundary", () => {
  it("reads COP balance, converts to cents and preserves provider timestamp", async () => {
    m.fetch.mockResolvedValue({ currentBalance: 1234.56, currency: "COP", balanceDate: 1675874081783 });
    expect(await walletBalance(account)).toEqual({ availableCents: 123456, balanceDate: "2023-02-08T16:34:41.783Z", pendingCents: null, pendingStatus: "not_reported", pendingUpdatedAt: null });
    expect(m.fetch).toHaveBeenCalledWith("/wallet/v1/merchant/balance", expect.objectContaining({ method: "GET", mode: "sandbox", auth: { kind: "submerchant", privateKey: "private-test" } }));
  });
  it("rejects other currencies and nonnumeric/unsafe balances", async () => {
    for (const response of [{ currentBalance: 100, currency: "MXN" }, { currentBalance: "100" }, { currentBalance: Number.MAX_SAFE_INTEGER }]) {
      m.fetch.mockResolvedValueOnce(response); await expect(walletBalance(account)).rejects.toThrow("balance_failed");
    }
  });
  it("maps exact WLT400 to zero but not authentication failures", async () => {
    m.fetch.mockRejectedValueOnce(new KushkiHttpError(400, '{"code":"WLT400"}', "test"));
    expect(await walletBalance(account)).toEqual({ availableCents: 0, balanceDate: null, pendingCents: null, pendingStatus: "not_reported", pendingUpdatedAt: null });
    m.fetch.mockRejectedValueOnce(new KushkiHttpError(403, '{"code":"WLT400"}', "test"));
    await expect(walletBalance(account)).rejects.toThrow("balance_failed");
  });
  it("does not treat unrelated fields or the available timestamp as a pending amount", async () => {
    m.fetch.mockResolvedValue({ currentBalance: 0, currency: "COP", balanceDate: 1675874081783, pending: 500, totalBalance: 500 });
    expect(await walletBalance(account)).toMatchObject({ availableCents: 0, pendingCents: null, pendingStatus: "not_reported", pendingUpdatedAt: null });
  });
  it("validates bank schema and normalizes code/id", async () => {
    m.fetch.mockResolvedValue([{ code: "000051", name: "Bank" }, { id: "007", name: "Bank2" }]);
    expect(await walletBanks(account)).toEqual([{ id: "000051", name: "Bank" }, { id: "007", name: "Bank2" }]);
    m.fetch.mockResolvedValue({ nonsense: [] }); await expect(walletBanks(account)).rejects.toThrow("banks_failed");
  });
  it("tokenizes ACH without name and never retries mutations", async () => {
    m.fetch.mockResolvedValue({ token: "token-test" });
    await tokenizePayout(account, { amountCents: 123456, destination: { bankId: "000051", accountType: "ahorros", accountNumber: "123456789", docType: "PA", docNumber: "P123456", holderName: "Person" } });
    expect(m.fetch).toHaveBeenCalledWith("/payouts/transfer/v1/tokens", expect.objectContaining({ retries: 0, body: { documentType: "PP", documentNumber: "P123456", accountType: "CA", accountNumber: "123456789", bankId: "000051", totalAmount: 1234.56, currency: "COP" } }));
  });
  it("initializes with stable reference and authenticated callback", async () => {
    m.fetch.mockResolvedValue({ ticketNumber: "ticket1", transactionReference: "ref1", status: "INITIALIZED" });
    expect(await initializePayout(account, { token: "token", amountCents: 100000, reference: "our-ref", webhookUrl: "https://mesapay.co/api/webhooks/test", webhookSecret: "secret" })).toEqual({ ticketNumber: "ticket1", providerRef: "ref1" });
    expect(m.fetch).toHaveBeenCalledWith("/payouts/transfer/v1/init", expect.objectContaining({ retries: 0, body: expect.objectContaining({ metadata: { reference: "our-ref" }, webhooks: [{ events: ["approvedTransaction", "declinedTransaction"], headers: [{ label: "Authorization", value: "Bearer secret" }], urls: ["https://mesapay.co/api/webhooks/test"] }] }) }));
  });
  it("treats malformed success as ambiguous and rejects unsafe status ticket", async () => {
    m.fetch.mockResolvedValue({ status: "INITIALIZED" });
    await expect(initializePayout(account, { token: "token", amountCents: 100000, reference: "ref", webhookUrl: "https://mesapay.co/a", webhookSecret: "secret" })).rejects.toThrow();
    await expect(queryPayout(account, "../other")).rejects.toThrow("payout_status_unavailable");
  });
  it("preserves a valid provider ticket when init omits the optional reference", async () => {
    m.fetch.mockResolvedValue({ ticketNumber: "1234", status: "INITIALIZED" });
    expect(await initializePayout(account, { token: "token", amountCents: 100000, reference: "ref", webhookUrl: "https://mesapay.co/a", webhookSecret: "secret" })).toEqual({ ticketNumber: "1234", providerRef: null });
  });
});
