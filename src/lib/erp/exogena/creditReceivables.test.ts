// Exógena 1008: las ventas a crédito a clientes de facturación también son
// cuentas por cobrar al 31/12 (antes el formato sólo tomaba los cortes de
// bonos). El saldo se reconstruye al corte: cargos − devuelto − notas
// crédito emitidas hasta el corte − abonos hasta el corte.
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  payments: vi.fn(),
  abonos: vi.fn(),
  notes: vi.fn(),
}));
vi.mock("@/lib/db", () => ({
  db: {
    payment: { findMany: m.payments },
    customerCreditPayment: { findMany: m.abonos },
    creditNote: {
      // Sin notas pendientes de fijar; el resto, las que bajaron cartera.
      findMany: (args: { where: { accountingStampedAt?: unknown } }) =>
        args.where.accountingStampedAt === null ? Promise.resolve([]) : m.notes(args),
    },
  },
}));

import { loadCreditReceivables } from "./queries";
import { aggregate1008, creditReceivablesAtCutoff } from "./sources";

const acme = {
  id: "bc1",
  customerName: "ACME S.A.S.",
  docType: "NIT",
  docNumber: "900123456",
  verificationDigit: "8",
  address: null,
  municipalityCode: null,
  country: "CO",
};

const charge = (id: string, over: Partial<{ orderId: string; settledAt: Date; amountCents: number; refundedCents: number; creditNoteCents: number; billingCustomer: typeof acme | null }> = {}) => ({
  id,
  orderId: "o1",
  settledAt: new Date("2026-11-10T15:00:00Z"),
  createdAt: new Date("2026-11-10T15:00:00Z"),
  amountCents: 1_000_000,
  refundedCents: 0,
  creditNoteCents: 0,
  billingCustomer: acme,
  ...over,
});

beforeEach(() => {
  vi.resetAllMocks();
  m.payments.mockResolvedValue([]);
  m.abonos.mockResolvedValue([]);
  m.notes.mockResolvedValue([]);
});

describe("creditReceivablesAtCutoff", () => {
  const base = {
    id: "p1",
    customerId: "bc1",
    orderId: "o1",
    date: new Date("2026-11-10T15:00:00Z"),
    amountCents: 1_000_000,
    refundedCents: 0,
    creditNoteCents: 300_000,
  };

  it("una nota emitida DESPUÉS del corte no baja el saldo al 31/12", () => {
    const saldo = creditReceivablesAtCutoff(
      [base],
      [{ customerId: "bc1", amountCents: 200_000 }],
      [{ orderId: "o1", receivableCents: 300_000, fiscalDate: "2027-01-15" }],
      "2026-12-31",
    );
    expect(saldo.get("bc1")).toBe(800_000);
  });

  it("una nota hasta el corte sí baja el saldo, con tope en lo que el cargo tiene hoy", () => {
    const saldo = creditReceivablesAtCutoff(
      [base, { ...base, id: "p2", date: new Date("2026-11-11T15:00:00Z"), creditNoteCents: 0 }],
      [],
      [{ orderId: "o1", receivableCents: 300_000, fiscalDate: "2026-12-20" }],
      "2026-12-31",
    );
    // p1 baja 300.000 (su tope), p2 queda entero.
    expect(saldo.get("bc1")).toBe(700_000 + 1_000_000);
  });

  it("descuenta lo devuelto y deja negativo a quien pagó de más (el 1008 lo omite)", () => {
    const saldo = creditReceivablesAtCutoff(
      [{ ...base, refundedCents: 1_000_000, creditNoteCents: 0 }],
      [{ customerId: "bc1", amountCents: 50_000 }],
      [],
      "2026-12-31",
    );
    expect(saldo.get("bc1")).toBe(-50_000);
  });
});

describe("loadCreditReceivables (1008)", () => {
  it("corta cargos y abonos al 31/12 y sólo cuenta las notas fijadas que bajaron cartera", async () => {
    m.payments.mockResolvedValue([charge("p1", { creditNoteCents: 100_000 })]);
    m.abonos.mockResolvedValue([{ billingCustomerId: "bc1", amountCents: 250_000 }]);
    m.notes.mockResolvedValue([
      // 31-dic a las 10 p. m. en Bogotá (ya 1-ene en UTC): cuenta para 2026.
      {
        receivableCents: 100_000,
        createdAt: new Date("2027-01-01T03:00:00Z"),
        dianDocument: { issuedAt: new Date("2027-01-01T03:00:00Z") },
        originalInvoice: { orderId: "o1" },
      },
    ]);
    const rows = await loadCreditReceivables("r1", 2026);
    expect(rows).toEqual([
      expect.objectContaining({
        customer: expect.objectContaining({ key: "bc:bc1", docType: "NIT", docNumber: "900123456" }),
        saldoCents: 1_000_000 - 100_000 - 250_000,
      }),
    ]);
    const to = new Date(Date.UTC(2027, 0, 1));
    expect(m.payments.mock.calls[0]![0].where).toMatchObject({
      method: "customer_credit",
      status: { in: ["approved", "refunded"] },
      settledAt: { lt: to },
      order: { restaurantId: "r1" },
    });
    expect(m.abonos.mock.calls[0]![0].where).toEqual({ restaurantId: "r1", paidAt: { lt: to } });
    expect(m.notes.mock.calls[0]![0].where).toMatchObject({
      restaurantId: "r1",
      abandonedAt: null,
      accountingStampedAt: { not: null },
      receivableCents: { gt: 0 },
      originalInvoice: { orderId: { in: ["o1"] } },
    });
  });

  it("sin ventas a crédito no consulta notas y no aporta filas", async () => {
    expect(await loadCreditReceivables("r1", 2026)).toEqual([]);
    expect(m.notes).not.toHaveBeenCalled();
  });

  it("el 1008 suma por tercero los bonos y el crédito del mismo cliente", async () => {
    m.payments.mockResolvedValue([charge("p1")]);
    const credit = await loadCreditReceivables("r1", 2026);
    const rows = aggregate1008([{ customer: credit[0]!.customer, saldoCents: 500_000 }, ...credit]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.saldoCents).toBe(1_500_000);
  });
});
