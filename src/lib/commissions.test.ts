import { describe, it, expect } from "vitest";
import {
  resolveCommissionBps,
  commissionAmountCents,
  summarizeCommissions,
  type CommissionRow,
} from "./commissions";

// ── resolveCommissionBps ─────────────────────────────────────────────────────

describe("resolveCommissionBps — cascada", () => {
  it("usa restaurant override cuando existe", () => {
    expect(
      resolveCommissionBps({ restaurantBps: 1500, repBps: 1200, platformBps: 1000 }),
    ).toBe(1500);
  });

  it("usa rep cuando restaurant es null", () => {
    expect(
      resolveCommissionBps({ restaurantBps: null, repBps: 1200, platformBps: 1000 }),
    ).toBe(1200);
  });

  it("usa rep cuando restaurant es undefined", () => {
    expect(
      resolveCommissionBps({ restaurantBps: undefined, repBps: 1200, platformBps: 1000 }),
    ).toBe(1200);
  });

  it("usa platform cuando restaurant y rep son null", () => {
    expect(
      resolveCommissionBps({ restaurantBps: null, repBps: null, platformBps: 1000 }),
    ).toBe(1000);
  });

  it("usa platform cuando restaurant y rep son undefined", () => {
    expect(
      resolveCommissionBps({ restaurantBps: undefined, repBps: undefined, platformBps: 1000 }),
    ).toBe(1000);
  });

  it("restaurant 0 gana sobre rep (0 es override explícito)", () => {
    expect(
      resolveCommissionBps({ restaurantBps: 0, repBps: 1200, platformBps: 1000 }),
    ).toBe(0);
  });
});

// ── commissionAmountCents ────────────────────────────────────────────────────

describe("commissionAmountCents", () => {
  it("caso base: 899000 a 1000 bps → 89900", () => {
    expect(commissionAmountCents(899_000, 1000)).toBe(89900);
  });

  it("redondeo half-up: 999 * 1000 / 10000 = 99.9 → 100", () => {
    expect(commissionAmountCents(999, 1000)).toBe(100);
  });

  it("redondeo down: 1004 * 1000 / 10000 = 100.4 → 100", () => {
    expect(commissionAmountCents(1004, 1000)).toBe(100);
  });

  it("base 0 → 0", () => {
    expect(commissionAmountCents(0, 1000)).toBe(0);
  });

  it("base negativo → 0 (nunca negativo)", () => {
    expect(commissionAmountCents(-500, 1000)).toBe(0);
  });

  it("bps 0 → 0", () => {
    expect(commissionAmountCents(100_000, 0)).toBe(0);
  });

  it("bps 10000 (100%) → mismo valor", () => {
    expect(commissionAmountCents(50_000, 10_000)).toBe(50_000);
  });
});

// ── summarizeCommissions ─────────────────────────────────────────────────────

describe("summarizeCommissions", () => {
  it("lista vacía → todos los totales en 0 y byMonth vacío", () => {
    const result = summarizeCommissions([]);
    expect(result.pendingCents).toBe(0);
    expect(result.paidCents).toBe(0);
    expect(result.reversedCents).toBe(0);
    expect(result.byMonth).toEqual([]);
  });

  it("suma totales por status correctamente", () => {
    const rows: CommissionRow[] = [
      { amountCents: 10_000, status: "pending", createdAt: new Date("2026-01-15") },
      { amountCents: 20_000, status: "paid", createdAt: new Date("2026-01-20") },
      { amountCents: 5_000, status: "reversed", createdAt: new Date("2026-01-25") },
      { amountCents: 8_000, status: "pending", createdAt: new Date("2026-02-10") },
    ];
    const result = summarizeCommissions(rows);
    expect(result.pendingCents).toBe(18_000);
    expect(result.paidCents).toBe(20_000);
    expect(result.reversedCents).toBe(5_000);
  });

  it("byMonth agrupa por YYYY-MM con orden ascendente", () => {
    const rows: CommissionRow[] = [
      { amountCents: 8_000, status: "pending", createdAt: new Date("2026-02-10") },
      { amountCents: 10_000, status: "pending", createdAt: new Date("2026-01-15") },
      { amountCents: 20_000, status: "paid", createdAt: new Date("2026-01-20") },
      { amountCents: 5_000, status: "reversed", createdAt: new Date("2026-01-25") },
    ];
    const result = summarizeCommissions(rows);
    expect(result.byMonth).toHaveLength(2);
    expect(result.byMonth[0]!.month).toBe("2026-01");
    expect(result.byMonth[0]!.pendingCents).toBe(10_000);
    expect(result.byMonth[0]!.paidCents).toBe(20_000);
    expect(result.byMonth[1]!.month).toBe("2026-02");
    expect(result.byMonth[1]!.pendingCents).toBe(8_000);
    expect(result.byMonth[1]!.paidCents).toBe(0);
  });

  it("reversed no aparece en byMonth pendingCents ni paidCents", () => {
    const rows: CommissionRow[] = [
      { amountCents: 5_000, status: "reversed", createdAt: new Date("2026-03-05") },
    ];
    const result = summarizeCommissions(rows);
    expect(result.byMonth).toHaveLength(1);
    expect(result.byMonth[0]!.pendingCents).toBe(0);
    expect(result.byMonth[0]!.paidCents).toBe(0);
  });
});
