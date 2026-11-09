import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "../src/lib/db";
import { encrypt } from "../src/lib/crypto";
import { bogotaBusinessDateIso } from "../src/lib/bogota";
import { loadWalletIncoming } from "../src/lib/walletIncoming/service";

vi.hoisted(() => { process.env.MESAPAY_SECRET_KEY = "ab".repeat(32); });
vi.mock("../src/lib/platformConfig", () => ({
  getKushkiMode: async () => "sandbox",
  getRestaurantKushkiMode: async () => "sandbox",
  getBillingCredentials: async () => ({ privateKey: "billing-incoming-fixture", publicKey: "public-fixture" }),
}));
const database = new URL(process.env.DATABASE_URL ?? "postgresql://localhost/invalid");
if (!["localhost", "127.0.0.1"].includes(database.hostname) || !/^\/mesapay_.*(?:test|validation)$/.test(database.pathname)) throw new Error("Isolated local test database required");
const fetchMock = vi.fn<typeof fetch>();
const tenantIds: string[] = [];
let restaurantId: string;
let tableId: string;
const recent = () => new Date(Date.now() - 86_400_000);
const providerRow = (ticket: string, amount = "15000.00") => ({
  ticket_number: ticket, merchant_id: "verified-provider-fixture", created: bogotaBusinessDateIso(recent()),
  payment_date: bogotaBusinessDateIso(new Date(Date.now() + 2 * 86_400_000)),
  currency_code: "COP", transaction_type: "SALE", transaction_status: "APPROVED",
  approved_transaction_amount: amount, pay_amount: "14682.00", wallet: "0.00",
});
const reply = (data: unknown[], status = 200) => new Response(JSON.stringify(status === 200
  ? { data, pagination: { page: 1, limit: 100, total: data.length, totalPages: data.length ? 1 : 0 } }
  : { code: "E003", message: "Provider private detail that must not reach the browser" }), { status });
async function tenant() {
  const row = await db.restaurant.create({ data: {
    name: "Wallet incoming fixture", slug: `incoming-${randomUUID()}`, country: "CO", kushkiMode: "sandbox",
    kushkiOnboardingStatus: "active", kushkiMerchantId: "merchant-fixture", kushkiPrivateKeyEnc: encrypt("merchant-collections-fixture"),
    kushkiPayoutPublicKey: "different-payout-public", kushkiPayoutPrivateKeyEnc: encrypt("never-use-payout-key"),
  } });
  tenantIds.push(row.id);
  const table = await db.table.create({ data: { restaurantId: row.id, number: 1, qrToken: randomUUID() } });
  return { restaurantId: row.id, tableId: table.id };
}
beforeAll(() => { vi.stubGlobal("fetch", fetchMock); });
beforeEach(async () => {
  ({ restaurantId, tableId } = await tenant());
  fetchMock.mockReset().mockImplementation(async (url, init) => {
    expect(String(url)).toBe("https://api-uat.kushkipagos.com/merchant-settlement/v1/settlement?switch=ecommerce");
    expect(init?.method).toBe("POST");
    expect(init?.redirect).toBe("error");
    return reply([]);
  });
});
afterAll(async () => {
  await db.membershipPayment.deleteMany({ where: { restaurantId: { in: tenantIds } } });
  await db.restaurant.deleteMany({ where: { id: { in: tenantIds } } });
  vi.unstubAllGlobals();
  await db.$disconnect();
});

