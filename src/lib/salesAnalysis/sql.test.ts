import { describe, expect, it, vi } from "vitest";
import type { Prisma } from "@prisma/client";
import {
  categoriesSql,
  channelsSql,
  durationSql,
  filterOrderIdsSql,
  heatSql,
  methodsSql,
  modifiersSql,
  ordersSql,
  productsSql,
  tablesSql,
  totalsSql,
  trendSql,
  waitersSql,
  type SalesScope,
} from "./sql";
import { loadFilterOptions, loadReturnRows, loadTotals, type SalesDb } from "./queries";

const RID = "restaurant-scope-check";
const scope = (dims: SalesScope["dims"] = {}): SalesScope => ({
  restaurantId: RID,
  start: new Date("2026-10-14T10:00:00Z"),
  end: new Date("2026-10-15T10:00:00Z"),
  cutoffHour: 5,
  tax: { kind: "inc", pct: 8 },
  dims,
});

const ALL_FILTERS: SalesScope["dims"] = {
  canal: "salon", mesero: "waiter-xyz", categoria: "cat-xyz", producto: "item-xyz",
  pago: "cash", mesa: "table-xyz", dia: 5, hora: 21,
};

const BUILDERS: [string, (s: SalesScope) => Prisma.Sql][] = [
  ["totales", totalsSql],
  ["tendencia", (s) => trendSql(s, "dia")],
  ["tendencia por hora", (s) => trendSql(s, "hora")],
  ["mapa de calor", heatSql],
  ["productos", productsSql],
  ["categorías", categoriesSql],
  ["modificadores", (s) => modifiersSql(s, 15)],
  ["meseros", waitersSql],
  ["métodos", methodsSql],
  ["canales", channelsSql],
  ["mesas", (s) => tablesSql(s, 30)],
  ["duración", durationSql],
  ["cuentas", (s) => ordersSql(s, 500)],
  ["cuentas por id", (s) => filterOrderIdsSql(s, ["order-a", "order-b"])],
];

/** Posición ($n) de un valor entre los parámetros de la consulta. */
function placeholdersOf(sql: Prisma.Sql, value: unknown): string[] {
  return sql.values.flatMap((v, i) => (v === value ? [`$${i + 1}`] : []));
}

describe("consultas acotadas por comercio", () => {
  it.each(BUILDERS)("%s: exige o.restaurantId = $comercio en la base de cuentas", (_, build) => {
    for (const dims of [{}, ALL_FILTERS]) {
      const sql = build(scope(dims));
      const places = placeholdersOf(sql, RID);
      expect(places.length).toBeGreaterThan(0);
      expect(places.some((p) => sql.text.includes(`o."restaurantId" = ${p}`))).toBe(true);
      expect(sql.sql).toContain(`o."status" = 'paid'`);
    }
  });

  it.each(BUILDERS)("%s: los filtros viajan como parámetros, nunca en el texto", (_, build) => {
    const sql = build(scope(ALL_FILTERS));
    for (const value of ["waiter-xyz", "cat-xyz", "item-xyz", "table-xyz", RID]) {
      expect(sql.sql).not.toContain(value);
    }
    expect(sql.values).toEqual(expect.arrayContaining(["salon", "waiter-xyz", "cat-xyz", "item-xyz", "table-xyz", "cash", "demo_cash"]));
  });

  it("las tablas unidas por id también se acotan por comercio (carta, categorías, facturas)", () => {
    const products = productsSql(scope());
    expect(products.text).toMatch(/LEFT JOIN "MenuItem" mi ON mi\."id" = lf\."menuItemId" AND mi\."restaurantId" = \$\d+/);
    expect(categoriesSql(scope()).text).toMatch(/c\."restaurantId" = \$\d+/);
    expect(totalsSql(scope()).sql).toContain(`inv."restaurantId" = o."restaurantId"`);
  });

  it("el filtro de producto o categoría cambia los hechos a nivel de línea", () => {
    expect(totalsSql(scope()).sql).toContain(`fo."tipCents"::numeric AS "tip"`);
    expect(totalsSql(scope({ producto: "p" })).sql).toContain(`NULL::numeric AS "tip"`);
  });

  it("el rango llega en UTC aunque la sesión de la base tenga otra zona", () => {
    expect(totalsSql(scope()).text).toMatch(/o\."paidAt" >= \(\$\d+::timestamptz AT TIME ZONE 'UTC'\)/);
  });
});

describe("capa de datos", () => {
  it("los totales corren el SQL acotado y tipan enteros grandes", async () => {
    const queryRaw = vi.fn(async () => [{
      orders: BigInt(3), diners: BigInt(7), units: BigInt(9), grossCents: BigInt(100), discountCents: BigInt(0),
      taxCents: BigInt(7), netCents: BigInt(93), tipCents: BigInt(10), compsCents: BigInt(0),
    }]);
    const client = { $queryRaw: queryRaw } as unknown as SalesDb;
    await expect(loadTotals(client, scope())).resolves.toMatchObject({ orders: 3, netCents: 93, tipCents: 10 });
    const sql = (queryRaw.mock.calls[0] as unknown as [Prisma.Sql])[0];
    expect(sql.values).toContain(RID);
    // Con filtro de producto la propina no aplica.
    await expect(loadTotals(client, scope({ producto: "p" }))).resolves.toMatchObject({ tipCents: null });
  });

  it("notas, reembolsos y opciones de filtros siempre filtran por el comercio", async () => {
    const none = async (args: unknown) => (args ? [] : []);
    const creditNote = { findMany: vi.fn(none) };
    const kushkiTransaction = { findMany: vi.fn(none) };
    const findMany = () => ({ findMany: vi.fn(none) });
    const client = {
      $queryRaw: vi.fn(async () => []),
      creditNote, kushkiTransaction,
      user: findMany(), category: findMany(), menuItem: findMany(), table: findMany(),
    } as unknown as SalesDb;
    await loadReturnRows(client, scope());
    expect(creditNote.findMany.mock.calls[0]![0]).toMatchObject({ where: { restaurantId: RID } });
    expect(kushkiTransaction.findMany.mock.calls[0]![0]).toMatchObject({ where: { restaurantId: RID } });
    await loadFilterOptions(client, RID);
    for (const model of ["user", "category", "menuItem", "table"] as const) {
      const fm = (client[model] as unknown as { findMany: ReturnType<typeof vi.fn> }).findMany;
      expect(fm.mock.calls[0]![0]).toMatchObject({ where: { restaurantId: RID } });
    }
  });
});
