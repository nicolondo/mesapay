import { describe, expect, it } from "vitest";
import {
  allocationError,
  drawFromCredits,
  payableKey,
  planCreditAllocation,
  previewAllocation,
  sortPayablesFifo,
  type PayableDocRef,
} from "./supplierCreditAllocation";

const doc = (id: string, dueDate: string, outstandingCents: number, extra: Partial<PayableDocRef> = {}): PayableDocRef => ({
  kind: "purchase",
  id,
  number: id.toUpperCase(),
  purchaseNumber: 1,
  date: dueDate,
  dueDate,
  totalCents: outstandingCents,
  outstandingCents,
  ...extra,
});

describe("orden FIFO", () => {
  it("vencimiento, luego fecha, compras antes que gastos, luego id", () => {
    const docs = [
      doc("c", "2026-11-20", 1),
      doc("b", "2026-11-10", 1, { date: "2026-11-05" }),
      doc("a", "2026-11-10", 1, { date: "2026-11-01" }),
      doc("e", "2026-11-10", 1, { date: "2026-11-01", kind: "expense" }),
    ];
    expect(sortPayablesFifo(docs).map((d) => d.id)).toEqual(["a", "e", "b", "c"]);
  });
});

describe("plan de cruce", () => {
  const docs = [doc("old", "2026-10-01", 30_000), doc("mid", "2026-10-15", 50_000), doc("new", "2026-11-01", 40_000)];

  it("sin facturas relacionadas: FIFO por las más antiguas", () => {
    expect(planCreditAllocation(60_000, docs)).toEqual([
      { kind: "purchase", id: "old", amountCents: 30_000 },
      { kind: "purchase", id: "mid", amountCents: 30_000 },
    ]);
  });

  it("primero las relacionadas, lo que sobra FIFO", () => {
    expect(planCreditAllocation(60_000, docs, [payableKey({ kind: "purchase", id: "new" })])).toEqual([
      { kind: "purchase", id: "new", amountCents: 40_000 },
      { kind: "purchase", id: "old", amountCents: 20_000 },
    ]);
  });

  it("nota mayor que lo pendiente: cruza todo y el remanente queda fuera (saldo a favor)", () => {
    const plan = planCreditAllocation(150_000, docs);
    expect(plan.reduce((s, a) => s + a.amountCents, 0)).toBe(120_000);
  });

  it("sin nada pendiente: plan vacío (todo a saldo a favor)", () => {
    expect(planCreditAllocation(150_000, [])).toEqual([]);
  });

  it("vista previa: saldo → aplicado → saldo nuevo", () => {
    const prev = previewAllocation(planCreditAllocation(35_000, docs), docs);
    expect(prev.map((d) => [d.id, d.appliedCents, d.newOutstandingCents])).toEqual([
      ["old", 30_000, 0],
      ["mid", 5_000, 45_000],
    ]);
  });
});

describe("plan elegido a mano", () => {
  const docs = [doc("a", "2026-10-01", 10_000), doc("b", "2026-10-02", 10_000)];
  it("valida montos, documentos, saldos y el valor de la nota", () => {
    expect(allocationError([{ kind: "purchase", id: "a", amountCents: 5_000 }], docs, 5_000)).toBeNull();
    expect(allocationError([{ kind: "purchase", id: "a", amountCents: 0 }], docs, 5_000)).toBe("amount_invalid");
    expect(allocationError([{ kind: "purchase", id: "z", amountCents: 1 }], docs, 5_000)).toBe("unknown_doc");
    expect(allocationError([{ kind: "expense", id: "a", amountCents: 1 }], docs, 5_000)).toBe("unknown_doc");
    expect(allocationError([{ kind: "purchase", id: "a", amountCents: 10_001 }], docs, 50_000)).toBe("exceeds_balance");
    expect(
      allocationError(
        [
          { kind: "purchase", id: "a", amountCents: 1 },
          { kind: "purchase", id: "a", amountCents: 1 },
        ],
        docs,
        50_000,
      ),
    ).toBe("duplicate_doc");
    expect(
      allocationError(
        [
          { kind: "purchase", id: "a", amountCents: 6_000 },
          { kind: "purchase", id: "b", amountCents: 6_000 },
        ],
        docs,
        10_000,
      ),
    ).toBe("exceeds_available");
  });
});

describe("consumir saldos a favor", () => {
  it("de la nota más vieja a la más nueva, hasta lo pedido", () => {
    const credits = [
      { id: "n2", date: "2026-10-05", availableCents: 7_000 },
      { id: "n1", date: "2026-10-01", availableCents: 5_000 },
      { id: "n0", date: "2026-09-01", availableCents: 0 },
    ];
    expect(drawFromCredits(credits, 9_000).map((d) => [d.credit.id, d.amountCents])).toEqual([
      ["n1", 5_000],
      ["n2", 4_000],
    ]);
  });
});
