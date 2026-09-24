import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * "Tomar pedido" del mesero (y del operador en vista mesero): mismo orden
 * de platos que ve el comensal, según Restaurant.menuItemOrder.
 */
const h = vi.hoisted(() => ({
  menuItemOrder: "alphabetical" as string,
  menuItemFindMany: vi.fn(),
}));

vi.mock("@/auth", () => ({
  auth: async () => ({ user: { id: "u1", role: "operator", restaurantId: "r1" } }),
}));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("notFound");
  },
  redirect: (to: string) => {
    throw new Error(`redirect:${to}`);
  },
}));
vi.mock("next-intl/server", () => ({
  getTranslations: async () => (key: string) => key,
}));
vi.mock("@/lib/menus", () => ({ ensureDefaultMenu: async () => undefined }));
vi.mock("@/lib/menuTags", () => ({ getRestaurantMenuTags: async () => [] }));
vi.mock("@/app/t/[slug]/menu/MenuClient", () => ({ MenuClient: () => null }));
vi.mock("@/lib/db", () => ({
  db: {
    table: {
      findUnique: async () => ({
        id: "t1",
        number: 4,
        label: null,
        kind: "table",
        restaurant: {
          id: "r1",
          slug: "demo",
          name: "Demo",
          tagline: null,
          serviceMode: "table",
          logoUrl: null,
          menuItemOrder: h.menuItemOrder,
        },
      }),
    },
    menu: { findMany: async () => [{ id: "m1", slug: "carta", label: "Carta", description: null }] },
    dishRating: { groupBy: async () => [] },
    category: {
      findMany: async () => [
        { id: "fuertes", slug: "fuertes", label: "Fuertes", menuId: "m1", parentId: null },
      ],
    },
    menuItem: { findMany: h.menuItemFindMany },
    order: { findFirst: async () => null },
  },
}));

import MeseroPedirPage from "./page";

const item = (id: string, name: string, sortOrder: number) => ({
  id,
  categoryId: "fuertes",
  name,
  description: null,
  priceCents: 1_000_000,
  tags: [],
  photoUrl: null,
  modifiers: null,
  sortOrder,
});

async function itemIds(): Promise<string[]> {
  const el = (await MeseroPedirPage({
    params: Promise.resolve({ tableId: "t1" }),
  })) as { props: { items: { id: string }[] } };
  return el.props.items.map((i) => i.id);
}

beforeEach(() => {
  h.menuItemFindMany.mockReset();
  h.menuItemFindMany.mockResolvedValue([
    item("solomito", "Solomito", 10),
    item("bandeja", "Bandeja paisa", 20),
    item("ceviche", "ceviche", 30),
  ]);
});

describe("tomar pedido del mesero — orden de los platos", () => {
  it("alfabético (default)", async () => {
    h.menuItemOrder = "alphabetical";
    expect(await itemIds()).toEqual(["bandeja", "ceviche", "solomito"]);
  });

  it("manual: por la posición del editor", async () => {
    h.menuItemOrder = "manual";
    expect(await itemIds()).toEqual(["solomito", "bandeja", "ceviche"]);
    expect(h.menuItemFindMany.mock.calls[0][0].orderBy).toEqual([
      { sortOrder: "asc" },
      { createdAt: "asc" },
      { id: "asc" },
    ]);
  });
});
