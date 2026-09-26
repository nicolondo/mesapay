// Preparación del cobro del staff contra una base en memoria que reproduce
// el trigger `mesapay_reserve_payment`: qué se declina, qué se respeta y
// cuándo sale el error accionable.
import { describe, expect, it, vi } from "vitest";
import type { Prisma } from "@prisma/client";
import { createFakePaymentsDb } from "@/test/fakePaymentsDb";

vi.mock("@/lib/db", () => ({ db: {} }));

import {
  PendingPaymentInFlightError,
  findPaymentInFlight,
  prepareStaffCharge,
  releasePaymentRequests,
  staffOutstanding,
} from "./staffCharge";

const ORDER = "order-1";
const asTx = (fake: ReturnType<typeof createFakePaymentsDb>) => fake.tx as unknown as Prisma.TransactionClient;

function setup(payments: Parameters<typeof createFakePaymentsDb>[0]["payments"], subtotalCents = 100_000) {
  return createFakePaymentsDb({ order: { id: ORDER, subtotalCents }, payments });
}

describe("releasePaymentRequests", () => {
  it("declina SÓLO las solicitudes pendientes del comensal (efectivo, demo_cash, datáfono propio)", async () => {
    const fake = setup([
      { id: "cash", method: "cash", status: "pending", amountCents: 10_000 },
      { id: "old-cash", method: "demo_cash", status: "pending", amountCents: 10_000 },
      { id: "ext", method: "external_terminal", status: "pending", amountCents: 10_000 },
      { id: "pse", method: "kushki_pse", status: "pending", amountCents: 10_000 },
      { id: "smart", method: "kushki_card_terminal", status: "pending", amountCents: 10_000 },
      { id: "paid-cash", method: "cash", status: "approved", amountCents: 10_000 },
    ]);
    expect(await releasePaymentRequests(asTx(fake), ORDER)).toBe(3);
    expect(fake.payment("cash")?.status).toBe("declined");
    expect(fake.payment("old-cash")?.status).toBe("declined");
    expect(fake.payment("ext")?.status).toBe("declined");
    expect(fake.payment("pse")?.status).toBe("pending");
    expect(fake.payment("smart")?.status).toBe("pending");
    expect(fake.payment("paid-cash")?.status).toBe("approved");
  });
});

describe("findPaymentInFlight / staffOutstanding", () => {
  it("el pendiente en vuelo más viejo, con lo que la pantalla necesita", async () => {
    const fake = setup([
      { id: "ext", method: "external_terminal", status: "pending", amountCents: 50_000 },
      { id: "pse", method: "kushki_pse", status: "pending", amountCents: 30_000, tipCents: 3_000 },
      { id: "card", method: "kushki_card", status: "pending", amountCents: 20_000 },
    ]);
    expect(await findPaymentInFlight(asTx(fake), ORDER)).toEqual({
      paymentId: "pse",
      method: "kushki_pse",
      amountCents: 30_000,
      tipCents: 3_000,
      createdAt: fake.payment("pse")!.createdAt.toISOString(),
    });
  });

  it("sin pendientes en vuelo → null (las solicitudes no cuentan)", async () => {
    const fake = setup([{ id: "ext", method: "external_terminal", status: "pending", amountCents: 50_000 }]);
    expect(await findPaymentInFlight(asTx(fake), ORDER)).toBeNull();
  });

  it("lo pendiente para el staff: menos lo aprobado y lo en vuelo, sin las solicitudes; nunca la propina", async () => {
    const fake = setup([
      { method: "cash", status: "approved", amountCents: 22_000, tipCents: 2_000 },
      { method: "kushki_pse", status: "pending", amountCents: 30_000 },
      { method: "external_terminal", status: "pending", amountCents: 50_000 },
    ]);
    expect(await staffOutstanding(asTx(fake), ORDER)).toEqual({
      outstandingCents: 100_000 - 20_000 - 30_000,
      outstandingIgnoringInFlightCents: 100_000 - 20_000,
      closed: false,
    });
  });
});

describe("prepareStaffCharge", () => {
  it("datáfono propio pendiente por el total: lo declina y el cobro entra por el trigger", async () => {
    const fake = setup([
      { id: "ext", method: "external_terminal", status: "pending", amountCents: 110_000, tipCents: 10_000 },
    ]);
    await fake.$transaction(async (tx) => {
      const t = tx as unknown as Prisma.TransactionClient;
      expect(await prepareStaffCharge(t, ORDER, 100_000)).toEqual({ declinedRequests: 1 });
      await tx.payment.create({ data: { orderId: ORDER, method: "cash", status: "approved", amountCents: 110_000, tipCents: 10_000 } });
    });
    expect(fake.payment("ext")?.status).toBe("declined");
    expect(fake.state.payments.filter((p) => p.status === "approved")).toHaveLength(1);
  });

  it("un pago en línea que no deja espacio → PendingPaymentInFlightError y la transacción no declina nada", async () => {
    const fake = setup([
      { id: "pse", method: "kushki_pse", status: "pending", amountCents: 60_000 },
      { id: "cash", method: "cash", status: "pending", amountCents: 40_000 },
    ]);
    const err = await fake
      .$transaction((tx) => prepareStaffCharge(tx as unknown as Prisma.TransactionClient, ORDER, 100_000))
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PendingPaymentInFlightError);
    expect((err as PendingPaymentInFlightError).pending).toMatchObject({ paymentId: "pse", method: "kushki_pse", amountCents: 60_000 });
    expect(fake.payment("cash")?.status).toBe("pending");
  });

  it("si el cobro no entra por OTRA razón (pantalla vieja, ya se cobró), no culpa al pago en vuelo: deja que el trigger decida", async () => {
    const fake = setup([
      { method: "cash", status: "approved", amountCents: 50_000 },
      { id: "pse", method: "kushki_pse", status: "pending", amountCents: 20_000 },
    ]);
    // Intenta cobrar el total original: ni sin el PSE entraría.
    await expect(
      fake.$transaction((tx) => prepareStaffCharge(tx as unknown as Prisma.TransactionClient, ORDER, 100_000)),
    ).resolves.toEqual({ declinedRequests: 0 });
  });

  it("un peso de holgura, como el trigger (redondeo de partes iguales)", async () => {
    const fake = setup([{ method: "kushki_pse", status: "pending", amountCents: 50_000 }]);
    await expect(
      fake.$transaction((tx) => prepareStaffCharge(tx as unknown as Prisma.TransactionClient, ORDER, 50_001)),
    ).resolves.toEqual({ declinedRequests: 0 });
  });
});
