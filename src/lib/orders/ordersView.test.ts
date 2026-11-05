import { describe, expect, it } from "vitest";
import {
  businessPeriodRange,
  ordersHref,
  ordersPageBounds,
  ordersPageCount,
  ordersWhere,
  parseOrdersView,
  summarizeOrders,
  type OrdersView,
} from "./ordersView";

const today = "2026-11-04";
const day = (iso: string) => ({ desde: iso, hasta: iso });

describe("parseOrdersView — la URL", () => {
  it("sin nada: hoy, todas, página 1", () => {
    expect(parseOrdersView({}, today)).toEqual({
      status: "all",
      q: "",
      period: day(today),
      allDates: false,
      page: 1,
    });
  });

  it("desde/hasta como en los reportes; una sola fecha vale como ese día; al revés se da vuelta", () => {
    expect(parseOrdersView({ desde: "2026-11-02", hasta: "2026-11-08" }, today).period).toEqual({ desde: "2026-11-02", hasta: "2026-11-08" });
    expect(parseOrdersView({ desde: "2026-10-31" }, today).period).toEqual(day("2026-10-31"));
    expect(parseOrdersView({ hasta: "2026-10-31" }, today).period).toEqual(day("2026-10-31"));
    expect(parseOrdersView({ desde: "2026-11-08", hasta: "2026-11-02" }, today).period).toEqual({ desde: "2026-11-02", hasta: "2026-11-08" });
  });

  it("ignora lo inválido: fechas imposibles, estados raros, páginas no numéricas", () => {
    const v = parseOrdersView({ desde: "2026-02-31", status: "x", page: "-2", q: "  4F2A  " }, today);
    expect(v.period).toEqual(day(today));
    expect(v.status).toBe("all");
    expect(v.page).toBe(1);
    expect(v.q).toBe("4F2A");
    expect(parseOrdersView({ page: "3" }, today).page).toBe(3);
    expect(parseOrdersView({ page: ["2", "9"] }, today).page).toBe(2);
  });

  it("enlaces viejos: period=today/7d/30d/all", () => {
    expect(parseOrdersView({ period: "today" }, today).period).toEqual(day(today));
    // 7 días con hoy incluido: hoy − 6 … hoy (como los chips de antes).
    expect(parseOrdersView({ period: "7d" }, today).period).toEqual({ desde: "2026-10-29", hasta: today });
    expect(parseOrdersView({ period: "30d" }, today).period).toEqual({ desde: "2026-10-06", hasta: today });
    expect(parseOrdersView({ period: "all" }, today)).toMatchObject({ allDates: true, period: day(today) });
    // Las fechas explícitas mandan sobre el parámetro viejo.
    expect(parseOrdersView({ period: "7d", desde: "2026-10-01", hasta: "2026-10-01" }, today).period).toEqual(day("2026-10-01"));
  });

  it("fechas=todas (búsqueda de la barra de arriba)", () => {
    expect(parseOrdersView({ q: "002A77", fechas: "todas" }, today)).toMatchObject({ q: "002A77", allDates: true });
  });
});

describe("ordersHref — la URL de vuelta", () => {
  const base: OrdersView = { status: "all", q: "", period: day(today), allDates: false, page: 1 };

  it("hoy sin parámetros; otro período con desde/hasta", () => {
    expect(ordersHref(base, today)).toBe("/operator/orders");
    expect(ordersHref(base, today, { period: { desde: "2026-11-02", hasta: "2026-11-08" } }))
      .toBe("/operator/orders?desde=2026-11-02&hasta=2026-11-08");
  });

  it("conserva estado y búsqueda; todo cambio vuelve a la página 1 salvo que se pida otra", () => {
    const v: OrdersView = { ...base, status: "paid", q: "FE12", page: 4 };
    expect(ordersHref(v, today, { period: day("2026-11-03") }))
      .toBe("/operator/orders?desde=2026-11-03&hasta=2026-11-03&status=paid&q=FE12");
    expect(ordersHref(v, today, { page: 5 })).toBe("/operator/orders?status=paid&q=FE12&page=5");
    expect(ordersHref(v, today, { q: "" })).toBe("/operator/orders?status=paid");
  });

  it("ida y vuelta: lo que arma se lee igual", () => {
    const v: OrdersView = { status: "cancelled", q: "a b", period: { desde: "2026-10-01", hasta: "2026-10-31" }, allDates: true, page: 2 };
    const href = ordersHref(v, today, { page: 2 });
    const sp = Object.fromEntries(new URLSearchParams(href.split("?")[1]));
    expect(parseOrdersView(sp, today)).toEqual(v);
  });
});

