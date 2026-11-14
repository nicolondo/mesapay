import { beforeEach, describe, expect, it, vi } from "vitest";

// POST /api/operator/ingredients con un nombre repetido: la respuesta dice
// CUÁL insumo ya existe (y si está archivado), para que el alta desde el
// conteo lo ofrezca en vez de dejar un callejón sin salida.
const m = vi.hoisted(() => ({ context: vi.fn(), find: vi.fn(), code: vi.fn(), create: vi.fn(), audit: vi.fn() }));
vi.mock("@/lib/secureApi", () => ({ secureApi: (handler: unknown) => handler }));
vi.mock("@/lib/erp/access", () => ({ getErpContext: m.context, isDenied: (ctx: { error?: string }) => !!ctx.error }));
vi.mock("@/lib/auditLog", () => ({ recordAuditEvent: m.audit }));
vi.mock("@/lib/erp/recipeData", () => ({
  loadIngredientCostViews: async () => new Map(),
  EMPTY_INGREDIENT_COST_VIEW: { costPerBase: null, costSource: null, purchaseCost: null },
}));
vi.mock("@/lib/db", () => ({ db: { ingredient: { findUnique: m.find, create: m.create }, ingredientBarcode: { findUnique: m.code } } }));

import { POST } from "./route";

const create = (body: unknown) => POST(new Request("http://localhost/api/operator/ingredients", { method: "POST", body: JSON.stringify(body) }));

beforeEach(() => {
  vi.resetAllMocks();
  m.context.mockResolvedValue({ restaurantId: "restaurant", userId: "operator" });
  m.find.mockResolvedValue(null);
  m.code.mockResolvedValue(null);
  m.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: "new", ...data }));
});

describe("alta de insumo con nombre repetido", () => {
  it.each([true, false])("nombra el insumo existente (activo: %s) y no crea nada", async (active) => {
    m.find.mockResolvedValue({ id: "existing", name: "Vino blanco", active, trackInventory: true });
    const response = await create({ name: "  Vino blanco ", measureKind: "volume", barcode: "7804436720807" });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "name_taken", existing: { id: "existing", name: "Vino blanco", active, trackInventory: true } });
    expect(m.find).toHaveBeenCalledWith({
      where: { restaurantId_name: { restaurantId: "restaurant", name: "Vino blanco" } },
      select: { id: true, name: true, active: true, trackInventory: true },
    });
    expect(m.create).not.toHaveBeenCalled();
    // El nombre se revisa antes que el código: un solo motivo por respuesta.
    expect(m.code).not.toHaveBeenCalled();
  });

  it("un nombre libre crea el insumo con inventario y su código ya limpio", async () => {
    const response = await create({ name: "Vino rosado", measureKind: "volume", category: "Licores", barcode: " 78 04\r\n" });
    expect(response.status).toBe(201);
    expect(m.create).toHaveBeenCalledWith({ data: expect.objectContaining({ restaurantId: "restaurant", name: "Vino rosado", category: "Licores", measureKind: "volume", trackInventory: true, barcode: "7804" }) });
  });
});
