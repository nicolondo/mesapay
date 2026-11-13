import type { Prisma } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakePaymentsDb } from "@/test/fakePaymentsDb";

const h = vi.hoisted(() => ({
  fake: null as unknown as ReturnType<typeof import("@/test/fakePaymentsDb").createFakePaymentsDb>,
  publish: vi.fn(),
  invoice: vi.fn(async () => undefined),
  activate: vi.fn(async () => []),
}));
vi.mock("@/lib/db", () => ({ db: { $transaction: (cb: never) => h.fake.$transaction(cb) } }));
vi.mock("@/lib/orderLock", () => ({ lockOrder: async () => {} }));
vi.mock("@/lib/events", () => ({ publishOrderEvent: h.publish }));
vi.mock("@/lib/invoiceOnPaid", () => ({ issueInvoiceOnPaid: h.invoice }));
vi.mock("@/lib/prepaidRounds", () => ({ activateOpenRounds: h.activate }));
vi.mock("@/lib/kds/autoFireTickets", () => ({ notifyAutoFiredTickets: async () => {} }));

import { processKushkiWebhook, settleKushkiEventInTx, type KushkiWebhookPayload } from "./webhookHandler";

const MANUAL_REF = "manual:admin-1:terminal-1";
const REAL_REF = "kushki-transaction-1";
const TOTAL = 100_000;
const originalSettlement = new Date("2026-11-05T12:00:00Z");

function seedManual(status: "approved" | "declined") {
  const events = new Map<string, Record<string, unknown>>();
  h.fake = createFakePaymentsDb({
    order: { id: "order-1", status: status === "approved" ? "paid" : "served", subtotalCents: TOTAL, totalCents: TOTAL },
    payments: [{ id: "terminal-1", method: "kushki_card_terminal", amountCents: TOTAL, status,
      providerRef: MANUAL_REF, settledAt: status === "approved" ? originalSettlement : null }],
    financialOperations: [{ key: "terminal:terminal-1", paymentId: "terminal-1", amountCents: TOTAL,
      status: status === "approved" ? "completed" : "failed", providerRef: MANUAL_REF }],
    rounds: [{ status: "served" }],
    extraTx: {
      kushkiWebhookEvent: {
        createMany: async ({ data }: { data: Array<{ eventId: string }> }) => {
          for (const row of data) if (!events.has(row.eventId)) events.set(row.eventId, { ...row, id: row.eventId, processedAt: null });
        },
        findUniqueOrThrow: async ({ where }: { where: { eventId: string } }) => events.get(where.eventId),
        update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => Object.assign(events.get(where.id)!, data),
      },
    },
  });
  h.fake.state.auditEvents.push({
    restaurantId: "rest-1", actorUserId: "admin-1", actorEmail: "admin@example.test", actorRole: "operator",
    kind: "payment.reconciled", targetType: "payment", targetId: "terminal-1", summary: "Resultado verificado en datáfono",
    diff: { manualTerminalResolution: true, outcome: status, providerRef: MANUAL_REF },
  });
  Object.assign(h.fake.tx.auditEvent, {
    findFirst: async ({ where }: { where: Record<string, unknown> }) => h.fake.state.auditEvents.find((event) =>
      Object.entries(where).every(([key, value]) => {
        if (key !== "diff") return event[key] === value;
        const filter = value as { path: string[]; equals: unknown };
        return (event.diff as Record<string, unknown>)?.[filter.path[0]] === filter.equals;
      }),
    ) ?? null,
  });
  h.fake.state.kushkiTransactions.push({
    kushkiTxId: MANUAL_REF, restaurantId: "rest-1", paymentId: "terminal-1", kind: "charge", status,
    amountCents: TOTAL, approvalCode: status === "approved" ? "VOUCHER-1" : null, raw: {},
  });
}