describe("businessPeriodRange — días de negocio (Bogotá + corte)", () => {
  it("con corte 5: del 05:00 del primer día al 05:00 del día siguiente al último", () => {
    const r = businessPeriodRange({ desde: "2026-11-02", hasta: "2026-11-08" }, 5);
    expect(r.gte.toISOString()).toBe("2026-11-02T10:00:00.000Z");
    expect(r.lt.toISOString()).toBe("2026-11-09T10:00:00.000Z");
  });

  it("con corte 0 es la medianoche de Bogotá (UTC−5, sin horario de verano)", () => {
    const r = businessPeriodRange(day("2026-11-04"), 0);
    expect(r.gte.toISOString()).toBe("2026-11-04T05:00:00.000Z");
    expect(r.lt.toISOString()).toBe("2026-11-05T05:00:00.000Z");
  });

  it("un mes completo cruza bien el fin de año", () => {
    const r = businessPeriodRange({ desde: "2026-12-01", hasta: "2026-12-31" }, 5);
    expect(r.gte.toISOString()).toBe("2026-12-01T10:00:00.000Z");
    expect(r.lt.toISOString()).toBe("2027-01-01T10:00:00.000Z");
  });
});

describe("ordersWhere — filtro y alcance", () => {
  const view = { status: "all" as const, q: "", period: day(today), allDates: false };

  it("sin búsqueda: el comercio, el estado y el período", () => {
    const { where, range, scope } = ordersWhere("r1", { ...view, status: "open" }, 5);
    expect(where).toEqual({ restaurantId: "r1", status: { in: ["open", "placed", "in_kitchen", "ready", "served", "paying"] } });
    expect(range).toEqual(businessPeriodRange(day(today), 5));
    expect(scope).toBe("period");
    expect(ordersWhere("r1", { ...view, status: "paid" }, 5).where.status).toBe("paid");
    expect(ordersWhere("r1", { ...view, status: "cancelled" }, 5).where.status).toBe("cancelled");
  });

  it("búsqueda por código: junto con el período", () => {
    const { where, scope } = ordersWhere("r1", { ...view, q: "4f2a" }, 5);
    expect(where).toEqual({ restaurantId: "r1", shortCode: { contains: "4f2a", mode: "insensitive" } });
    expect(scope).toBe("period");
  });

  it("si es el número de una factura: código O esas órdenes, en todas las fechas, esas arriba", () => {
    const { where, countWhere, pinned, rest, range, scope } = ordersWhere("r1", { ...view, status: "paid", q: "7913" }, 5, ["o1", "o2"]);
    const code = { shortCode: { contains: "7913", mode: "insensitive" } };
    expect(where).toEqual({ restaurantId: "r1", status: "paid", OR: [code, { id: { in: ["o1", "o2"] } }] });
    expect(countWhere).toEqual({ restaurantId: "r1", OR: [code, { id: { in: ["o1", "o2"] } }] });
    // Las de la factura van primero; el resto no las repite.
    expect(pinned).toEqual({ restaurantId: "r1", status: "paid", id: { in: ["o1", "o2"] } });
    expect(rest).toEqual({ restaurantId: "r1", ...code, status: "paid", id: { notIn: ["o1", "o2"] } });
    expect(range).toBeNull();
    expect(scope).toBe("all");
  });

  it("sin factura que coincida no hay nada fijado arriba y el resto es la lista", () => {
    const r = ordersWhere("r1", { ...view, q: "4f2a" }, 5, []);
    expect(r.pinned).toBeNull();
    expect(r.rest).toBe(r.where);
  });

  it("todas las fechas a pedido", () => {
    expect(ordersWhere("r1", { ...view, allDates: true }, 5)).toMatchObject({ range: null, scope: "all" });
  });
});

describe("paginación y totales", () => {
  it("páginas y «Mostrando 51–100 de 312»", () => {
    expect(ordersPageCount(0)).toBe(1);
    expect(ordersPageCount(50)).toBe(1);
    expect(ordersPageCount(51)).toBe(2);
    expect(ordersPageCount(312)).toBe(7);
    expect(ordersPageBounds(2, 312)).toEqual({ from: 51, to: 100 });
    expect(ordersPageBounds(7, 312)).toEqual({ from: 301, to: 312 });
    expect(ordersPageBounds(1, 0)).toEqual({ from: 0, to: 0 });
  });

  it("los totales suman los dos flujos por estado, no la página", () => {
    const groups = [
      // Flujo con fecha de cobro.
      { status: "paid", _count: { _all: 300 }, _sum: { totalCents: 9_000_000 } },
      // Flujo sin fecha de cobro: abiertas, canceladas y pagadas viejas sin fecha.
      { status: "served", _count: { _all: 7 }, _sum: { totalCents: 210_000 } },
      { status: "cancelled", _count: { _all: 3 }, _sum: { totalCents: 50_000 } },
      { status: "paid", _count: { _all: 2 }, _sum: { totalCents: null } },
    ];
    expect(summarizeOrders(groups)).toEqual({ count: 312, paidCount: 302, paidSum: 9_000_000 });
    expect(summarizeOrders([])).toEqual({ count: 0, paidCount: 0, paidSum: 0 });
  });
});
