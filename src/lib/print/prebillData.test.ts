import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * La lectura de la cuenta viva para la precuenta. Lo que importa acá es
 * el CONTRATO con la DB: que la orden sea del comercio (una ajena es
 * "no existe"), que una cuenta cerrada no dé precuenta, que los ítems se
 * pidan con el mismo filtro de "vivo" que el subtotal, y que el mesero se
 * resuelva con la regla de la comisión (la mesa asignada, si es uno solo).
 */

type WaiterRow = { id: string; waiterCommissionBps: number | null };

const h = vi.hoisted(() => ({
  order: vi.fn(),
  orderArgs: null as unknown,
  restaurant: vi.fn(),
  userFindMany: vi.fn<(args: unknown) => Promise<WaiterRow[]>>(async () => []),
  userFindUnique: vi.fn<(args: unknown) => Promise<{ name: string | null } | null>>(
    async () => null,
  ),
}));

vi.mock("@/lib/db", () => ({
  db: {
    order: {
      findUnique: vi.fn(async (args: unknown) => {
        h.orderArgs = args;
        return h.order();
      }),
    },
    restaurant: { findUnique: h.restaurant },
    user: { findMany: h.userFindMany, findUnique: h.userFindUnique },
  },
}));
vi.mock("@/lib/billing/countries", () => ({
  getCurrencyForCountry: vi.fn(async () => "COP"),
}));

import { loadPrebill } from "./prebillData";

const orderRow = (over: Record<string, unknown> = {}) => ({
  id: "order-1",
  restaurantId: "rest-1",
  status: "placed",
  shortCode: "A4F2",
  orderType: "dineIn",
  pickupName: null,
  locale: "es",
  discountPct: null,
  discountCents: 0,
  table: { number: 7, label: null, kind: "standard" },
  items: [
    {
      qty: 1,
      nameSnapshot: "Bandeja paisa",
      priceCentsSnapshot: 2_450_000,
      taxKind: null,
      taxPct: null,
      modifierSelections: null,
      notes: null,
      guestName: null,
      cancelledAt: null,
      round: { status: "placed" },
      menuItem: null,
    },
  ],
  payments: [],
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  h.orderArgs = null;
  h.order.mockResolvedValue(orderRow());
  h.restaurant.mockResolvedValue({
    name: "Donde Chucho",
    legalName: null,
    taxId: null,
    legalAddress: null,
    legalCity: null,
    legalPhone: null,
    salesTaxKind: "none",
    salesTaxPct: 0,
    country: "CO",
    printPaperWidthMm: 58,
  });
  h.userFindMany.mockResolvedValue([]);
  h.userFindUnique.mockResolvedValue(null);
});

describe("loadPrebill", () => {
  it("pide sólo los ítems vivos: sin cancelar y sin ronda cancelada", async () => {
    await loadPrebill({ restaurantId: "rest-1", orderId: "order-1" });
    expect(h.orderArgs).toMatchObject({
      where: { id: "order-1" },
      select: {
        items: {
          where: {
            cancelledAt: null,
            OR: [{ roundId: null }, { round: { status: { not: "cancelled" } } }],
          },
        },
        payments: { where: { status: "approved" } },
      },
    });
  });

  it("una orden inexistente o de otro comercio es 'no existe'", async () => {
    h.order.mockResolvedValue(null);
    expect(await loadPrebill({ restaurantId: "rest-1", orderId: "x" })).toEqual({
      ok: false,
      reason: "not_found",
    });
    h.order.mockResolvedValue(orderRow({ restaurantId: "otro" }));
    expect(await loadPrebill({ restaurantId: "rest-1", orderId: "order-1" })).toEqual({
      ok: false,
      reason: "not_found",
    });
  });

  it("una cuenta pagada o cancelada ya no tiene precuenta", async () => {
    h.order.mockResolvedValue(orderRow({ status: "paid" }));
    expect(await loadPrebill({ restaurantId: "rest-1", orderId: "order-1" })).toEqual({
      ok: false,
      reason: "order_closed",
    });
    h.order.mockResolvedValue(orderRow({ status: "cancelled" }));
    expect(await loadPrebill({ restaurantId: "rest-1", orderId: "order-1" })).toEqual({
      ok: false,
      reason: "order_closed",
    });
  });

  it("sin nada vivo que mostrar, lo dice", async () => {
    h.order.mockResolvedValue(orderRow({ items: [] }));
    expect(await loadPrebill({ restaurantId: "rest-1", orderId: "order-1" })).toEqual({
      ok: false,
      reason: "no_items",
    });
  });

  it("arma los datos con el idioma de la orden, la moneda del país y el ancho del local", async () => {
    const now = new Date("2026-09-18T19:41:00.000Z");
    const r = await loadPrebill({ restaurantId: "rest-1", orderId: "order-1", now });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.locale).toBe("es");
    expect(r.currency).toBe("COP");
    expect(r.paperWidthMm).toBe(58);
    expect(r.data.issuedAt).toBe(now);
    expect(r.data.totalCents).toBe(2_450_000);
    expect(r.data.lines[0].name).toBe("Bandeja paisa");
    expect(r.data.waiterName).toBeNull();
  });

  it("nombra al mesero asignado a la mesa cuando es uno solo", async () => {
    h.userFindMany.mockResolvedValue([{ id: "mesero-1", waiterCommissionBps: null }]);
    h.userFindUnique.mockResolvedValue({ name: "Carlos" });
    const r = await loadPrebill({ restaurantId: "rest-1", orderId: "order-1" });
    expect(r.ok && r.data.waiterName).toBe("Carlos");
    expect(h.userFindMany.mock.calls[0][0]).toMatchObject({
      where: { restaurantId: "rest-1", role: "mesero", assignedTableNumbers: { has: 7 } },
    });
  });

  it("con dos meseros asignados a la misma mesa no adivina", async () => {
    h.userFindMany.mockResolvedValue([
      { id: "m1", waiterCommissionBps: null },
      { id: "m2", waiterCommissionBps: null },
    ]);
    const r = await loadPrebill({ restaurantId: "rest-1", orderId: "order-1" });
    expect(r.ok && r.data.waiterName).toBeNull();
    expect(h.userFindUnique).not.toHaveBeenCalled();
  });
});
