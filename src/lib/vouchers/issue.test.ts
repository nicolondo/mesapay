import { beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";

/**
 * Emisión y cancelación con la DB mockeada. Lo que se prueba es la
 * DECISIÓN: N bonos con saldo = valor, el link de pago sólo en prepago,
 * la empresa tiene que ser del comercio, y cancelar sólo lo que no se usó.
 */
const m = vi.hoisted(() => ({
  restaurantFindUnique: vi.fn(),
  customerFindFirst: vi.fn(),
  batchCreate: vi.fn(),
  batchUpdate: vi.fn(),
  batchFindFirst: vi.fn(),
  voucherCreateMany: vi.fn(),
  voucherFindFirst: vi.fn(),
  voucherUpdateMany: vi.fn(),
  redemptionCount: vi.fn(),
  linkCreate: vi.fn(),
  linkUpdateMany: vi.fn(),
  currency: vi.fn(),
}));

vi.mock("@/lib/billing/countries", () => ({ getCurrencyForCountry: m.currency }));
vi.mock("./email", () => ({ sendVoucherIssueEmail: vi.fn() }));

const tx = {
  voucherBatch: { create: m.batchCreate, update: m.batchUpdate },
  voucher: { createMany: m.voucherCreateMany, updateMany: m.voucherUpdateMany },
  paymentLink: { create: m.linkCreate, updateMany: m.linkUpdateMany },
};
vi.mock("@/lib/db", () => ({
  db: {
    $transaction: (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
    restaurant: { findUnique: m.restaurantFindUnique },
    billingCustomer: { findFirst: m.customerFindFirst },
    voucherBatch: { findFirst: m.batchFindFirst, update: m.batchUpdate },
    voucher: { findFirst: m.voucherFindFirst, updateMany: m.voucherUpdateMany },
    voucherRedemption: { count: m.redemptionCount },
    paymentLink: { updateMany: m.linkUpdateMany },
  },
}));

import { cancelVoucher, cancelVoucherBatch, expiryFromDays, issueVoucherBatch } from "./issue";

const input = {
  billingCustomerId: "cust-1",
  quantity: 30,
  unitValueCents: 300_000_00,
  expiryDays: null,
  note: null,
};

beforeEach(() => {
  vi.resetAllMocks();
  m.restaurantFindUnique.mockResolvedValue({
    name: "Son y Melona",
    country: "CO",
    voucherSettings: { mode: "prepaid" },
  });
  m.customerFindFirst.mockResolvedValue({ id: "cust-1" });
  m.currency.mockResolvedValue("COP");
  m.batchCreate.mockResolvedValue({ id: "batch-1" });
  m.voucherCreateMany.mockResolvedValue({ count: 30 });
  m.linkCreate.mockResolvedValue({ id: "link-1", token: "tok-abc" });
  m.redemptionCount.mockResolvedValue(0);
  m.voucherUpdateMany.mockResolvedValue({ count: 1 });
  m.linkUpdateMany.mockResolvedValue({ count: 1 });
});

describe("issueVoucherBatch", () => {
  it("crea el lote y N bonos con saldo = valor y el prefijo del comercio", async () => {
    const r = await issueVoucherBatch({ restaurantId: "rest-1", userId: "user-1", input });
    expect(r).toMatchObject({
      ok: true,
      batch: { id: "batch-1", mode: "prepaid", quantity: 30, totalCents: 9_000_000_00, paymentLinkToken: "tok-abc" },
    });
    expect(m.batchCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        restaurantId: "rest-1",
        billingCustomerId: "cust-1",
        mode: "prepaid",
        unitValueCents: 300_000_00,
        quantity: 30,
        issuedByUserId: "user-1",
      }),
    });
    const rows = m.voucherCreateMany.mock.calls[0][0].data as {
      code: string;
      valueCents: number;
      balanceCents: number;
      restaurantId: string;
    }[];
    expect(rows).toHaveLength(30);
    expect(new Set(rows.map((r) => r.code)).size).toBe(30);
    for (const row of rows) {
      expect(row.code).toMatch(/^SM[A-HJ-NP-Z2-9]{8}$/);
      expect(row.balanceCents).toBe(row.valueCents);
      expect(row.valueCents).toBe(300_000_00);
      expect(row.restaurantId).toBe("rest-1");
    }
  });

  it("prepago: crea el link de pago por el total del lote", async () => {
    await issueVoucherBatch({ restaurantId: "rest-1", userId: null, input });
    expect(m.linkCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        restaurantId: "rest-1",
        kind: "voucher_batch",
        amountCents: 9_000_000_00,
        currency: "COP",
        voucherBatchId: "batch-1",
      }),
    });
  });

  it("crédito: sin link de pago (se cobra por corte)", async () => {
    m.restaurantFindUnique.mockResolvedValue({
      name: "Son y Melona",
      country: "CO",
      voucherSettings: { mode: "credit" },
    });
    const r = await issueVoucherBatch({ restaurantId: "rest-1", userId: null, input });
    expect(r).toMatchObject({ ok: true, batch: { mode: "credit", paymentLinkToken: null } });
    expect(m.linkCreate).not.toHaveBeenCalled();
  });

  it("sin configuración guardada el modo es prepago", async () => {
    m.restaurantFindUnique.mockResolvedValue({ name: "X", country: "CO", voucherSettings: null });
    const r = await issueVoucherBatch({ restaurantId: "rest-1", userId: null, input });
    expect(r).toMatchObject({ ok: true, batch: { mode: "prepaid" } });
  });

  it("la empresa de OTRO comercio no existe para éste: nada se escribe", async () => {
    m.customerFindFirst.mockResolvedValue(null);
    const r = await issueVoucherBatch({ restaurantId: "rest-1", userId: null, input });
    expect(r).toEqual({ ok: false, error: "customer_not_found" });
    expect(m.customerFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "cust-1", restaurantId: "rest-1" } }),
    );
    expect(m.batchCreate).not.toHaveBeenCalled();
  });

  it("una colisión de código reintenta con códigos nuevos", async () => {
    m.voucherCreateMany
      .mockRejectedValueOnce(
        new Prisma.PrismaClientKnownRequestError("dup", { code: "P2002", clientVersion: "6" }),
      )
      .mockResolvedValue({ count: 30 });
    const r = await issueVoucherBatch({ restaurantId: "rest-1", userId: null, input });
    expect(r.ok).toBe(true);
    expect(m.voucherCreateMany).toHaveBeenCalledTimes(2);
    const first = m.voucherCreateMany.mock.calls[0][0].data.map((v: { code: string }) => v.code);
    const second = m.voucherCreateMany.mock.calls[1][0].data.map((v: { code: string }) => v.code);
    expect(first).not.toEqual(second);
  });

  it("la vigencia en días termina al final del día (Bogotá)", () => {
    expect(expiryFromDays(null)).toBeNull();
    const d = expiryFromDays(30, new Date("2026-09-15T15:00:00Z"));
    expect(d?.toISOString()).toBe("2026-10-16T04:59:59.000Z"); // 15/10 23:59:59 Bogotá
  });
});

