import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildCountBarcodeIndex } from "@/lib/erp/countView";

// GET /api/operator/stock/counts/[id]/scan?code= — de quién es un código que
// el conteo no encontró entre sus insumos, y por qué ese insumo no aparece.
const m = vi.hoisted(() => ({ auth: vi.fn(), activeRestaurant: vi.fn(), restaurant: vi.fn(), count: vi.fn(), code: vi.fn() }));
vi.mock("@/lib/secureApi", () => ({ secureApi: (handler: unknown) => handler }));
vi.mock("@/auth", () => ({ auth: m.auth }));
vi.mock("@/lib/activeRestaurant", () => ({ getActiveRestaurantId: m.activeRestaurant }));
vi.mock("@/lib/db", () => ({ db: { restaurant: { findUnique: m.restaurant }, stockCount: { findFirst: m.count }, ingredientBarcode: { findUnique: m.code } } }));

import { GET } from "./route";

const R = "restaurant-1";
type Ingredient = { id: string; name: string; active: boolean; trackInventory: boolean; category: string | null; barcode: string | null; barcodes: { barcode: string }[] };
const ingredient = (id: string, name: string, codes: string[], overrides: Partial<Ingredient> = {}): Ingredient => ({
  id, name, active: true, trackInventory: true, category: "Licores", barcode: codes[0] ?? null, barcodes: codes.map((barcode) => ({ barcode })), ...overrides,
});
const ron = ingredient("ron", "Ron añejo", ["RON-1", "RON-ALT"]);
const gin = ingredient("gin", "Gin botánico", ["GIN-1"]);
let catalog: Ingredient[];
let countItems: { id: string; ingredientId: string; ingredient: { category: string | null } }[];
let excluded: string[];

const call = (code: string | null, id = "count-1") => GET(
  new Request(`http://localhost/api/operator/stock/counts/${id}/scan${code === null ? "" : `?code=${encodeURIComponent(code)}`}`),
  { params: Promise.resolve({ id }) },
);

beforeEach(() => {
  vi.resetAllMocks();
  catalog = [ron, gin];
  countItems = [
    { id: "item-ron", ingredientId: "ron", ingredient: { category: "Licores" } },
    { id: "item-gin", ingredientId: "gin", ingredient: { category: "Licores" } },
  ];
  excluded = [];
  m.auth.mockResolvedValue({ user: { id: "operator-1", role: "operator" } });
  m.activeRestaurant.mockResolvedValue(R);
  m.restaurant.mockResolvedValue({ enabledModules: ["inventory"], country: "CO" });
  m.count.mockImplementation(async ({ where }: { where: { id: string; restaurantId: string } }) =>
    where.id === "count-1" && where.restaurantId === R ? { items: countItems, restaurant: { inventoryExcludedCategories: excluded } } : null);
  m.code.mockImplementation(async ({ where }: { where: { restaurantId_barcode: { restaurantId: string; barcode: string } } }) => {
    const { restaurantId, barcode } = where.restaurantId_barcode;
    const owner = restaurantId === R ? catalog.find((candidate) => candidate.barcodes.some((entry) => entry.barcode === barcode)) : undefined;
    return owner ? { ingredient: owner } : null;
  });
});

describe("autorización y entrada", () => {
  it.each([null, "mesero", "kitchen", "bar", "terminal", "diner"])("rechaza el rol %s", async (role) => {
    m.auth.mockResolvedValue(role ? { user: { role } } : null);
    expect((await call("RON-1")).status).toBe(401);
    expect(m.code).not.toHaveBeenCalled();
  });

  it("exige el módulo de inventario", async () => {
    m.restaurant.mockResolvedValue({ enabledModules: ["recipes"], country: "CO" });
    expect((await call("RON-1")).status).toBe(403);
    expect(m.code).not.toHaveBeenCalled();
  });

  it.each([null, "", " \t\r\n", "á", "x".repeat(65), "x".repeat(400)])("rechaza un código vacío o imposible: %j", async (code) => {
    const response = await call(code);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid" });
    expect(m.code).not.toHaveBeenCalled();
  });

  it("no revela conteos de otro comercio ni busca códigos para ellos", async () => {
    const response = await call("RON-1", "count-of-another-tenant");
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not_found" });
    expect(m.code).not.toHaveBeenCalled();
  });

  it("busca siempre dentro del comercio activo y con el código ya limpio", async () => {
    await call(" 77 04\r\n");
    expect(m.code).toHaveBeenCalledWith(expect.objectContaining({ where: { restaurantId_barcode: { restaurantId: R, barcode: "7704" } } }));
  });
});

