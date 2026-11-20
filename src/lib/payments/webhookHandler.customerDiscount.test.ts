// El descuento que puso el paso «Cliente» pertenece a ESE cobro: si el pago
// del datáfono (o cualquier cobro de Kushki) se rechaza y la cuenta queda sin
// pagos vivos, vuelve sin él. Nunca con pagos aprobados, nunca el del comensal.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakePaymentsDb } from "@/test/fakePaymentsDb";

const h = vi.hoisted(() => ({
  fake: null as unknown as ReturnType<typeof import("@/test/fakePaymentsDb").createFakePaymentsDb>,
  publish: vi.fn(),
}));
vi.mock("@/lib/db", () => ({ db: { $transaction: (cb: never) => h.fake.$transaction(cb) } }));
vi.mock("@/lib/orderLock", () => ({ lockOrder: async () => {} }));
vi.mock("@/lib/events", () => ({ publishOrderEvent: h.publish }));
vi.mock("@/lib/invoiceOnPaid", () => ({ issueInvoiceOnPaid: vi.fn(async () => undefined) }));
vi.mock("@/lib/prepaidRounds", () => ({ activateOpenRounds: vi.fn(async () => []) }));
vi.mock("@/lib/kds/autoFireTickets", () => ({ notifyAutoFiredTickets: async () => {} }));

import { processKushkiWebhook } from "./webhookHandler";

const SUBTOTAL = 60_000;
const DISCOUNT = 12_000; // 20 % del cliente

function seed(opts: {
  origin?: string | null;
  payments?: Array<Record<string, unknown>>;
  invoiced?: boolean;
}) {
  const events = new Map<string, Record<string, unknown>>();
  h.fake = createFakePaymentsDb({
    order: {
      id: "order-1",
      status: "paying",
      subtotalCents: SUBTOTAL,
      discountCents: DISCOUNT,
      discountPct: 20,
      totalCents: SUBTOTAL - DISCOUNT,
      discountBillingCustomerId: opts.origin === undefined ? "cust-1" : opts.origin,
      discountAppliedAt: new Date("2026-11-18T18:20:00Z"),
      table: { kind: "standard" },
    },
    payments: opts.payments ?? [
      { id: "terminal-1", method: "kushki_card_terminal", amountCents: SUBTOTAL - DISCOUNT, status: "pending" },
    ],
    rounds: [{ status: "served" }],
    extraTx: {
      simpleInvoice: { count: async () => (opts.invoiced ? 1 : 0) },
      kushkiWebhookEvent: {
        createMany: async ({ data }: { data: Array<{ eventId: string }> }) => {
          for (const row of data) if (!events.has(row.eventId)) events.set(row.eventId, { ...row, id: row.eventId, processedAt: null });
        },
        findUniqueOrThrow: async ({ where }: { where: { eventId: string } }) => events.get(where.eventId),
        update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) =>
          Object.assign(events.get(where.id)!, data),
      },
    },
  });
}

const declined = (paymentId = "terminal-1") =>
  processKushkiWebhook({
    eventId: `cloudterm:${paymentId}:no:1`,
    type: "terminal.declined",
    restaurantId: "rest-1",
    paymentId,
    message: "Rechazada",
  });

beforeEach(() => vi.clearAllMocks());

describe("pago rechazado → se deshace el descuento del cliente de ese cobro", () => {
  it("datáfono rechazado: la cuenta vuelve a su estado de cocina y sin el 20 %", async () => {
    seed({});
    expect(await declined()).toEqual({ status: "ok" });
    expect(h.fake.payment("terminal-1")?.status).toBe("declined");
    expect(h.fake.order()).toMatchObject({
      status: "served",
      discountPct: null,
      discountCents: 0,
      discountBillingCustomerId: null,
      discountAppliedAt: null,
      totalCents: SUBTOTAL,
    });
    expect(h.fake.state.auditEvents).toContainEqual(
      expect.objectContaining({ kind: "order.customer_discount_reverted", targetId: "order-1", diff: expect.objectContaining({ reason: "charge_failed", billingCustomerId: "cust-1" }) }),
    );
    expect(h.publish).toHaveBeenCalledWith("rest-1", { type: "order.updated", orderId: "order-1" });
  });

  it("idempotente: el mismo aviso repetido no vuelve a escribir", async () => {
    seed({});
    await declined();
    const audits = h.fake.state.auditEvents.length;
    expect(await declined()).toEqual({ status: "duplicate" });
    expect(h.fake.state.auditEvents).toHaveLength(audits);
  });

  it("con un pago parcial ya aprobado (cobro mixto) el descuento se queda", async () => {
    seed({
      payments: [
        { id: "cash-1", method: "cash", amountCents: 20_000, status: "approved" },
        { id: "terminal-1", method: "kushki_card_terminal", amountCents: 28_000, status: "pending" },
      ],
    });
    await declined();
    expect(h.fake.order()).toMatchObject({ discountCents: DISCOUNT, discountBillingCustomerId: "cust-1" });
    expect(h.fake.state.auditEvents.some((a) => a.kind === "order.customer_discount_reverted")).toBe(false);
  });

  it("cuenta ya facturada: el descuento quedó en la factura, no se toca", async () => {
    seed({ invoiced: true });
    await declined();
    expect(h.fake.order()).toMatchObject({ discountCents: DISCOUNT, discountBillingCustomerId: "cust-1" });
  });

  it("el descuento del COMENSAL (sin origen de cliente) nunca se revierte", async () => {
    seed({ origin: null });
    await declined();
    expect(h.fake.order()).toMatchObject({ status: "served", discountCents: DISCOUNT, discountPct: 20 });
  });
});
