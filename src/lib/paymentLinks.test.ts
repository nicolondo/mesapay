import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Cierre de un link de pago y su efecto (lote de bonos → paid), por los
 * dos rieles que pueden llegar: la ruta de cobro/retorno y el webhook de
 * Kushki. La idempotencia importa porque los dos pueden llegar.
 */
const m = vi.hoisted(() => ({
  linkFindUnique: vi.fn(),
  linkFindFirst: vi.fn(),
  linkUpdateMany: vi.fn(),
  batchUpdateMany: vi.fn(),
  eventCreateMany: vi.fn(),
  eventFindUniqueOrThrow: vi.fn(),
  eventUpdate: vi.fn(),
  queryRaw: vi.fn(),
  publish: vi.fn(),
}));

const tx = {
  paymentLink: {
    findUnique: m.linkFindUnique,
    findFirst: m.linkFindFirst,
    updateMany: m.linkUpdateMany,
  },
  voucherBatch: { updateMany: m.batchUpdateMany },
  kushkiWebhookEvent: {
    createMany: m.eventCreateMany,
    findUniqueOrThrow: m.eventFindUniqueOrThrow,
    update: m.eventUpdate,
  },
  $queryRaw: m.queryRaw,
};

vi.mock("@/lib/db", () => ({
  db: {
    $transaction: (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
    paymentLink: { findFirst: m.linkFindFirst },
  },
}));
vi.mock("@/lib/events", () => ({ publishOrderEvent: m.publish }));
vi.mock("@/lib/orderLock", () => ({ lockOrder: vi.fn() }));
vi.mock("@/lib/orderTotals", () => ({ recomputeOrderTotalsInTx: vi.fn() }));
vi.mock("@/lib/prepaidRounds", () => ({ activateOpenRounds: vi.fn() }));
vi.mock("@/lib/invoiceOnPaid", () => ({ issueInvoiceOnPaid: vi.fn() }));
vi.mock("@/lib/kds/autoFireTickets", () => ({ notifyAutoFiredTickets: vi.fn() }));

import {
  newPaymentLinkToken,
  paymentLinkIsOpen,
  paymentLinkPath,
  settlePaymentLinkInTx,
} from "./paymentLinks";
import { processKushkiWebhook, settleKushkiEventInTx } from "./payments/webhookHandler";

const pendingLink = {
  id: "link-1",
  restaurantId: "rest-1",
  kind: "voucher_batch" as const,
  status: "pending" as const,
  voucherBatchId: "batch-1",
  providerRef: null,
  method: null,
  payerEmail: null,
  expiresAt: null,
};

beforeEach(() => {
  vi.resetAllMocks();
  m.linkFindUnique.mockResolvedValue(pendingLink);
  m.linkFindFirst.mockResolvedValue(pendingLink);
  m.linkUpdateMany.mockResolvedValue({ count: 1 });
  m.batchUpdateMany.mockResolvedValue({ count: 1 });
});

describe("settlePaymentLinkInTx", () => {
  it("aprobado: el link queda pagado y el lote de bonos pasa a paid", async () => {
    const r = await settlePaymentLinkInTx(
      tx as never,
      { id: "link-1" },
      { approved: true, providerRef: "tx-9", method: "kushki_card" },
    );
    expect(r).toEqual({
      status: "paid",
      link: { id: "link-1", restaurantId: "rest-1", kind: "voucher_batch", voucherBatchId: "batch-1" },
    });
    expect(m.linkUpdateMany).toHaveBeenCalledWith({
      where: { id: "link-1", status: "pending" },
      data: expect.objectContaining({ status: "paid", providerRef: "tx-9", method: "kushki_card" }),
    });
    expect(m.batchUpdateMany).toHaveBeenCalledWith({
      where: { id: "batch-1", status: "issued" },
      data: expect.objectContaining({ status: "paid" }),
    });
  });

  it("rechazado: el link sigue pendiente y el lote no se toca", async () => {
    const r = await settlePaymentLinkInTx(tx as never, { id: "link-1" }, { approved: false });
    expect(r).toEqual({ status: "declined" });
    expect(m.linkUpdateMany).not.toHaveBeenCalled();
    expect(m.batchUpdateMany).not.toHaveBeenCalled();
  });

  it("ya pagado (segundo riel): no se aplica el efecto dos veces", async () => {
    m.linkFindUnique.mockResolvedValue({ ...pendingLink, status: "paid" });
    const r = await settlePaymentLinkInTx(tx as never, { id: "link-1" }, { approved: true });
    expect(r).toEqual({ status: "already_paid" });
    expect(m.batchUpdateMany).not.toHaveBeenCalled();
  });

  it("carrera entre rieles: si el updateMany no pegó, tampoco se aplica el efecto", async () => {
    m.linkUpdateMany.mockResolvedValue({ count: 0 });
    const r = await settlePaymentLinkInTx(tx as never, { id: "link-1" }, { approved: true });
    expect(r).toEqual({ status: "already_paid" });
    expect(m.batchUpdateMany).not.toHaveBeenCalled();
  });

  it("cancelado o inexistente", async () => {
    m.linkFindUnique.mockResolvedValue({ ...pendingLink, status: "cancelled" });
    expect(await settlePaymentLinkInTx(tx as never, { id: "link-1" }, { approved: true })).toEqual({
      status: "not_pending",
    });
    m.linkFindUnique.mockResolvedValue(null);
    expect(await settlePaymentLinkInTx(tx as never, { id: "nope" }, { approved: true })).toEqual({
      status: "not_found",
    });
  });
});

describe("webhook de Kushki sin Payment de orden", () => {
  it("casa el link por providerRef y marca el lote pagado", async () => {
    const r = await settleKushkiEventInTx(tx as never, {
      eventId: "evt-1",
      type: "pse.approved",
      restaurantId: "rest-1",
      providerRef: "pse-token-1",
    });
    expect(r).toBeNull();
    expect(m.linkFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { providerRef: "pse-token-1" } }),
    );
    expect(m.linkUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "paid" }) }),
    );
    expect(m.batchUpdateMany).toHaveBeenCalled();
  });

  it("un aviso de otro comercio sobre ese link se rechaza", async () => {
    await expect(
      settleKushkiEventInTx(tx as never, {
        eventId: "evt-2",
        type: "pse.approved",
        restaurantId: "rest-otro",
        providerRef: "pse-token-1",
      }),
    ).rejects.toThrow("wrong_restaurant");
    expect(m.linkUpdateMany).not.toHaveBeenCalled();
  });

  it("sin link ni Payment sigue siendo missing_payment", async () => {
    m.linkFindFirst.mockResolvedValue(null);
    await expect(
      settleKushkiEventInTx(tx as never, { eventId: "evt-3", type: "charge.approved", providerRef: "x" }),
    ).rejects.toThrow("missing_payment");
  });

  it("el flujo completo del webhook lo procesa como ok, sin eventos de orden", async () => {
    m.eventCreateMany.mockResolvedValue({ count: 1 });
    m.queryRaw.mockResolvedValue([]);
    m.eventFindUniqueOrThrow.mockResolvedValue({ id: "e-1", processedAt: null });
    m.eventUpdate.mockResolvedValue({});
    const r = await processKushkiWebhook({
      eventId: "kushki:pse-token-1:ok",
      type: "pse.approved",
      providerRef: "pse-token-1",
    });
    expect(r).toEqual({ status: "ok" });
    expect(m.batchUpdateMany).toHaveBeenCalled();
    expect(m.publish).not.toHaveBeenCalled();
  });
});

describe("helpers", () => {
  it("el token es url-safe y no enumerable; la URL es pública por slug", () => {
    const t = newPaymentLinkToken();
    expect(t).toMatch(/^[A-Za-z0-9_-]{24}$/);
    expect(newPaymentLinkToken()).not.toBe(t);
    expect(paymentLinkPath("son-y-melona", t)).toBe(`/r/son-y-melona/pago/${t}`);
  });
  it("un link vencido o no pendiente está cerrado", () => {
    expect(paymentLinkIsOpen({ status: "pending", expiresAt: null })).toBe(true);
    expect(paymentLinkIsOpen({ status: "paid", expiresAt: null })).toBe(false);
    expect(paymentLinkIsOpen({ status: "pending", expiresAt: new Date(Date.now() - 1000) })).toBe(false);
  });
});