describe("a quién pertenece el código", () => {
  it("nadie lo tiene: se puede vincular a un insumo o crear uno", async () => {
    const response = await call("UNKNOWN-9");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ code: "UNKNOWN-9", match: null });
  });

  it("coincide con el índice del navegador para los insumos del conteo (principal y adicionales)", async () => {
    const index = buildCountBarcodeIndex(countItems.map((item) => ({ id: item.id, ingredient: catalog.find((candidate) => candidate.id === item.ingredientId)! })));
    for (const code of ["RON-1", "RON-ALT", "GIN-1"]) {
      const body = await (await call(code)).json();
      expect(body.match).toMatchObject({ state: "in_count", itemId: index.get(code), canAppend: false });
    }
    // Lo que el navegador no encuentra, la API tampoco lo da por contado.
    expect(index.get("ARCH-1")).toBeUndefined();
  });

  it("insumo archivado (el caso real): dice cuál es y que está archivado", async () => {
    catalog.push(ingredient("old", "Vino blanco viejo", ["7804436720807"], { active: false }));
    const body = await (await call("7804436720807")).json();
    expect(body).toEqual({
      code: "7804436720807",
      match: {
        ingredient: { id: "old", name: "Vino blanco viejo", active: false, trackInventory: true, category: "Licores", barcode: "7804436720807", barcodes: [{ barcode: "7804436720807" }] },
        itemId: null, state: "archived", scopeCategory: "Licores", canAppend: false,
      },
    });
  });

  it("insumo que no lleva inventario", async () => {
    catalog.push(ingredient("svc", "Servilletas", ["SVC-1"], { trackInventory: false, category: "Aseo" }));
    expect((await (await call("SVC-1")).json()).match).toMatchObject({ state: "not_tracked", itemId: null, canAppend: false });
  });

  it("insumo de una categoría que no maneja inventario", async () => {
    excluded = ["Aseo"];
    catalog.push(ingredient("soap", "Jabón", ["SOAP-1"], { category: "Aseo" }));
    expect((await (await call("SOAP-1")).json()).match).toMatchObject({ state: "category_excluded", canAppend: false });
  });

  it("conteo abierto para una sola categoría: el insumo es de otra", async () => {
    catalog.push(ingredient("rice", "Arroz", ["RICE-1"], { category: "Abarrotes" }));
    expect((await (await call("RICE-1")).json()).match).toMatchObject({ state: "outside_scope", scopeCategory: "Licores", itemId: null, canAppend: true });
  });

  it("insumo creado o activado después de abrir el conteo", async () => {
    catalog.push(ingredient("vodka", "Vodka", ["VODKA-1"]));
    expect((await (await call("VODKA-1")).json()).match).toMatchObject({ state: "added_later", scopeCategory: "Licores", canAppend: true });
    // Conteo de todos los insumos (varias categorías): sin categoría de alcance.
    countItems.push({ id: "item-x", ingredientId: "x", ingredient: { category: "Abarrotes" } });
    expect((await (await call("VODKA-1")).json()).match).toMatchObject({ state: "added_later", scopeCategory: null, canAppend: true });
  });

  it("archivado gana sobre las demás razones", async () => {
    excluded = ["Aseo"];
    catalog.push(ingredient("gone", "Detergente", ["GONE-1"], { active: false, trackInventory: false, category: "Aseo" }));
    expect((await (await call("GONE-1")).json()).match.state).toBe("archived");
  });
});
