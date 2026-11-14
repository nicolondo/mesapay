// Distintivo «A crédito» / «Crédito pagado» de Órdenes y el filtro «A crédito».
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ db: {} }));

import {
  creditSaleStatus,
  creditSalesByOrder,
  hasCreditSale,
  type CreditSaleAbono,
  type CreditSaleCharge,
} from "./creditSale";
import { ordersHref, ordersWhere, parseOrdersView } from "./ordersView";

const charge = (
  id: string,
  orderId: string,
  customer: string | null,
  date: string,
  amountCents: number,
  over: Partial<CreditSaleCharge> = {},
): CreditSaleCharge => ({
  id,
  orderId,
  billingCustomerId: customer,
  status: "approved",
  date: new Date(date),
  amountCents,
  tipCents: 0,
  refundedCents: 0,
  creditNoteCents: 0,
  ...over,
});
const abono = (id: string, customer: string, date: string, amountCents: number): CreditSaleAbono => ({
  id,
  billingCustomerId: customer,
  date: new Date(date),
  amountCents,
});

describe("creditSalesByOrder — qué distintivo lleva cada cuenta", () => {
  it("sin abonos: «A crédito» con todo por cobrar (propina incluida)", () => {
    const sales = creditSalesByOrder(["o1"], [charge("c1", "o1", "acme", "2026-11-01", 120_000, { tipCents: 20_000 })], []);
    expect(sales.get("o1")).toEqual({ status: "on_credit", creditCents: 120_000, outstandingCents: 120_000, billingCustomerId: "acme" });
  });

  it("los abonos pagan primero la deuda más vieja, como en Cartera", () => {
    const charges = [
      charge("nuevo", "o-nueva", "acme", "2026-11-10", 50_000),
      charge("viejo", "o-vieja", "acme", "2026-11-01", 100_000),
    ];
    // Un abono de 120.000 HOY: salda la vieja y deja 30.000 de la nueva.
    const sales = creditSalesByOrder(["o-vieja", "o-nueva"], charges, [abono("a1", "acme", "2026-11-12", 120_000)]);
    expect(sales.get("o-vieja")).toMatchObject({ status: "credit_paid", outstandingCents: 0 });
    expect(sales.get("o-nueva")).toMatchObject({ status: "on_credit", outstandingCents: 30_000 });
  });

  it("cuenta parcialmente a crédito: sólo pesa la parte a crédito (el efectivo no es un cargo)", () => {
    // La cuenta o1 se pagó 40.000 en efectivo y 60.000 a crédito: sólo el cargo llega acá.
    const sales = creditSalesByOrder(["o1"], [charge("c1", "o1", "acme", "2026-11-01", 60_000)], [abono("a1", "acme", "2026-11-05", 60_000)]);
    expect(sales.get("o1")).toMatchObject({ status: "credit_paid", creditCents: 60_000, outstandingCents: 0 });
  });

  it("un abono dirigido (link de una factura manual) salda ESA cuenta aunque haya deuda más vieja", () => {
    const charges = [
      charge("viejo", "o-vieja", "acme", "2026-11-01", 100_000),
      charge("factura", "o-factura", "acme", "2026-11-10", 50_000),
    ];
    const sales = creditSalesByOrder(["o-vieja", "o-factura"], charges, [
      { ...abono("link", "acme", "2026-11-11", 60_000), chargeId: "factura" },
    ]);
    // 50.000 a la factura; los 10.000 que sobran siguen FIFO a la vieja.
    expect(sales.get("o-factura")).toMatchObject({ status: "credit_paid", outstandingCents: 0 });
    expect(sales.get("o-vieja")).toMatchObject({ status: "on_credit", outstandingCents: 90_000 });
  });

  it("los abonos de un cliente no pagan la deuda de otro", () => {
    const charges = [charge("c1", "o1", "acme", "2026-11-01", 50_000), charge("c2", "o2", "beta", "2026-11-01", 50_000)];
    const sales = creditSalesByOrder(["o1", "o2"], charges, [abono("a1", "beta", "2026-11-02", 50_000)]);
    expect(sales.get("o1")?.status).toBe("on_credit");
    expect(sales.get("o2")?.status).toBe("credit_paid");
  });

  it("los cargos de otras cuentas del cliente entran al FIFO pero no salen en el resultado", () => {
    const charges = [charge("fuera", "o-otra", "acme", "2026-10-01", 80_000), charge("c1", "o1", "acme", "2026-11-01", 20_000)];
    // 90.000 abonados: 80.000 se van a la cuenta vieja (fuera de pantalla); a o1 le quedan 10.000.
    const sales = creditSalesByOrder(["o1"], charges, [abono("a1", "acme", "2026-11-02", 90_000)]);
    expect([...sales.keys()]).toEqual(["o1"]);
    expect(sales.get("o1")).toMatchObject({ status: "on_credit", outstandingCents: 10_000 });
  });

  it("un cargo devuelto entero ya no marca la cuenta; uno anulado con nota crédito sigue «A crédito» sin saldo", () => {
    const charges = [
      charge("dev", "o-dev", "acme", "2026-11-01", 30_000, { status: "refunded", refundedCents: 30_000 }),
      charge("nc", "o-nc", "acme", "2026-11-02", 40_000, { creditNoteCents: 40_000 }),
    ];
    const sales = creditSalesByOrder(["o-dev", "o-nc"], charges, []);
    expect(sales.has("o-dev")).toBe(false);
    expect(sales.get("o-nc")).toEqual({ status: "on_credit", creditCents: 0, outstandingCents: 0, billingCustomerId: "acme" });
  });

  it("un cargo sin cliente no puede saldarse: «A crédito» por todo", () => {
    const sales = creditSalesByOrder(["o1"], [charge("c1", "o1", null, "2026-11-01", 25_000)], []);
    expect(sales.get("o1")).toMatchObject({ status: "on_credit", outstandingCents: 25_000, billingCustomerId: null });
  });

  it("creditSaleStatus: pagado sólo si no queda saldo y hubo abono", () => {
    expect(creditSaleStatus({ paid: 10, left: 0 })).toBe("credit_paid");
    expect(creditSaleStatus({ paid: 10, left: 5 })).toBe("on_credit");
    expect(creditSaleStatus({ paid: 0, left: 0 })).toBe("on_credit");
  });

  it("hasCreditSale: un cobro a crédito aprobado (o sin estado, ya filtrado)", () => {
    expect(hasCreditSale([{ method: "cash" }, { method: "customer_credit" }])).toBe(true);
    expect(hasCreditSale([{ method: "customer_credit", status: "approved" }])).toBe(true);
    expect(hasCreditSale([{ method: "customer_credit", status: "refunded" }])).toBe(false);
    expect(hasCreditSale([{ method: "cash", status: "approved" }, { method: "voucher" }])).toBe(false);
  });
});

