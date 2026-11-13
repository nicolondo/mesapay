import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * El efectivo que cobra el usuario de DATÁFONO va a la caja del local — el
 * mismo destino que cuando cobra el administrador —, nunca a la caja de un
 * mesero. El pago queda con `collectedByUserId` del datáfono (auditoría),
 * y la caja sólo manda a la del mesero el efectivo que cobró un MESERO.
 */
const m = vi.hoisted(() => ({
  shiftFindFirst: vi.fn(),
  shiftFindMany: vi.fn(),
  userFindMany: vi.fn(),
  paymentFindMany: vi.fn(),
  movementFindMany: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    shift: { findFirst: m.shiftFindFirst, findMany: m.shiftFindMany },
    user: { findMany: m.userFindMany },
    payment: { findMany: m.paymentFindMany },
    cashMovement: { findMany: m.movementFindMany },
  },
}));

// Sólo los usa el registro de movimientos (no este cálculo); se apagan para
// no arrastrar next-auth al entorno de vitest.
vi.mock("@/lib/events", () => ({ publishOrderEvent: vi.fn() }));
vi.mock("@/lib/auditLog", () => ({ recordAuditEvent: vi.fn() }));

import { buildCashSnapshot } from "./cashBox";

const OPENED = new Date("2026-11-13T18:00:00Z");
const at = (min: number) => new Date(OPENED.getTime() + min * 60_000);

beforeEach(() => {
  vi.resetAllMocks();
  m.shiftFindFirst.mockResolvedValue({ id: "general", openedAt: OPENED, openingCashCents: BigInt(100_000) });
  m.userFindMany.mockResolvedValue([{ id: "w-ana" }]);
  m.shiftFindMany.mockResolvedValue([
    {
      id: "turno-ana",
      userId: "w-ana",
      status: "open",
      openedAt: OPENED,
      closedAt: null,
      openingCashCents: BigInt(50_000),
      user: { id: "w-ana", name: "Ana", email: "ana@example.test" },
    },
  ]);
  m.movementFindMany.mockResolvedValue([]);
  m.paymentFindMany.mockResolvedValue([
    // Efectivo que cobró el datáfono.
    { method: "cash", amountCents: 200_000, collectedByUserId: "pos-1", settledAt: at(10) },
    // Efectivo que cobró la mesera con su turno abierto.
    { method: "cash", amountCents: 30_000, collectedByUserId: "w-ana", settledAt: at(20) },
    // Tarjeta del datáfono: no es efectivo, no entra a ninguna caja.
    { method: "kushki_card_terminal", amountCents: 90_000, collectedByUserId: "pos-1", settledAt: at(30) },
  ]);
});

describe("caja con turnos por mesero", () => {
  it("el efectivo del datáfono suma en la caja del local, no en la de la mesera", async () => {
    const snap = await buildCashSnapshot("r1", "by_waiter");
    expect(snap.general.collectedCashCents).toBe(200_000);
    expect(snap.meseros).toEqual([
      expect.objectContaining({ userId: "w-ana", collectedCashCents: 30_000, inHandCents: 80_000 }),
    ]);
  });
});

describe("caja única del local", () => {
  it("todo el efectivo, el del datáfono incluido, va al cajón del local", async () => {
    const snap = await buildCashSnapshot("r1", "global");
    expect(snap.general.collectedCashCents).toBe(230_000);
    expect(snap.meseros).toEqual([]);
  });
});
