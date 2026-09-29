import { beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ auth: vi.fn(), active: vi.fn(), find: vi.fn(), update: vi.fn(), recompute: vi.fn(), issue: vi.fn() }));
vi.mock("@/auth", () => ({ auth: m.auth }));
vi.mock("@/lib/activeRestaurant", () => ({ getActiveRestaurantId: m.active }));
vi.mock("@/lib/secureApi", () => ({ secureApi: (fn: unknown) => fn }));
vi.mock("@/lib/orderLock", () => ({ lockOrder: vi.fn() }));
vi.mock("@/lib/events", () => ({ publishOrderEvent: vi.fn() }));
vi.mock("@/lib/mailer", () => ({ welcomeIfFirstTime: vi.fn() }));
vi.mock("@/lib/prepaidRounds", () => ({ activateOpenRounds: vi.fn(async () => []) }));
vi.mock("@/lib/kds/autoFireTickets", () => ({ notifyAutoFiredTickets: vi.fn() }));
vi.mock("@/lib/orderTotals", () => ({ recomputeOrderTotalsInTx: m.recompute }));
vi.mock("@/lib/invoiceOnPaid", () => ({ issueInvoiceOnPaid: m.issue }));
vi.mock("@/lib/chargeGuard", () => ({ isChargeBlocked: vi.fn(async () => false), chargeBlockedResponse: vi.fn() }));
vi.mock("@/lib/db", () => {
  const tx = { payment: { findUniqueOrThrow: m.find, update: m.update } };
  return { db: { payment: { findUnique: m.find, update: m.update }, $transaction: async (fn: (arg: typeof tx) => unknown) => fn(tx) } };
});
import { POST } from "./route";
const payment = { id: "p", orderId: "o", method: "external_terminal", status: "pending", collectedByUserId: null, order: { restaurantId: "r", status: "paying", dinerId: null } };
const call = (action = "approve") => POST(new Request("http://localhost/api/operator/payments/p/settle-external-terminal", { method: "POST", body: JSON.stringify({ action }) }), { params: Promise.resolve({ id: "p" }) });
beforeEach(() => {
  vi.clearAllMocks();
  m.auth.mockResolvedValue({ user: { id: "u", role: "mesero" } });
  m.active.mockResolvedValue("r");
  m.find.mockResolvedValue(payment);
  m.update.mockResolvedValue({ id: "p" });
  m.recompute.mockResolvedValue({ fullyPaid: true });
  m.issue.mockResolvedValue({ status: "issued", invoiceId: "inv", alreadyIssued: false, emit: null });
});
describe("external terminal invoice copy after settling", () => {
  it("returns the issued invoice for the paid board to offer a copy", async () => {
    const res = await call();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ paid: true, invoiceId: "inv" });
  });
  it("does not issue or offer an invoice for a partial payment", async () => {
    m.recompute.mockResolvedValue({ fullyPaid: false });
    expect(await call().then(r => r.json())).toMatchObject({ paid: false, invoiceId: null });
    expect(m.issue).not.toHaveBeenCalled();
  });
  it("does not turn invoice failure into a failed payment", async () => {
    m.issue.mockResolvedValue({ status: "failed" });
    const res = await call();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ paid: true, invoiceId: null });
  });
  it("cannot disclose invoice data from another restaurant", async () => {
    m.active.mockResolvedValue("another");
    expect((await call()).status).toBe(403);
    expect(m.issue).not.toHaveBeenCalled();
  });
  it("does not generate an invoice when rejecting the charge", async () => {
    expect(await call("decline").then(r => r.json())).toEqual({ ok: true, status: "declined" });
    expect(m.issue).not.toHaveBeenCalled();
  });
});
