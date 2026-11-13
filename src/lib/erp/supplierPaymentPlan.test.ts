import { describe, expect, it } from "vitest";
import { sortPayablesFifo, type PayableDocRef } from "./supplierCreditAllocation";
import { planSupplierPayment, type PaymentCredit } from "./supplierPaymentPlan";

const doc = (id: string, dueDate: string, outstandingCents: number, kind: PayableDocRef["kind"] = "purchase"): PayableDocRef => ({
  kind,
  id,
  number: id,
  purchaseNumber: null,
  date: dueDate,
  dueDate,
  totalCents: outstandingCents,
  outstandingCents,
});
const note = (id: string, availableCents: number, related: string[] = []): PaymentCredit => ({
  source: "note",
  id,
  label: id,
  date: "2026-10-01",
  availableCents,
  relatedKeys: related.map((r) => `purchase:${r}`),
});

describe("pagar a proveedor: plan", () => {
  // Orden FIFO por vencimiento: c (sep) → a (oct) → b (nov).
  const docs = sortPayablesFifo([doc("b", "2026-11-30", 50_000), doc("a", "2026-10-15", 30_000), doc("c", "2026-09-30", 20_000)]);

  it("FIFO por vencimiento: el dinero cubre la que vence antes primero; pago parcial", () => {
    const plan = planSupplierPayment({ docs, credits: [], amountCents: 40_000 });
    expect(plan.moneyUses).toEqual([
      { kind: "purchase", id: "c", amountCents: 20_000 },
      { kind: "purchase", id: "a", amountCents: 20_000 },
    ]);
    expect(plan.totals).toMatchObject({ pendingCents: 100_000, netToPayCents: 100_000, appliedMoneyCents: 40_000, advanceCents: 0, leftUnpaidCents: 60_000 });
  });

  it("primero las notas crédito: la que relaciona factura va a esa; la que no, FIFO; luego el dinero", () => {
    const plan = planSupplierPayment({
      docs,
      credits: [note("rel", 10_000, ["b"]), note("free", 25_000)],
      amountCents: 65_000,
    });
    expect(plan.creditUses).toEqual([
      { source: "note", creditId: "rel", kind: "purchase", docId: "b", amountCents: 10_000 },
      { source: "note", creditId: "free", kind: "purchase", docId: "c", amountCents: 20_000 },
      { source: "note", creditId: "free", kind: "purchase", docId: "a", amountCents: 5_000 },
    ]);
    expect(plan.totals).toMatchObject({ creditsCents: 35_000, netToPayCents: 65_000, appliedMoneyCents: 65_000, advanceCents: 0, leftUnpaidCents: 0 });
    expect(plan.docs.map((d) => [d.id, d.creditCents, d.moneyCents, d.newOutstandingCents])).toEqual([
      ["c", 20_000, 0, 0],
      ["a", 5_000, 25_000, 0],
      ["b", 10_000, 40_000, 0],
    ]);
  });

  it("pagar de más: el excedente es anticipo", () => {
    const plan = planSupplierPayment({ docs: [doc("x", "2026-10-01", 10_000)], credits: [], amountCents: 15_000 });
    expect(plan.totals).toMatchObject({ appliedMoneyCents: 10_000, advanceCents: 5_000, leftUnpaidCents: 0 });
  });

  it("sin nada pendiente, todo el dinero es anticipo", () => {
    expect(planSupplierPayment({ docs: [], credits: [], amountCents: 7_000 }).totals.advanceCents).toBe(7_000);
  });

  it("respeta el orden que elija el operador y una nota más grande que lo pendiente sobra", () => {
    const manual = [docs[2]!, docs[0]!]; // b antes que c, sin a
    const plan = planSupplierPayment({ docs: manual, credits: [note("n", 100_000)], amountCents: 0 });
    expect(plan.creditUses.map((u) => [u.docId, u.amountCents])).toEqual([
      ["b", 50_000],
      ["c", 20_000],
    ]);
    expect(plan.totals.netToPayCents).toBe(0);
  });

  it("cruza gastos igual que compras", () => {
    const plan = planSupplierPayment({ docs: [doc("g", "2026-09-01", 8_000, "expense")], credits: [], amountCents: 8_000 });
    expect(plan.moneyUses).toEqual([{ kind: "expense", id: "g", amountCents: 8_000 }]);
  });
});
