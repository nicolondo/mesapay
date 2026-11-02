import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CostContext } from "@/lib/erp/recipes";

const m = vi.hoisted(() => ({
  context: vi.fn(),
  loadCostContext: vi.fn(),
  menuItems: vi.fn(),
}));
vi.mock("@/lib/secureApi", () => ({ secureApi: (handler: unknown) => handler }));
vi.mock("@/lib/erp/access", () => ({
  getErpContext: m.context,
  isDenied: (ctx: { error?: string }) => !!ctx.error,
}));
vi.mock("@/lib/erp/recipeData", () => ({ loadCostContext: m.loadCostContext }));
vi.mock("@/lib/db", () => ({ db: { menuItem: { findMany: m.menuItems } } }));
import { GET } from "./route";

// El handler ignora la request; secureApi la exige en la firma.
const get = () =>
  GET(new Request("http://localhost/api/operator/recipes/cost-gaps"));

const restaurantId = "restaurant";

// Contexto de costeo del comercio: arroz costeado, sal en 0 (referencia
// explícita), cilantro sin fuente, y una salsa elaborada que usa tomate ($)
// y sal ($0).
const costCtx: CostContext = new Map([
  ["arroz", { referencePriceCents: 500000 }],
  ["sal", { referencePriceCents: 0 }],
  ["cilantro", { referencePriceCents: null }],
  ["tomate", { referencePriceCents: 400000 }],
  [
    "salsa",
    {
      recipe: {
        outputQtyBase: 1000,
        items: [
          { ingredientId: "tomate", qtyBase: 1000, wastePct: 0 },
          { ingredientId: "sal", qtyBase: 50, wastePct: 0 },
        ],
      },
    },
  ],
]);
const meta = new Map(
  [
    ["arroz", "Arroz", "mass"],
    ["sal", "Sal", "mass"],
    ["cilantro", "Cilantro", "mass"],
    ["tomate", "Tomate", "mass"],
    ["salsa", "Salsa de tomate", "volume"],
  ].map(([id, name, measureKind]) => [
    id,
    { id, name, measureKind, active: true, trackInventory: true },
  ]),
);

const dish = (
  id: string,
  name: string,
  items: Array<{ ingredientId: string; qtyBase: number; wastePct?: number }>,
) => ({
  id,
  name,
  category: { label: "Fuertes" },
  recipe: {
    items: items.map((it) => ({ wastePct: 0, ...it })),
  },
});

beforeEach(() => {
  vi.resetAllMocks();
  m.context.mockResolvedValue({ restaurantId, userId: "operator" });
  m.loadCostContext.mockResolvedValue({ ctx: costCtx, meta });
  m.menuItems.mockResolvedValue([
    dish("completo", "Arroz con pollo", [{ ingredientId: "arroz", qtyBase: 150 }]),
    dish("con-sal", "Arroz salado", [
      { ingredientId: "arroz", qtyBase: 150 },
      { ingredientId: "sal", qtyBase: 3 },
    ]),
    dish("con-salsa", "Pasta", [{ ingredientId: "salsa", qtyBase: 200, wastePct: 20 }]),
    dish("sin-cilantro", "Sopa", [
      { ingredientId: "cilantro", qtyBase: 5 },
      { ingredientId: "sal", qtyBase: 2 },
    ]),
  ]);
});

describe("GET /api/operator/recipes/cost-gaps", () => {
  it("rechaza sin consultar nada cuando el gate del ERP niega el acceso", async () => {
    m.context.mockResolvedValue({ error: "module_disabled", status: 403 });
    const res = await get();
    expect(res.status).toBe(403);
    expect(m.loadCostContext).not.toHaveBeenCalled();
    expect(m.menuItems).not.toHaveBeenCalled();
  });

  it("sólo mira los platos con receta del comercio activo", async () => {
    await get();
    expect(m.loadCostContext).toHaveBeenCalledWith(restaurantId);
    expect(m.menuItems).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { restaurantId, recipe: { isNot: null } },
      }),
    );
  });

  it("devuelve sólo los platos incompletos con sus insumos culpables, nombres y cadena de sub-recetas", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.items.map((i: { menuItemId: string }) => i.menuItemId)).toEqual([
      "con-sal",
      "con-salsa",
      "sin-cilantro",
    ]);

    expect(body.items[0]).toMatchObject({
      name: "Arroz salado",
      categoryName: "Fuertes",
      costCents: 75000,
      complete: true,
      missing: [
        { ingredientId: "sal", name: "Sal", measureKind: "mass", qtyBase: 3, reason: "zero", via: [] },
      ],
    });

    // La sal llega a la pasta a través de la salsa: se señala la hoja.
    expect(body.items[1]).toMatchObject({
      name: "Pasta",
      complete: true,
      missing: [
        { ingredientId: "sal", name: "Sal", reason: "zero", via: ["Salsa de tomate"] },
      ],
    });

    expect(body.items[2]).toMatchObject({
      name: "Sopa",
      complete: false,
      missing: expect.arrayContaining([
        expect.objectContaining({ ingredientId: "cilantro", reason: "none" }),
        expect.objectContaining({ ingredientId: "sal", reason: "zero" }),
      ]),
    });
  });

  it("agrega los insumos sin costo con cuántos platos afectan, los más usados primero", async () => {
    const body = await (await get()).json();
    expect(body.ingredientsWithoutCost).toEqual([
      { id: "sal", name: "Sal", measureKind: "mass", reason: "zero", usedInCount: 3, referencePriceCents: 0 },
      { id: "cilantro", name: "Cilantro", measureKind: "mass", reason: "none", usedInCount: 1, referencePriceCents: null },
    ]);
  });

  it("con todos los costos completos devuelve listas vacías", async () => {
    m.menuItems.mockResolvedValue([
      dish("completo", "Arroz con pollo", [{ ingredientId: "arroz", qtyBase: 150 }]),
    ]);
    const body = await (await get()).json();
    expect(body).toEqual({ items: [], ingredientsWithoutCost: [] });
  });
});
