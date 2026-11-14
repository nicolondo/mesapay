import { describe, expect, it } from "vitest";
import { buildSupplierPaymentEntries, type PaymentFact } from "./supplierPaymentPosting";

const day = (d: Date) => d.toISOString().slice(0, 10);
const fn = { calendarDay: day, businessDay: day, entryDate: (d: string) => new Date(`${d}T05:00:00.000Z`) };
const pay = (over: Partial<PaymentFact> = {}): PaymentFact => ({
  date: new Date("2026-11-10T17:00:00Z"),
  voidedAt: null,
  accountCode: "111005",
  amountCents: 100_000,
  purchaseCents: 70_000,
  expenseCents: 20_000,
  advanceCents: 10_000,
  ...over,
});

describe("asientos de los comprobantes de egreso", () => {
  it("D proveedores + costos y gastos por pagar + anticipo · C banco", () => {
    const [e] = buildSupplierPaymentEntries({ payments: [pay()], voids: [] }, fn);
    expect(e!.source).toBe("supplier_payment");
    expect(e!.lines).toEqual([
      { code: "220505", debit: 70_000 },
      { code: "233505", debit: 20_000 },
      { code: "133005", debit: 10_000 },
      { code: "111005", credit: 100_000 },
    ]);
  });

  it("la anulación es el reverso exacto el día que se anula", () => {
    const v = pay({ voidedAt: new Date("2026-11-20T15:00:00Z") });
    const entries = buildSupplierPaymentEntries({ payments: [v], voids: [v] }, fn);
    expect(entries.map((e) => [e.source, e.day])).toEqual([
      ["supplier_payment", "2026-11-10"],
      ["supplier_payment_void", "2026-11-20"],
    ]);
    expect(entries[1]!.lines).toEqual([
      { code: "111005", debit: 100_000 },
      { code: "220505", credit: 70_000 },
      { code: "233505", credit: 20_000 },
      { code: "133005", credit: 10_000 },
    ]);
  });

  it("un comprobante sólo de cruces (sin dinero) no asienta nada aquí", () => {
    expect(buildSupplierPaymentEntries({ payments: [pay({ amountCents: 0, purchaseCents: 0, expenseCents: 0, advanceCents: 0 })], voids: [] }, fn)).toEqual([]);
  });
});
