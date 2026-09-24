// Cierre de turno con efectivo de los dos nombres: lo cobrado hoy (`cash`)
// y lo que quedó grabado antes como `demo_cash` suman juntos como efectivo
// (arqueo, Z-report, caja de cada mesero) y salen en una sola fila
// "Efectivo" del desglose por método.
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ paymentFindMany: vi.fn(), shiftFindUnique: vi.fn() }));
vi.mock("@/lib/db", () => ({
  db: {
    payment: { findMany: m.paymentFindMany },
    shift: { findUnique: m.shiftFindUnique },
  },
}));

import { computeClosedShiftMetrics } from "./shift";
import { buildShiftReport } from "./shiftReport";

const WAITER = { id: "mesero-1", name: "Laura", email: "laura@test.co" };

function payment(id: string, method: string, amountCents: number, extra: Record<string, unknown> = {}) {
  return {
    id,
    method,
    amountCents,
    tipCents: 0,
    orderId: `order-${id}`,
    settledAt: new Date("2026-09-23T20:00:00Z"),
    cashTenderCents: null as number | null,
    collectedByUserId: WAITER.id,
    collectedBy: WAITER,
    order: { id: `order-${id}`, shortCode: id.toUpperCase(), table: { number: 4, label: null, kind: "table" } },
    ...extra,
  };
}

const PAYMENTS = [
  payment("a", "cash", 30_000_00, { cashTenderCents: 50_000_00 }),
  payment("b", "demo_cash", 20_000_00),
  payment("c", "kushki_card_terminal", 50_000_00),
];

beforeEach(() => {
  vi.clearAllMocks();
  m.paymentFindMany.mockResolvedValue(PAYMENTS);
  m.shiftFindUnique.mockResolvedValue({
    id: "shift-1",
    restaurantId: "r1",
    userId: null,
    user: null,
    openedAt: new Date("2026-09-23T12:00:00Z"),
    closedAt: new Date("2026-09-24T02:00:00Z"),
    openingCashCents: 0,
    declaredCashCents: 50_000_00,
    expectedCashCents: 50_000_00,
    cashDiffCents: 0,
    notes: null,
  });
});

describe("métricas del turno (arqueo)", () => {
  it("cash y demo_cash suman como efectivo; el datáfono no", async () => {
    const metrics = await computeClosedShiftMetrics("shift-1");
    expect(metrics.cashCents).toBe(50_000_00);
    expect(metrics.grossCents).toBe(100_000_00);
  });

  it("el desglose por método trae una sola fila de efectivo, como cash", async () => {
    const metrics = await computeClosedShiftMetrics("shift-1");
    expect(metrics.byMethod).toEqual([
      { method: "cash", count: 2, sumCents: 50_000_00 },
      { method: "kushki_card_terminal", count: 1, sumCents: 50_000_00 },
    ]);
  });
});

describe("Z-report del turno", () => {
  it("el efectivo recibido, el vuelto y la caja del mesero cuentan los dos nombres", async () => {
    const report = await buildShiftReport("shift-1");
    expect(report).not.toBeNull();
    expect(report!.cash).toEqual({
      receivedCents: 50_000_00,
      changeGivenCents: 20_000_00,
      tenderCents: 70_000_00,
    });
    expect(report!.byWaiter[0]).toEqual(expect.objectContaining({ userId: WAITER.id, cashCents: 50_000_00 }));
  });

  it("el desglose por método trae una sola fila de efectivo marcada como caja", async () => {
    const report = await buildShiftReport("shift-1");
    const cashRows = report!.byMethod.filter((r) => r.isCash);
    expect(cashRows).toEqual([
      { method: "cash", isCash: true, count: 2, grossCents: 50_000_00, tipCents: 0 },
    ]);
    expect(report!.byMethod.some((r) => r.method === "demo_cash")).toBe(false);
  });
});
