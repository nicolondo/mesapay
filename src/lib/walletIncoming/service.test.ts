import { beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ local: vi.fn(), report: vi.fn(), mode: vi.fn(), merchantMode: vi.fn(), billing: vi.fn(), tenant: vi.fn(), decrypt: vi.fn() }));
vi.mock("./local", () => ({ loadLocalCharges: m.local }));
vi.mock("./report", async (original) => ({ ...(await original<typeof import("./report")>()), readSettlementReport: m.report }));
vi.mock("@/lib/platformConfig", () => ({ getKushkiMode: m.mode, getRestaurantKushkiMode: m.merchantMode, getBillingCredentials: m.billing }));
vi.mock("@/lib/db", () => ({ db: { restaurant: { findUnique: m.tenant } } }));
vi.mock("@/lib/crypto", () => ({ decrypt: m.decrypt }));
import { loadWalletIncoming } from "./service";

const charge = { id: "m1", source: "subscription", amountCents: 1500000, refundedCents: 0, currency: null, dateBasis: "payment", occurredAt: "2026-11-06T12:00:00Z", references: ["ticket"] };
beforeEach(() => {
  vi.resetAllMocks(); m.mode.mockResolvedValue("production"); m.merchantMode.mockResolvedValue("production");
  m.billing.mockResolvedValue({ privateKey: "billing-fixture", publicKey: "billing-public" });
  m.tenant.mockResolvedValue({ country: "CO", kushkiMode: "production", kushkiPrivateKeyEnc: "encrypted-collection", kushkiMerchantId: "merchant-fixture" });
  m.decrypt.mockReturnValue("collection-fixture");
  m.local.mockResolvedValue({ charges: [charge], truncated: false });
  m.report.mockResolvedValue({ status: "available", rows: [{ reference: "ticket", eligible: true, grossCents: 1500000, netCents: 1468200, currency: "COP", paymentDate: "2026-11-11" }], complete: true });
});
describe("incoming funds informational service", () => {
  it("uses billing collection credentials for platform, not its independently configured payout account", async () => {
    const result = await loadWalletIncoming({ kind: "platform" });
    expect(m.report).toHaveBeenCalledWith(expect.objectContaining({ privateKey: "billing-fixture", mode: "production" }));
    expect(m.tenant).not.toHaveBeenCalled();
    expect(result).toMatchObject({ status: "available", reportMode: "production", reportComplete: true, localTruncated: false, unmatchedReportCount: 0, localCharges: [{ currency: null, report: { netCents: 1468200, paymentDate: "2026-11-11" } }] });
    expect(JSON.stringify(result)).not.toMatch(/billing-fixture|references|pendingCents|credited/);
  });
  it("uses the selected merchant's collection credential and explicit mode", async () => {
    m.merchantMode.mockResolvedValue("sandbox");
    const result = await loadWalletIncoming({ kind: "merchant", restaurantId: "tenant" });
    expect(m.tenant.mock.calls[0][0].where).toEqual({ id: "tenant" });
    expect(m.report).toHaveBeenCalledWith(expect.objectContaining({ privateKey: "collection-fixture", mode: "sandbox" }));
    expect(m.billing).not.toHaveBeenCalled();
    expect(result.reportMode).toBe("sandbox");
  });
  it.each(["permission_required", "unavailable", "credentials_missing"])("preserves the local list if the report is %s", async status => {
    m.report.mockResolvedValue({ status, rows: [], complete: false });
    expect(await loadWalletIncoming({ kind: "platform" })).toMatchObject({ status, reportMode: "production", reportComplete: false, localCharges: [{ id: "m1" }] });
  });
  it("never sends a request in mock mode or when credentials are missing", async () => {
    m.mode.mockResolvedValue("mock");
    expect(await loadWalletIncoming({ kind: "platform" })).toMatchObject({ status: "unsupported", reportMode: null, localCharges: [{ id: "m1" }] });
    expect(m.report).not.toHaveBeenCalled();
    m.mode.mockResolvedValue("production"); m.billing.mockResolvedValue({ privateKey: null });
    expect(await loadWalletIncoming({ kind: "platform" })).toMatchObject({ status: "credentials_missing" });
  });
  it("does not use this CO report for another country or an unknown merchant", async () => {
    m.tenant.mockResolvedValueOnce({ country: "MX" }).mockResolvedValueOnce(null);
    expect(await loadWalletIncoming({ kind: "merchant", restaurantId: "mx" })).toMatchObject({ status: "unsupported" });
    expect(await loadWalletIncoming({ kind: "merchant", restaurantId: "missing" })).toMatchObject({ status: "credentials_missing" });
    expect(m.report).not.toHaveBeenCalled();
  });
  it("sanitizes decryption and query failures instead of exposing provider or database detail", async () => {
    m.decrypt.mockImplementation(() => { throw new Error("secret detail"); });
    expect(await loadWalletIncoming({ kind: "merchant", restaurantId: "tenant" })).toMatchObject({ status: "credentials_missing" });
    m.local.mockRejectedValue(new Error("database detail"));
    await expect(loadWalletIncoming({ kind: "platform" })).rejects.toThrow(/^local_collections_unavailable$/);
  });
  it("retains incomplete-report metadata and does not link a capped local list", async () => {
    m.local.mockResolvedValue({ charges: [charge], truncated: true });
    m.report.mockResolvedValue({ status: "available", rows: [{ reference: "ticket", eligible: true, grossCents: 1500000, netCents: 1468200, currency: "COP", paymentDate: "2026-11-11" }], complete: false });
    const result = await loadWalletIncoming({ kind: "platform" });
    expect(result).toMatchObject({ reportComplete: false, localTruncated: true, unmatchedReportCount: 1 });
    expect(result.localCharges[0].report).toBeUndefined();
  });
  it("does not attach matches from a partial provider report even when the local list is complete", async () => {
    m.report.mockResolvedValue({ status: "available", rows: [{ reference: "ticket", eligible: true, grossCents: 1500000, netCents: 1468200, currency: "COP", paymentDate: "2026-11-11" }], complete: false });
    const result = await loadWalletIncoming({ kind: "platform" });
    expect(result).toMatchObject({ reportComplete: false, localTruncated: false, unmatchedReportCount: 1 });
    expect(result.localCharges[0].report).toBeUndefined();
  });
  it("distinguishes infrastructure failure from a missing credential", async () => {
    m.tenant.mockRejectedValue(new Error("db unavailable"));
    expect(await loadWalletIncoming({ kind: "merchant", restaurantId: "tenant" })).toMatchObject({ status: "unavailable", localCharges: [{ id: "m1" }] });
  });
});