describe("cancelVoucher", () => {
  it("cancela un bono sin uso", async () => {
    m.voucherFindFirst.mockResolvedValue({
      status: "active",
      valueCents: 100,
      balanceCents: 100,
      _count: { redemptions: 0 },
    });
    expect(await cancelVoucher({ restaurantId: "rest-1", voucherId: "v-1" })).toBe("ok");
    expect(m.voucherUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "v-1", restaurantId: "rest-1", status: "active" },
        data: expect.objectContaining({ status: "cancelled" }),
      }),
    );
  });
  it("un bono con uso (saldo tocado o redenciones) no se cancela", async () => {
    m.voucherFindFirst.mockResolvedValue({
      status: "active",
      valueCents: 100,
      balanceCents: 40,
      _count: { redemptions: 1 },
    });
    expect(await cancelVoucher({ restaurantId: "rest-1", voucherId: "v-1" })).toBe("used");
    expect(m.voucherUpdateMany).not.toHaveBeenCalled();
  });
  it("el bono de otro comercio no existe", async () => {
    m.voucherFindFirst.mockResolvedValue(null);
    expect(await cancelVoucher({ restaurantId: "rest-1", voucherId: "v-1" })).toBe("not_found");
    expect(m.voucherFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "v-1", restaurantId: "rest-1" } }),
    );
  });
});

describe("cancelVoucherBatch", () => {
  it("un lote prepago sin pagar y sin uso se cancela entero, con su link", async () => {
    m.batchFindFirst.mockResolvedValue({ id: "batch-1", mode: "prepaid", status: "issued" });
    expect(await cancelVoucherBatch({ restaurantId: "rest-1", batchId: "batch-1" })).toBe("ok");
    expect(m.batchUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "cancelled" }) }),
    );
    expect(m.voucherUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { batchId: "batch-1", status: "active" } }),
    );
    expect(m.linkUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { voucherBatchId: "batch-1", status: "pending" },
        data: { status: "cancelled" },
      }),
    );
  });
  it("un lote prepago ya PAGADO no se cancela entero", async () => {
    m.batchFindFirst.mockResolvedValue({ id: "batch-1", mode: "prepaid", status: "paid" });
    expect(await cancelVoucherBatch({ restaurantId: "rest-1", batchId: "batch-1" })).toBe("paid");
    expect(m.batchUpdate).not.toHaveBeenCalled();
  });
  it("con bonos usados no se cancela", async () => {
    m.batchFindFirst.mockResolvedValue({ id: "batch-1", mode: "credit", status: "issued" });
    m.redemptionCount.mockResolvedValue(2);
    expect(await cancelVoucherBatch({ restaurantId: "rest-1", batchId: "batch-1" })).toBe("used");
    expect(m.batchUpdate).not.toHaveBeenCalled();
  });
  it("el lote de otro comercio no existe", async () => {
    m.batchFindFirst.mockResolvedValue(null);
    expect(await cancelVoucherBatch({ restaurantId: "rest-1", batchId: "batch-x" })).toBe("not_found");
  });
});