describe("filtro «A crédito» de Órdenes (credito=1)", () => {
  const today = "2026-11-13";

  it("se lee de la URL y vuelve a ella; cualquier otro valor lo apaga", () => {
    expect(parseOrdersView({}, today).credit).toBe(false);
    expect(parseOrdersView({ credito: "1" }, today).credit).toBe(true);
    expect(parseOrdersView({ credito: "si" }, today).credit).toBe(false);
    const view = parseOrdersView({ credito: "1", status: "paid", page: "3" }, today);
    expect(ordersHref(view, today, { page: 3 })).toBe("/operator/orders?status=paid&credito=1&page=3");
    // Prenderlo o apagarlo vuelve a la página 1 y conserva lo demás.
    expect(ordersHref(view, today, { credit: false })).toBe("/operator/orders?status=paid");
    expect(ordersHref(parseOrdersView({ source: "manual" }, today), today, { credit: true })).toBe("/operator/orders?source=manual&credito=1");
  });

  it("acota la lista, los contadores y las facturas buscadas a cuentas con un cobro a crédito aprobado", () => {
    const filters = ordersWhere("r1", parseOrdersView({ credito: "1", q: "7913", status: "paid" }, today), 5, ["doc-order"]);
    for (const branch of [filters.where, filters.countWhere, filters.pinned, filters.rest]) {
      expect(branch).toMatchObject({ restaurantId: "r1", payments: { some: { method: "customer_credit", status: "approved" } } });
    }
    // Se combina con el tipo de cuenta.
    expect(ordersWhere("r1", parseOrdersView({ credito: "1", source: "manual" }, today), 5).where).toMatchObject({
      table: { kind: "manual" },
      payments: { some: { method: "customer_credit" } },
    });
    expect(ordersWhere("r1", parseOrdersView({}, today), 5).where).not.toHaveProperty("payments");
  });
});
