import { beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ payment: vi.fn(), membership: vi.fn(), reservation: vi.fn(), link: vi.fn(), transaction: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: { payment: { findMany: m.payment }, membershipPayment: { findMany: m.membership }, reservation: { findMany: m.reservation }, paymentLink: { findMany: m.link }, kushkiTransaction: { findMany: m.transaction } } }));
import { loadLocalCharges } from "./local";
import { settlementPeriod } from "./report";

const period = settlementPeriod(new Date("2026-11-09T23:30:00Z"));
const at = new Date("2026-11-06T12:00:00Z");
const payment = (extra: Record<string, unknown> = {}) => ({ id: "pay", amountCents: 1500000, refundedCents: 2000, providerRef: "transaction-1", settledAt: at, createdAt: at, kushkiTransactions: [{ kushkiTxId: "transaction-1", amountCents: 1500000, raw: { transactionReference: "transaction-1", ticketNumber: "ticket-1", amount: { currency: "COP" } } }], ...extra });
beforeEach(() => { vi.resetAllMocks(); for (const mock of Object.values(m)) mock.mockResolvedValue([]); });
describe("bounded local collection sources", () => {
  it("isolates merchant sources and uses provider proof only from the same charge", async () => {
    m.payment.mockResolvedValue([payment()]);
    const result = await loadLocalCharges({ kind: "merchant", restaurantId: "tenant" }, period);
    expect(result.charges).toEqual([{ id: "pay", source: "order", occurredAt: at.toISOString(), dateBasis: "payment", amountCents: 1500000, refundedCents: 2000, currency: "COP", references: ["transaction-1", "ticket-1"] }]);
    expect(m.payment.mock.calls[0][0].where).toMatchObject({ order: { restaurantId: "tenant" }, status: { in: ["approved", "refunded"] } });
    expect(m.payment.mock.calls[0][0].where.method.in).toEqual(["kushki_card", "kushki_apple_pay", "kushki_google_pay", "kushki_pse", "kushki_card_terminal"]);
    expect(m.link.mock.calls[0][0].where.kind.in).toEqual(["voucher_batch", "voucher_statement"]);
    expect(m.link.mock.calls[0][0].where.restaurantId).toBe("tenant");
    expect(m.reservation.mock.calls[0][0].where.restaurantId).toBe("tenant");
    expect(m.membership).not.toHaveBeenCalled();
  });
  it("does not infer currency from current country or the legacy mirror default", async () => {
    m.payment.mockResolvedValue([payment({ kushkiTransactions: [{ kushkiTxId: "other", amountCents: 1500000, currency: "COP", raw: { ticketNumber: "wrong", transactionReference: "other" } }] })]);
    expect((await loadLocalCharges({ kind: "merchant", restaurantId: "tenant" }, period)).charges[0]).toMatchObject({ currency: null, references: ["transaction-1"] });
  });
  it("preserves subscription receipts after a restaurant was deleted without inferring currency", async () => {
    m.membership.mockResolvedValue([{ id: "membership", amountCents: 123400, providerRef: "ticket-sub", createdAt: at, restaurantId: null }]);
    const result = await loadLocalCharges({ kind: "platform" }, period);
    expect(result.charges[0]).toMatchObject({ source: "subscription", amountCents: 123400, currency: null, references: ["ticket-sub"], dateBasis: "record" });
    expect(m.membership.mock.calls[0][0].where).toMatchObject({ method: "kushki_card", kind: { in: ["initial", "recurring"] } });
    expect(m.payment).not.toHaveBeenCalled();
  });
  it("counts standalone voucher payment links once and keeps their currency snapshot", async () => {
    m.link.mockResolvedValue([{ id: "link", amountCents: 10000, currency: "COP", paidAt: at, createdAt: at, providerRef: "pse-token" }]);
    expect((await loadLocalCharges({ kind: "merchant", restaurantId: "tenant" }, period)).charges).toEqual([expect.objectContaining({ id: "link", source: "voucher", currency: "COP", references: ["pse-token"], dateBasis: "payment" })]);
  });
  it("uses a reservation's matched charge date or explicitly its record date, never updatedAt", async () => {
    m.reservation.mockResolvedValue([
      { id: "old-reservation", depositCents: 10000, depositTxId: "deposit-ref", createdAt: new Date("2026-10-01"), updatedAt: new Date() },
      { id: "pse-reservation", depositCents: 20000, depositTxId: "pse-token", createdAt: at, updatedAt: new Date() },
      { id: "irrelevant-old", depositCents: 10000, depositTxId: "old", createdAt: new Date("2026-10-01"), updatedAt: new Date() },
    ]);
    m.transaction.mockResolvedValue([{ kushkiTxId: "deposit-ref", amountCents: 10000, createdAt: at, raw: { transactionReference: "deposit-ref", ticketNumber: "deposit-ticket" } }]);
    const result = await loadLocalCharges({ kind: "merchant", restaurantId: "tenant" }, period);
    expect(result.charges).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "old-reservation", occurredAt: at.toISOString(), dateBasis: "record", references: ["deposit-ref", "deposit-ticket"] }),
      expect.objectContaining({ id: "pse-reservation", occurredAt: at.toISOString(), dateBasis: "record" }),
    ]));
    expect(result.charges).toHaveLength(2);
    expect(m.transaction.mock.calls[0][0].where).toMatchObject({ restaurantId: "tenant", kind: "charge", status: "approved" });
  });
  it("caps output and reports truncation without silently claiming full coverage", async () => {
    m.membership.mockResolvedValue(Array.from({ length: 201 }, (_, i) => ({ id: `m${i}`, amountCents: 100, providerRef: `ref${i}`, createdAt: at })));
    const result = await loadLocalCharges({ kind: "platform" }, period);
    expect(result.charges).toHaveLength(200);
    expect(result.truncated).toBe(true);
    expect(m.membership.mock.calls[0][0].take).toBe(201);
  });
  it("does not treat mock references or fake numeric fields as genuine collections", async () => {
    m.payment.mockResolvedValue([payment({ providerRef: "mock_pse_123" })]);
    expect((await loadLocalCharges({ kind: "merchant", restaurantId: "tenant" }, period)).charges).toEqual([]);
    m.payment.mockResolvedValue([payment({ refundedCents: -1 })]);
    await expect(loadLocalCharges({ kind: "merchant", restaurantId: "tenant" }, period)).rejects.toThrow("invalid_local_money");
  });
});
