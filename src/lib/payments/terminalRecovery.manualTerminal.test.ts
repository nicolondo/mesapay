import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ search: vi.fn(), process: vi.fn(), record: vi.fn(), approval: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: {
  financialOperation: { updateMany: h.record },
  kushkiTransaction: { updateMany: h.approval },
} }));
vi.mock("./kushki/cloudTerminal", () => ({ searchCloudTerminalCharge: h.search }));
vi.mock("./webhookHandler", () => ({ processKushkiWebhook: h.process }));
import { checkTerminalChargeOnce, recoverTerminalOutcome, type TerminalCheckContext } from "./terminalRecovery";

const ctx: TerminalCheckContext = {
  restaurantId: "tenant-local", paymentId: "payment-local", amountCents: 100_000,
  serialNumber: "local-device", clientTransactionId: "local-claim", businessCode: null, mode: "mock",
};

beforeEach(() => {
  vi.resetAllMocks();
  h.record.mockResolvedValue({ count: 1 });
  h.approval.mockResolvedValue({ count: 1 });
});

describe("terminal search concurrent with a manual decision", () => {
  it.each(["ok", "duplicate"])("does not announce a disputed late decline as applied (%s)", async status => {
    h.search.mockResolvedValue({ status: "declined", transactionReference: "real-reference", raw: {} });
    h.process.mockResolvedValue({ status, requiresReview: true });
    expect(await checkTerminalChargeOnce(ctx)).toEqual({ search: "declined", settled: null, settleFailed: true });
    expect(await recoverTerminalOutcome({ ...ctx, pushedAt: new Date() })).toEqual({ status: "unresolved", last: "settle_failed" });
    expect(h.approval).not.toHaveBeenCalled();
  });

  it("keeps a flagged approval unresolved rather than claiming it was applied", async () => {
    h.search.mockResolvedValue({ status: "approved", transactionReference: "real-reference", approvalCode: "12345", raw: {} });
    h.process.mockResolvedValue({ status: "ok", requiresReview: true });
    expect(await checkTerminalChargeOnce(ctx)).toEqual({ search: "approved", settled: null, settleFailed: true });
    expect(h.approval).not.toHaveBeenCalled();
  });

  it.each(["approved", "declined"])("retains a verified %s result with no conflict", async status => {
    h.search.mockResolvedValue({ status, transactionReference: "real-reference", approvalCode: "12345", raw: {} });
    h.process.mockResolvedValue({ status: "ok" });
    expect(await checkTerminalChargeOnce(ctx)).toEqual({ search: status, settled: status, providerRef: "real-reference" });
    expect(h.record).toHaveBeenCalledWith(expect.objectContaining({ where: { key: "terminal:payment-local" } }));
    if (status === "approved") expect(h.approval).toHaveBeenCalledWith({
      where: { kushkiTxId: "real-reference", paymentId: ctx.paymentId }, data: { approvalCode: "12345" },
    });
    else expect(h.approval).not.toHaveBeenCalled();
  });
});
