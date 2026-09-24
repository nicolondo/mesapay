import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Carta del comensal (y del mesero/operador que monta con ?op=1): el orden
 * de los platos dentro de cada categoría sale de Restaurant.menuItemOrder.
 * La base está simulada; MenuClient se reemplaza por un doble y se miran
 * las props que recibe.
 */
const h = vi.hoisted(() => ({
  locale: "es",
  menuItemOrder: "alphabetical" as string,
  restaurantFindUnique: vi.fn(),
  translations: new Map<string, string>(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    restaurant: { findUnique: h.restaurantFindUnique },
    menu: {
      findMany: async () => [
        { id: "m1", slug: "carta", label: "Carta", description: null },
      ],
    },
    dishRating: { groupBy: async () => [] },
    table: {
      findUnique: async () => ({
        id: "t1",
        restaurantId: "r1",
        qrToken: "tok",
        number: 4,
        kind: "table",
        waiterCalledAt: null,
        waiterAckedAt: null,
      }),
    },
    order: { findFirst: async () => null },
  },
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
  getLocale: async () => h.locale,
  getTranslations: async () => (key: string) => key,
}));
vi.mock("@/auth", () => ({ auth: async () => null }));
vi.mock("@/lib/guestAccess", () => ({ canAccessTable: async () => true }));
vi.mock("@/lib/dinerSession", () => ({ getDiner: async () => null }));
vi.mock("@/lib/menus", () => ({ ensureDefaultMenu: async () => undefined }));
vi.mock("@/lib/menuTags", () => ({ getRestaurantMenuTags: async () => [] }));
vi.mock("@/lib/translateContent", () => ({
  getContentTranslations: async () => h.translations,
}));
vi.mock("./MenuClient", () => ({ MenuClient: () => null }));

import MenuPage from "./page";

const item = (
  id: string,
  categoryId: string,
  name: string,
  sortOrder: number,
) => ({
  id,
  restaurantId: "r1",
  categoryId,
  name,
  description: null,
  priceCents: 1_000_000,
  tags: [],
  photoUrl: null,
  modifiers: null,
  sortOrder,
});

// Como llegan de la base: por posición del editor (sortOrder).
const dbItems = [
  item("tiramisu", "postres", "Tiramisú", 10),
  item("brownie", "postres", "Brownie", 20),
  item("flan", "postres", "Flan de caramelo", 30),
  item("sopa", "entradas", "Sopa del día", 10),
  item("aji", "entradas", "Ají de gallina", 20),
  item("arepa", "entradas", "Arepa", 30),
  item("malbec", "malbec", "Catena Malbec", 10),
  item("alamos", "malbec", "Alamos Malbec", 20),
];

const dbCategories = [
  // Las categorías conservan su orden: Postres primero a propósito.
  { id: "postres", slug: "postres", label: "Postres", menuId: "m1", parentId: null, sortOrder: 0 },
  { id: "entradas", slug: "entradas", label: "Entradas", menuId: "m1", parentId: null, sortOrder: 1 },
  { id: "tintos", slug: "tintos", label: "Tintos", menuId: "m1", parentId: null, sortOrder: 2 },
  { id: "malbec", slug: "malbec", label: "Malbec", menuId: "m1", parentId: "tintos", sortOrder: 0 },
];

type ClientProps = {
  items: { id: string; name: string; categoryId: string }[];
  categories: { id: string }[];
};

async function render(): Promise<ClientProps> {
  const el = (await MenuPage({
    params: Promise.resolve({ slug: "demo" }),
    searchParams: Promise.resolve({ table: "tok" }),
  })) as { props: ClientProps };
  return el.props;
}

/** Ids de los platos de una categoría, en el orden en que llegan a MenuClient. */
const inCat = (props: ClientProps, cat: string) =>
  props.items.filter((i) => i.categoryId === cat).map((i) => i.id);

beforeEach(() => {
  h.locale = "es";
  h.menuItemOrder = "alphabetical";
  h.translations = new Map();
  h.restaurantFindUnique.mockReset();
  h.restaurantFindUnique.mockImplementation(async () => ({
    id: "r1",
    slug: "demo",
    name: "Demo",
    tagline: null,
    serviceMode: "table",
    logoUrl: null,
    menuItemOrder: h.menuItemOrder,
    categories: dbCategories,
    menuItems: dbItems,
  }));
});

describe("carta del comensal — orden de los platos", () => {
  it("alfabético (default): cada categoría y subcategoría en orden alfabético", async () => {
    const props = await render();
    expect(inCat(props, "postres")).toEqual(["brownie", "flan", "tiramisu"]);
    // "Ají" con tilde va en la A, antes de "Arepa".
    expect(inCat(props, "entradas")).toEqual(["aji", "arepa", "sopa"]);
    expect(inCat(props, "malbec")).toEqual(["alamos", "malbec"]);
  });

  it("las categorías NO se alfabetizan: conservan su orden", async () => {
    const props = await render();
    expect(props.categories.map((c) => c.id)).toEqual([
      "postres",
      "entradas",
      "tintos",
      "malbec",
    ]);
  });

  it("manual: el orden por posición del editor, como antes", async () => {
    h.menuItemOrder = "manual";
    const props = await render();
    expect(inCat(props, "postres")).toEqual(["tiramisu", "brownie", "flan"]);
    expect(inCat(props, "entradas")).toEqual(["sopa", "aji", "arepa"]);
    expect(inCat(props, "malbec")).toEqual(["malbec", "alamos"]);
  });

  it("un valor desconocido en la base cae a alfabético", async () => {
    h.menuItemOrder = "precio";
    const props = await render();
    expect(inCat(props, "postres")).toEqual(["brownie", "flan", "tiramisu"]);
  });

  it("con la carta traducida ordena por el nombre que ve el comensal", async () => {
    h.locale = "en";
    h.translations = new Map([
      ["MenuItem:tiramisu:name", "Tiramisu"],
      ["MenuItem:brownie:name", "Chocolate brownie"],
      ["MenuItem:flan:name", "Caramel custard"],
    ]);
    const props = await render();
    // En español sería Brownie, Flan, Tiramisú; en inglés cambia.
    expect(inCat(props, "postres")).toEqual(["flan", "brownie", "tiramisu"]);
    expect(props.items.find((i) => i.id === "flan")?.name).toBe("Caramel custard");
  });

  it("la consulta pide los platos con desempate fijo (manual igual que en el editor)", async () => {
    await render();
    const args = h.restaurantFindUnique.mock.calls[0][0];
    expect(args.include.menuItems.orderBy).toEqual([
      { sortOrder: "asc" },
      { createdAt: "asc" },
      { id: "asc" },
    ]);
  });
});
