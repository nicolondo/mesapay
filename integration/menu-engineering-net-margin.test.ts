import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { db } from "../src/lib/db";
import { GET as engineering } from "../src/app/api/operator/menu-engineering/route";

const scope = vi.hoisted(() => ({ restaurantId: "" }));
// Only authentication is substituted: the cost context, the paid sales and
// the restaurant's tax come from isolated PostgreSQL.
vi.mock("../src/lib/secureApi", () => ({ secureApi: (handler: unknown) => handler }));
vi.mock("../src/lib/erp/access", () => ({
  getErpContext: async () => ({ restaurantId: scope.restaurantId, country: "CO" }),
  isDenied: () => false,
}));

const url = new URL(process.env.DATABASE_URL ?? "postgresql://localhost/invalid");
if (!["127.0.0.1", "localhost"].includes(url.hostname) || !/^\/mesapay_.*(?:test|validation)$/.test(url.pathname)) {
  throw new Error("Isolated local database required");
}

const tenants: string[] = [];
const dishes = new Map<string, string>();

/** Comercio con un plato de $42.900 cuya receta cuesta $800 y 3 ventas pagadas. */
async function tenant(salesTaxKind: "inc" | "none", salesTaxPct: number) {
  const restaurant = await db.restaurant.create({ data: {
    name: "Menu engineering margin validation", slug: `engineering-margin-${randomUUID()}`,
    enabledModules: ["recipes"], salesTaxKind, salesTaxPct,
  } });
  tenants.push(restaurant.id);
  const category = await db.category.create({ data: { restaurantId: restaurant.id, label: "Validation", slug: "validation" } });
  const dish = await db.menuItem.create({ data: { restaurantId: restaurant.id, categoryId: category.id, name: "Plato", priceCents: 4_290_000 } });
  const rice = await db.ingredient.create({ data: { restaurantId: restaurant.id, name: "Arroz", measureKind: "mass", referencePriceCents: 400_000 } });
  await db.recipe.create({ data: { restaurantId: restaurant.id, menuItemId: dish.id, items: { create: { ingredientId: rice.id, qtyBase: 200, wastePct: 0 } } } });
  const table = await db.table.create({ data: { restaurantId: restaurant.id, number: 1, qrToken: randomUUID() } });
  const order = await db.order.create({ data: {
    restaurantId: restaurant.id, tableId: table.id, shortCode: randomUUID(), status: "paid",
    paidAt: new Date(), subtotalCents: 3 * 4_290_000, totalCents: 3 * 4_290_000,
  } });
  const round = await db.round.create({ data: { orderId: order.id, seq: 1, status: "served", placedAt: new Date() } });
  await db.orderItem.create({ data: {
    orderId: order.id, roundId: round.id, menuItemId: dish.id, nameSnapshot: "Plato", priceCentsSnapshot: 4_290_000, qty: 3,
  } });
  dishes.set(restaurant.id, dish.id);
  return restaurant.id;
}

async function engineeringFor(restaurantId: string) {
  scope.restaurantId = restaurantId;
  const res = await engineering(new Request("http://localhost/api/operator/menu-engineering?days=30"));
  expect(res.status).toBe(200);
  return res.json() as Promise<{ dishes: { menuItemId: string; costCents: number; marginCents: number }[] }>;
}

let withInc: string;
let withoutTax: string;

beforeAll(async () => {
  withInc = await tenant("inc", 8);
  withoutTax = await tenant("none", 0);
});

afterAll(async () => {
  await db.order.deleteMany({ where: { restaurantId: { in: tenants } } });
  await db.recipe.deleteMany({ where: { restaurantId: { in: tenants } } });
  await db.restaurant.deleteMany({ where: { id: { in: tenants } } });
  await db.$disconnect();
});

describe("menu engineering margin", () => {
  it("measures the margin on the menu price without the embedded consumption tax", async () => {
    const body = await engineeringFor(withInc);
    // $42.900 con INC 8 % deja $39.722,22; menos $800 de receta.
    expect(body.dishes).toEqual([
      expect.objectContaining({ menuItemId: dishes.get(withInc), costCents: 80_000, marginCents: 3_972_222 - 80_000 }),
    ]);
  });

  it("uses the menu price as is when the restaurant charges no sales tax", async () => {
    const body = await engineeringFor(withoutTax);
    expect(body.dishes).toEqual([
      expect.objectContaining({ menuItemId: dishes.get(withoutTax), costCents: 80_000, marginCents: 4_290_000 - 80_000 }),
    ]);
  });
});
