import { describe, expect, it } from "vitest";
import { compareHistory, historyDate, historyKeyQueries, historyPage, historyStreams } from "./history";

const opened = new Date("2026-09-28T16:00:00Z");
const paid = new Date("2026-09-29T18:00:00Z");
const range = { gte: new Date("2026-09-29T10:00:00Z"), lt: new Date("2026-09-30T10:00:00Z") };

describe("historyDate: el cobro ubica la venta", () => {
  it("usa el cobro final de las pagadas y la apertura de lo demás", () => {
    expect(historyDate({ createdAt: opened, paidAt: paid })).toBe(paid);
    expect(historyDate({ createdAt: opened, paidAt: null })).toBe(opened);
  });
});

describe("historyStreams / historyKeyQueries", () => {
  it("dos flujos disjuntos acotados al rango [gte, lt)", () => {
    const where = { restaurantId: "r", status: "paid" as const, shortCode: { contains: "ABC" } };
    expect(historyStreams(where, range)).toEqual([
      { ...where, paidAt: { gte: range.gte, lt: range.lt } },
      { ...where, paidAt: null, createdAt: { gte: range.gte, lt: range.lt } },
    ]);
  });

  it("sin rango (todas las fechas) siguen siendo disjuntos", () => {
    const [withPayment, without] = historyStreams({ restaurantId: "r" }, null);
    expect(withPayment.paidAt).toEqual({ not: null });
    expect(without.paidAt).toBeNull();
    expect(without.createdAt).toBeUndefined();
  });

  it("piden sólo claves, ordenadas como la lista, hasta el final de la página pedida", () => {
    const [a, b] = historyKeyQueries({ restaurantId: "r" }, range, 3, 50);
    expect(a.orderBy).toEqual([{ paidAt: "desc" }, { id: "desc" }]);
    expect(b.orderBy).toEqual([{ createdAt: "desc" }, { id: "desc" }]);
    expect(a.take).toBe(150);
    expect(b.take).toBe(150);
    expect(a.select).toEqual({ id: true, paidAt: true, createdAt: true });
    expect(historyKeyQueries({ restaurantId: "r" }, range, 0, 50)[0].take).toBe(50);
  });
});

describe("historyPage: mezcla de los flujos y corte de página", () => {
  // 130 cobradas (una cada minuto) y 70 abiertas intercaladas.
  const rows = [
    ...Array.from({ length: 130 }, (_, i) => ({
      id: `p${String(i).padStart(3, "0")}`,
      createdAt: new Date(0),
      paidAt: new Date(Date.UTC(2026, 8, 29, 11, i * 2)),
    })),
    ...Array.from({ length: 70 }, (_, i) => ({
      id: `o${String(i).padStart(3, "0")}`,
      createdAt: new Date(Date.UTC(2026, 8, 29, 11, i * 2 + 1)),
      paidAt: null,
    })),
  ];
  const all = [...rows].sort(compareHistory);

  it("más reciente primero; las páginas no se solapan ni dejan huecos", () => {
    const pages = [1, 2, 3, 4].map((p) => historyPage(rows, p, 50));
    expect(pages.map((p) => p.length)).toEqual([50, 50, 50, 50]);
    expect(pages.flat().map((r) => r.id)).toEqual(all.map((r) => r.id));
    expect(new Set(pages.flat().map((r) => r.id)).size).toBe(200);
    for (let i = 1; i < all.length; i++) {
      expect(historyDate(all[i - 1]).getTime()).toBeGreaterThanOrEqual(historyDate(all[i]).getTime());
    }
    expect(historyPage(rows, 5, 50)).toEqual([]);
  });

  it("con las claves de cada flujo hasta la página N alcanza para la página N", () => {
    // Lo que devuelven las dos consultas con take = página × tamaño.
    const page = 3;
    const take = page * 50;
    const paidStream = rows.filter((r) => r.paidAt).sort(compareHistory).slice(0, take);
    const openStream = rows.filter((r) => !r.paidAt).sort(compareHistory).slice(0, take);
    expect(historyPage([...paidStream, ...openStream], page, 50)).toEqual(all.slice(100, 150));
  });

  it("a igual instante, desempata por id (determinista) y no modifica la entrada", () => {
    const tie = [
      { id: "a", createdAt: opened, paidAt: null },
      { id: "c", createdAt: new Date(0), paidAt: opened },
      { id: "b", createdAt: opened, paidAt: null },
    ];
    const copy = [...tie];
    expect(historyPage(tie, 1, 10).map((r) => r.id)).toEqual(["c", "b", "a"]);
    expect(tie).toEqual(copy);
  });

  it("las órdenes de la factura buscada van antes que todo, también en orden", () => {
    const old1 = { id: "f1", createdAt: new Date(0), paidAt: new Date("2025-01-01T00:00:00Z") };
    const old2 = { id: "f2", createdAt: new Date(0), paidAt: new Date("2025-02-01T00:00:00Z") };
    const first = historyPage(rows, 1, 50, [old1, old2]);
    expect(first.slice(0, 2).map((r) => r.id)).toEqual(["f2", "f1"]);
    expect(first.slice(2)).toEqual(all.slice(0, 48));
    // La página 2 sigue donde quedó la 1, sin huecos.
    expect(historyPage(rows, 2, 50, [old1, old2])).toEqual(all.slice(48, 98));
  });

  it("una cuenta abierta ayer y cobrada hoy se ordena por su cobro", () => {
    const carried = { id: "x", createdAt: opened, paidAt: paid };
    const newer = { id: "y", createdAt: new Date("2026-09-29T17:00:00Z"), paidAt: null };
    expect(historyPage([newer, carried], 1, 1)).toEqual([carried]);
  });
});