function payload(overrides: Partial<KushkiWebhookPayload> = {}): KushkiWebhookPayload {
  return { eventId: "real-event-1", type: "terminal.approved", paymentId: "terminal-1", restaurantId: "rest-1",
    orderId: "order-1", amountCents: TOTAL, providerRef: REAL_REF, ...overrides };
}
function settle(overrides: Partial<KushkiWebhookPayload> = {}) {
  return h.fake.$transaction((tx) => settleKushkiEventInTx(tx as unknown as Prisma.TransactionClient, payload(overrides)));
}

beforeEach(() => vi.clearAllMocks());

describe("late terminal results after an audited manual decision", () => {
  it("records a real late approval after manual cancellation and flags reconciliation", async () => {
    seedManual("declined");
    await expect(settle()).resolves.toMatchObject({ approved: true, paid: true });
    expect(h.fake.payment("terminal-1")).toMatchObject({ status: "approved", providerRef: REAL_REF, reconciliationRequired: true });
    expect(h.fake.state.kushkiTransactions.filter((row) => row.status === "approved")).toHaveLength(1);
    expect(h.fake.state.auditEvents[0]).toMatchObject({ kind: "payment.reconciled", diff: { outcome: "declined", providerRef: MANUAL_REF } });
  });

  it("attaches the real reference to manual approval without another charge, invoice or round activation", async () => {
    seedManual("approved");
    expect(await processKushkiWebhook(payload())).toEqual({ status: "ok" });
    expect(h.fake.payment("terminal-1")).toMatchObject({ status: "approved", providerRef: REAL_REF, reconciliationRequired: false, settledAt: originalSettlement });
    expect(h.fake.state.kushkiTransactions).toEqual([
      expect.objectContaining({ kushkiTxId: REAL_REF, status: "approved", paymentId: "terminal-1", approvalCode: "VOUCHER-1" }),
    ]);
    expect(h.fake.state.financialOperations[0].providerRef).toBe(REAL_REF);
    expect(h.invoice).not.toHaveBeenCalled();
    expect(h.activate).not.toHaveBeenCalled();
    expect(h.publish).not.toHaveBeenCalledWith("rest-1", expect.objectContaining({ type: "payment.approved" }));
    expect(await processKushkiWebhook(payload({ eventId: "another-delivery" }))).toEqual({ status: "ok" });
    expect(h.fake.state.kushkiTransactions).toHaveLength(1);
    expect(h.invoice).not.toHaveBeenCalled();
  });

  it("links an actual decline to a manual decline without applying it again", async () => {
    seedManual("declined");
    expect(await settle({ type: "terminal.declined" })).toBeNull();
    expect(h.fake.payment("terminal-1")).toMatchObject({ status: "declined", providerRef: REAL_REF, reconciliationRequired: false });
    expect(h.fake.state.kushkiTransactions).toHaveLength(1);
    expect(h.fake.state.kushkiTransactions[0].kushkiTxId).toBe(REAL_REF);
  });

  it("keeps manual approval reserved and flags a contradictory real decline, including duplicate delivery", async () => {
    seedManual("approved");
    const event = payload({ type: "terminal.declined" });
    expect(await processKushkiWebhook(event)).toEqual({ status: "ok", requiresReview: true });
    expect(h.fake.payment("terminal-1")).toMatchObject({ status: "approved", providerRef: MANUAL_REF, reconciliationRequired: true });
    expect(h.fake.order().status).toBe("paid");
    expect(h.fake.state.kushkiTransactions).toHaveLength(1);
    expect(h.fake.state.kushkiTransactions[0].status).toBe("approved");
    expect(h.publish).not.toHaveBeenCalledWith("rest-1", expect.objectContaining({ type: "payment.declined" }));
    expect(h.invoice).not.toHaveBeenCalled();
    expect(await processKushkiWebhook(event)).toEqual({ status: "duplicate", requiresReview: true });
    expect(await processKushkiWebhook({ ...event, eventId: "another-decline" })).toEqual({ status: "ok", requiresReview: true });
  });

  it.each(["missing reference", "known real reference", "legacy real reference without claim"])("flags a contradictory decline with %s after manual approval", async (caseName) => {
    seedManual("approved");
    if (caseName !== "missing reference") {
      h.fake.payment("terminal-1")!.providerRef = REAL_REF;
      h.fake.state.kushkiTransactions[0].kushkiTxId = REAL_REF;
      (h.fake.state.auditEvents[0].diff as Record<string, unknown>).providerRef = REAL_REF;
    }
    if (caseName === "legacy real reference without claim") h.fake.state.financialOperations = [];
    const event = payload({ type: "terminal.declined", providerRef: caseName === "missing reference" ? undefined : REAL_REF });
    expect(await processKushkiWebhook(event)).toEqual({ status: "ok", requiresReview: true });
    expect(h.fake.payment("terminal-1")).toMatchObject({ status: "approved", reconciliationRequired: true });
    expect(await processKushkiWebhook(event)).toEqual({ status: "duplicate", requiresReview: true });
    expect(h.invoice).not.toHaveBeenCalled();
  });

  it("rolls back reference linking when the approved manual ledger is missing", async () => {
    seedManual("approved");
    h.fake.state.kushkiTransactions = [];
    await expect(settle()).rejects.toThrow("manual_ledger_missing");
    expect(h.fake.payment("terminal-1")!.providerRef).toBe(MANUAL_REF);
    expect(h.fake.state.auditEvents).toHaveLength(1);
  });

  it.each(["wrong_restaurant", "wrong_order", "wrong_amount"])("still rejects %s without changing money", async (reason) => {
    seedManual("declined");
    const invalid = { wrong_restaurant: { restaurantId: "other" }, wrong_order: { orderId: "other" }, wrong_amount: { amountCents: TOTAL + 1 } }[reason]!;
    await expect(settle(invalid)).rejects.toThrow(reason);
    expect(h.fake.payment("terminal-1")).toMatchObject({ status: "declined", providerRef: MANUAL_REF, reconciliationRequired: false });
  });

  it.each(["real reference", "different payment reference", "non-terminal", "missing audit", "wrong audit actor", "missing claim", "wrong claim amount"])(
    "does not bypass reference ownership for %s", async (caseName) => {
      seedManual("declined");
      if (caseName === "real reference") h.fake.payment("terminal-1")!.providerRef = "already-real-reference";
      if (caseName === "different payment reference") h.fake.payment("terminal-1")!.providerRef = "manual:admin-1:other-payment";
      if (caseName === "non-terminal") h.fake.payment("terminal-1")!.method = "kushki_card";
      if (caseName === "missing audit") h.fake.state.auditEvents = [];
      if (caseName === "wrong audit actor") h.fake.state.auditEvents[0].actorUserId = "other-admin";
      if (caseName === "missing claim") h.fake.state.financialOperations = [];
      if (caseName === "wrong claim amount") h.fake.state.financialOperations[0].amountCents = TOTAL + 1;
      await expect(settle()).rejects.toThrow("wrong_reference");
      expect(h.fake.payment("terminal-1")!.status).toBe("declined");
      expect(h.fake.state.kushkiTransactions).toHaveLength(1);
    },
  );

  it("rejects a real reference already owned by a different payment", async () => {
    seedManual("approved");
    h.fake.state.kushkiTransactions.push({ kushkiTxId: REAL_REF, paymentId: "other-payment", restaurantId: "rest-1" });
    await expect(settle()).rejects.toThrow("reference_in_use");
    expect(h.fake.payment("terminal-1")!.providerRef).toBe(MANUAL_REF);
  });

  it("does not revive a refunded manually approved charge", async () => {
    seedManual("approved");
    h.fake.payment("terminal-1")!.status = "refunded";
    await settle().catch(() => undefined);
    expect(h.fake.payment("terminal-1")).toMatchObject({ status: "refunded", providerRef: MANUAL_REF });
    expect(h.invoice).not.toHaveBeenCalled();
  });
});