describe("wallet incoming activity with real local records and simulated report transport", () => {
  it("matches only the application's automatic subscription, preserving unknown local currency and all financial state", async () => {
    const ticket = randomUUID();
    const base = { restaurantId, amountCents: 1_500_000, periodStart: recent(), periodEnd: new Date(), recordedByEmail: "fixture@example.test", createdAt: recent() };
    const paid = await db.membershipPayment.create({ data: { ...base, kind: "initial", method: "kushki_card", providerRef: ticket } });
    const manual = await db.membershipPayment.create({ data: { ...base, kind: "manual", method: "manual_transfer", providerRef: "bank-reference" } });
    const before = await db.membershipPayment.findMany({ where: { restaurantId }, orderBy: { id: "asc" } });
    fetchMock.mockImplementation(async (_url, init) => {
      expect(new Headers(init?.headers).get("Private-Merchant-Id")).toBe("billing-incoming-fixture");
      return reply([providerRow(ticket), providerRow("unrelated-provider-ticket")]);
    });
    const result = await loadWalletIncoming({ kind: "platform" });
    expect(result.status).toBe("available");
    expect(result.localCharges.find(row => row.id === paid.id)).toMatchObject({
      source: "subscription", amountCents: 1_500_000, currency: null,
      report: { currency: "COP", grossCents: 1_500_000, netCents: 1_468_200 },
    });
    expect(result.localCharges.some(row => row.id === manual.id)).toBe(false);
    expect(result.unmatchedReportCount).toBe(1);
    expect(JSON.stringify(result)).not.toMatch(/pendingCents|creditedAt|billing-incoming-fixture|ticket_number|references/);
    expect(await db.membershipPayment.findMany({ where: { restaurantId }, orderBy: { id: "asc" } })).toEqual(before);
    expect(await db.walletMovement.count({ where: { restaurantId } })).toBe(0);
  });

  it("keeps the merchant's recorded collections on E003, excluding other merchants, cash and subsequent applications of deposits and vouchers", async () => {
    const order = await db.order.create({ data: { restaurantId, tableId, shortCode: randomUUID(), totalCents: 10_000_000, subtotalCents: 10_000_000 } });
    const approved = await db.payment.create({ data: { orderId: order.id, method: "kushki_card", status: "approved", amountCents: 1_500_000, providerRef: randomUUID(), settledAt: recent(), createdAt: recent(), refundedCents: 10_000 } });
    await db.kushkiTransaction.create({ data: { restaurantId, paymentId: approved.id, kushkiTxId: approved.providerRef!, kind: "charge", status: "approved", amountCents: approved.amountCents, currency: "COP", raw: { transactionReference: approved.providerRef!, amount: { currency: "COP" } }, createdAt: recent() } });
    for (const method of ["cash", "external_terminal", "reservation_deposit", "voucher"] as const) {
      await db.payment.create({ data: { orderId: order.id, method, status: "approved", amountCents: 1000, providerRef: randomUUID(), settledAt: recent(), createdAt: recent() } });
    }
    const voucher = await db.paymentLink.create({ data: { restaurantId, token: randomUUID(), kind: "voucher_batch", method: "kushki_card", status: "paid", amountCents: 2000, currency: "COP", paidAt: recent(), providerRef: randomUUID() } });
    await db.paymentLink.create({ data: { restaurantId, token: randomUUID(), kind: "order", method: "kushki_card", status: "paid", amountCents: 3000, currency: "COP", paidAt: recent(), providerRef: randomUUID() } });
    const other = await tenant();
    const otherLink = await db.paymentLink.create({ data: { restaurantId: other.restaurantId, token: randomUUID(), kind: "voucher_batch", method: "kushki_card", status: "paid", amountCents: 2000, paidAt: recent(), providerRef: randomUUID() } });
    const before = await db.payment.findMany({ where: { orderId: order.id }, orderBy: { id: "asc" } });
    fetchMock.mockImplementation(async (_url, init) => {
      expect(new Headers(init?.headers).get("Private-Merchant-Id")).toBe("merchant-collections-fixture");
      return reply([], 403);
    });
    const result = await loadWalletIncoming({ kind: "merchant", restaurantId });
    expect(result.status).toBe("permission_required");
    expect(result.reportComplete).toBe(false);
    expect(result.localCharges.map(row => row.id).sort()).toEqual([approved.id, voucher.id].sort());
    expect(result.localCharges.find(row => row.id === approved.id)).toMatchObject({ amountCents: 1_500_000, refundedCents: 10_000, currency: "COP" });
    expect(result.localCharges.some(row => row.id === otherLink.id)).toBe(false);
    expect(JSON.stringify(result)).not.toMatch(/Provider private|privateKey|merchant-collections-fixture|pendingCents/);
    expect(await db.payment.findMany({ where: { orderId: order.id }, orderBy: { id: "asc" } })).toEqual(before);
    expect(await db.walletMovement.count({ where: { restaurantId } })).toBe(0);
  });

  it("lists the original reservation deposit once and never substitutes the mirror's default currency or an update timestamp", async () => {
    const reference = randomUUID();
    const reservation = await db.reservation.create({ data: {
      restaurantId, tableId, confirmationCode: randomUUID(), customerName: "Synthetic guest", customerEmail: "never-send@example.test",
      partySize: 2, startsAt: new Date(), endsAt: new Date(Date.now() + 3_600_000),
      depositCents: 500_000, depositStatus: "applied", depositMethod: "kushki_card", depositTxId: reference,
      createdAt: new Date(Date.now() - 30 * 86_400_000),
    } });
    const mirror = await db.kushkiTransaction.create({ data: {
      restaurantId, kushkiTxId: reference, kind: "charge", status: "approved", amountCents: 500_000,
      raw: {}, createdAt: recent(),
    } });
    const result = await loadWalletIncoming({ kind: "merchant", restaurantId });
    expect(result.localCharges).toEqual([expect.objectContaining({
      id: reservation.id, source: "reservation", amountCents: 500_000, refundedCents: 0,
      dateBasis: "record", occurredAt: mirror.createdAt.toISOString(), currency: null,
    })]);
    expect(result.localCharges[0].report).toBeUndefined();
    expect(await db.walletMovement.count({ where: { restaurantId } })).toBe(0);
  });
});
