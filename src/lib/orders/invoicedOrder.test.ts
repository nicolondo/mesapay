// Cuenta FACTURADA (factura antes de cobrar): no cambia. Todo cambio de la
// cuenta pasa por `requireMutableOrderInTx` / `recomputeOrderLinesInTx`, y
// los dos la rechazan con `OrderInvoicedError` (409 order_invoiced).
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ db: {} }));

import { assertOrderNotInvoicedInTx, isInvoiceAnnulled, orderInvoiceViewOf } from "./invoicedOrder";
import { OrderInvoicedError } from "./orderInvoicedError";
import { recomputeOrderLinesInTx, requireMutableOrderInTx } from "../orders";

const inv = {
  id: "inv-1",
  invoiceNumber: 6490,
  snapshot: { invoicePrefix: "FESM", issuedBeforePayment: true },
};

function fakeTx(over: { invoice?: typeof inv | null; status?: string; payments?: number } = {}) {
  return {
    $queryRaw: vi.fn(async () => []),
    order: {
      findUniqueOrThrow: vi.fn(async () => ({ id: "o1", status: over.status ?? "served", discountPct: null, tipCents: 0 })),
      update: vi.fn(async () => ({})),
    },
    orderItem: { findMany: vi.fn(async () => []) },
    payment: { count: vi.fn(async () => over.payments ?? 0) },
    simpleInvoice: { findUnique: vi.fn(async () => (over.invoice === undefined ? inv : over.invoice)) },
  };
}
type Tx = Parameters<typeof requireMutableOrderInTx>[0];

describe("cuenta facturada — no cambia", () => {
  it("assertOrderNotInvoicedInTx: con factura lanza OrderInvoicedError con su número", async () => {
    const err = await assertOrderNotInvoicedInTx(fakeTx() as unknown as Tx, "o1").catch((e) => e);
    expect(err).toBeInstanceOf(OrderInvoicedError);
    expect((err as OrderInvoicedError).invoice).toEqual({ invoiceId: "inv-1", documentNumber: "FESM6490" });
    expect((err as Error).message).toBe("order_invoiced");
  });

  it("sin factura no hace nada", async () => {
    await expect(assertOrderNotInvoicedInTx(fakeTx({ invoice: null }) as unknown as Tx, "o1")).resolves.toBeUndefined();
  });

  it("requireMutableOrderInTx (agregar líneas libres, cancelar, no cobrar, mover un plato, cancelar la cuenta) la rechaza", async () => {
    const tx = fakeTx();
    await expect(requireMutableOrderInTx(tx as unknown as Tx, "o1")).rejects.toBeInstanceOf(OrderInvoicedError);
    // Ni siquiera llega a mirar los pagos: la factura manda.
    expect(tx.payment.count).not.toHaveBeenCalled();
  });

  it("una cuenta sin factura sigue la regla de siempre", async () => {
    const tx = fakeTx({ invoice: null });
    await expect(requireMutableOrderInTx(tx as unknown as Tx, "o1")).resolves.toMatchObject({ id: "o1" });
    await expect(
      requireMutableOrderInTx(fakeTx({ invoice: null, payments: 1 }) as unknown as Tx, "o1"),
    ).rejects.toThrow("operation_conflict");
  });

  it("recomputeOrderLinesInTx (cinturón y tirantes) tampoco recalcula una cuenta facturada", async () => {
    const tx = fakeTx();
    await expect(recomputeOrderLinesInTx(tx as unknown as Tx, "o1")).rejects.toBeInstanceOf(OrderInvoicedError);
    expect(tx.order.update).not.toHaveBeenCalled();
  });
});

describe("anulación con nota crédito", () => {
  const client = (sum: number | null) => ({
    creditNote: { aggregate: vi.fn(async () => ({ _sum: { totalCents: sum } })) },
  });

  it("notas aceptadas que cubren la factura entera = anulada", async () => {
    const c = client(100_000_00);
    expect(await isInvoiceAnnulled(c as never, { id: "inv-1", totalCents: 100_000_00 })).toBe(true);
    expect(c.creditNote.aggregate).toHaveBeenCalledWith({
      where: { originalInvoiceId: "inv-1", abandonedAt: null, dianDocument: { is: { state: "accepted" } } },
      _sum: { totalCents: true },
    });
  });

  it("una nota parcial (o ninguna) no la anula", async () => {
    expect(await isInvoiceAnnulled(client(40_000_00) as never, { id: "inv-1", totalCents: 100_000_00 })).toBe(false);
    expect(await isInvoiceAnnulled(client(null) as never, { id: "inv-1", totalCents: 100_000_00 })).toBe(false);
  });

  it("la vista de la ficha dice número, estado DIAN y si está anulada", async () => {
    const view = await orderInvoiceViewOf(client(0) as never, {
      ...inv,
      totalCents: 100_000_00,
      dianDocument: { state: "to_send", lastError: "resolution_incomplete" },
    });
    expect(view).toEqual({
      invoiceId: "inv-1",
      documentNumber: "FESM6490",
      issuedBeforePayment: true,
      dianState: "to_send",
      dianLastError: "resolution_incomplete",
      annulled: false,
    });
    expect(await orderInvoiceViewOf(client(0) as never, null)).toBeNull();
  });
});

beforeEach(() => vi.clearAllMocks());
