import { beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("@/lib/payments/kushki/client", () => ({ kushkiFetch: m.fetch, KushkiHttpError: class extends Error {} }));
import { tokenizeMerchantPayout } from "./provider";
const account = { mode: "sandbox" as const, publicKey: "public-test", privateKey: "private-test" };
const destination = { bankId: "51", bankName: "Bank", accountType: "ahorros" as const, accountNumber: "123456789", docType: "PA" as const, docNumber: "P1234567", holderName: "Person" };
beforeEach(() => { vi.clearAllMocks(); m.fetch.mockResolvedValue({ token: "token" }); });
describe("merchant payout provider compatibility", () => {
  it.each(["COP", "MXN"])("preserves %s, paymentDescription, passport mapping and zero retries", async (currency) => {
    expect(await tokenizeMerchantPayout(account, { amountCents: 123456, currency, reference: "our-ref", destination })).toBe("token");
    expect(m.fetch).toHaveBeenCalledWith("/payouts/transfer/v1/tokens", { method: "POST", mode: "sandbox", auth: { kind: "submerchant_public", publicKey: "public-test" }, retries: 0,
      body: { documentType: "PP", documentNumber: "P1234567", accountType: "CA", accountNumber: "123456789", bankId: "51", totalAmount: 1234.56, currency, paymentDescription: "our-ref" } });
  });
  it("preserves corriente and other document types, and rejects malformed token response", async () => {
    await tokenizeMerchantPayout(account, { amountCents: 10000, currency: "COP", reference: "ref", destination: { ...destination, accountType: "corriente", docType: "NIT" } });
    expect(m.fetch.mock.calls[0][1].body).toMatchObject({ accountType: "CC", documentType: "NIT" });
    m.fetch.mockResolvedValue({ token: "" }); await expect(tokenizeMerchantPayout(account, { amountCents: 10000, currency: "COP", reference: "ref", destination })).rejects.toThrow();
  });
});
