// Cartera por cobrar con ventas a crédito: cada cuenta cobrada a crédito es
// un documento que vence a la fecha + plazo del cliente; los abonos se
// aplican FIFO y el saldo por documento alimenta las edades.
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ db: {} }));

import { creditMovementsFor } from "./carteraQueries";
import { agingBucket, buildPartnerSummary, buildStatement } from "./cartera";

const HOY = "2026-09-21";
const customer = {
  id: "cust-1",
  customerName: "ACME S.A.S.",
  docType: "NIT",
  docNumber: "901944469",
  verificationDigit: "1",
  creditTermsDays: 30,
};
const charge = (id: string, date: string, amountCents: number, over: Partial<{ tipCents: number; refundedCents: number }> = {}) => ({
  id,
  settledAt: new Date(`${date}T20:00:00Z`),
  createdAt: new Date(`${date}T20:00:00Z`),
  amountCents,
  tipCents: 0,
  refundedCents: 0,
  order: { shortCode: id.toUpperCase() },
  billingCustomer: customer,
  ...over,
});
const abono = (id: string, date: string, amountCents: number) => ({
  id,
  billingCustomerId: "cust-1",
  paidAt: new Date(`${date}T12:00:00Z`),
  amountCents,
  accountCode: "110505",
  note: null,
});

describe("creditMovementsFor", () => {
  it("un documento por cuenta, vence a fecha + plazo, saldo FIFO y abono bajo el primer cargo que cubrió", () => {
    const { docs, payments } = creditMovementsFor(
      customer,
      [charge("c1", "2026-07-01", 100_000), charge("c2", "2026-09-10", 50_000, { tipCents: 5_000 })],
      [abono("a1", "2026-09-15", 120_000)],
    );
    expect(docs).toEqual([
      expect.objectContaining({
        id: "c1",
        source: "customer_credit",
        partnerId: "cust-1",
        partnerName: "ACME S.A.S.",
        partnerTaxId: "901944469-1",
        number: "C1",
        date: "2026-07-01",
        dueDate: "2026-07-31",
        totalCents: 100_000,
        outstandingCents: 0,
      }),
      expect.objectContaining({ id: "c2", date: "2026-09-10", dueDate: "2026-10-10", totalCents: 50_000, outstandingCents: 30_000 }),
    ]);
    expect(payments).toEqual([{ id: "a1", docId: "c1", date: "2026-09-15", amountCents: 120_000, note: "110505" }]);
  });

  it("un cargo devuelto por completo no es documento; pagar de más deja el abono bajo el último cargo", () => {
    const { docs, payments } = creditMovementsFor(
      customer,
      [charge("dev", "2026-09-01", 80_000, { refundedCents: 80_000 }), charge("c2", "2026-09-02", 10_000)],
      [abono("a1", "2026-09-03", 25_000)],
    );
    expect(docs.map((d) => d.id)).toEqual(["c2"]);
    expect(docs[0].outstandingCents).toBe(0);
    expect(payments).toEqual([expect.objectContaining({ id: "a1", docId: "c2" })]);
  });

  it("sin cargos, los abonos no se pueden colgar de nada", () => {
    const { docs, payments } = creditMovementsFor(customer, [], [abono("a1", "2026-09-03", 25_000)]);
    expect(docs).toEqual([]);
    expect(payments).toEqual([]);
  });
});

describe("cartera con ventas a crédito", () => {
  const { docs, payments } = creditMovementsFor(
    customer,
    [charge("c1", "2026-06-01", 100_000), charge("c2", "2026-08-25", 50_000), charge("c3", "2026-09-15", 20_000)],
    [abono("a1", "2026-07-01", 60_000)],
  );

  it("lista por tercero: saldo, documentos con saldo, vence más antiguo y peor tramo", () => {
    const side = buildPartnerSummary(docs, HOY);
    expect(side.partners).toHaveLength(1);
    const p = side.partners[0];
    // c1 debe 40.000 (venció 2026-07-01: 60+), c2 entero (vence 2026-09-24: corriente), c3 entero.
    expect(p.outstandingCents).toBe(110_000);
    expect(p.docs).toBe(3);
    expect(p.oldestDue).toBe("2026-07-01");
    expect(p.worstBucket).toBe("60+");
    expect(agingBucket("2026-09-24", HOY)).toBe("corriente");
  });

  it("extracto: cargos y abonos en orden con saldo corrido; edades por antigüedad del documento", () => {
    const st = buildStatement(docs, payments, HOY);
    expect(st.entries.map((e) => [e.kind, e.balanceCents])).toEqual([
      ["cargo", 100_000],
      ["abono", 40_000],
      ["cargo", 90_000],
      ["cargo", 110_000],
    ]);
    expect(st.totals).toEqual({ cargosCents: 170_000, abonosCents: 60_000, balanceCents: 110_000 });
    expect(st.aging).toEqual({
      d0a30Cents: 70_000, // c2 (27 días) + c3 (6 días)
      d31a60Cents: 0,
      d61a90Cents: 0,
      mas90Cents: 40_000, // c1 (112 días)
      pendingCents: 110_000,
      overdueCents: 40_000, // sólo c1 pasó su vencimiento
    });
  });
});
