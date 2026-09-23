import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Orden manual de los platos de una categoría. La base es un doble en
 * memoria: platos de dos comercios y dos categorías.
 */
type Row = { id: string; restaurantId: string; categoryId: string; sortOrder: number };

const h = vi.hoisted(() => ({
  role: "operator" as string,
  restaurantId: "merchant" as string | null,
  rows: [] as Row[],
  categories: {} as Record<string, { restaurantId: string }>,
  update: vi.fn(),
  transaction: vi.fn(),
}));

vi.mock("@/lib/secureApi", () => ({ secureApi: (fn: unknown) => fn }));
vi.mock("@/auth", () => ({
  auth: async () => ({ user: { role: h.role, email: "op@example.test" } }),
}));
vi.mock("@/lib/activeRestaurant", () => ({
  getActiveRestaurantId: async () => h.restaurantId,
}));
vi.mock("@/lib/db", () => {
  const tx = {
    menuItem: {
      findMany: async ({ where }: { where: { restaurantId: string; categoryId: string } }) =>
        h.rows
          .filter((r) => r.restaurantId === where.restaurantId && r.categoryId === where.categoryId)
          .map((r) => ({ id: r.id, sortOrder: r.sortOrder })),
      update: h.update,
    },
  };
  return {
    db: {
      category: {
        findUnique: async ({ where }: { where: { id: string } }) =>
          h.categories[where.id] ?? null,
      },
      $transaction: h.transaction.mockImplementation(
        async (fn: (t: typeof tx) => unknown) => fn(tx),
      ),
    },
  };
});

import { PATCH } from "./route";

const patch = (body: unknown) =>
  PATCH(
    new Request("https://fixture.test/api/operator/menu/items/reorder", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

beforeEach(() => {
  h.transaction.mockClear();
  h.update.mockReset();
  h.update.mockImplementation(
    async ({ where, data }: { where: { id: string }; data: { sortOrder: number } }) => {
      const r = h.rows.find((x) => x.id === where.id)!;
      r.sortOrder = data.sortOrder;
      return r;
    },
  );
  h.role = "operator";
  h.restaurantId = "merchant";
  h.categories = {
    postres: { restaurantId: "merchant" },
    bebidas: { restaurantId: "merchant" },
    ajena: { restaurantId: "otro" },
  };
  h.rows = [
    { id: "flan", restaurantId: "merchant", categoryId: "postres", sortOrder: 10 },
    { id: "brownie", restaurantId: "merchant", categoryId: "postres", sortOrder: 20 },
    { id: "tiramisu", restaurantId: "merchant", categoryId: "postres", sortOrder: 30 },
    { id: "agua", restaurantId: "merchant", categoryId: "bebidas", sortOrder: 10 },
    { id: "ajeno", restaurantId: "otro", categoryId: "ajena", sortOrder: 10 },
  ];
});

const positions = (cat: string) =>
  h.rows
    .filter((r) => r.categoryId === cat)
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((r) => r.id);

describe("PATCH /api/operator/menu/items/reorder", () => {
  it("reescribe las posiciones de la categoría en el orden pedido (200)", async () => {
    const res = await patch({
      categoryId: "postres",
      orderedIds: ["tiramisu", "flan", "brownie"],
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      positions: { tiramisu: 10, flan: 20, brownie: 30 },
    });
    expect(positions("postres")).toEqual(["tiramisu", "flan", "brownie"]);
    // En una transacción, y cada escritura acotada al comercio activo.
    expect(h.transaction).toHaveBeenCalledTimes(1);
    for (const call of h.update.mock.calls) {
      expect(call[0].where.restaurantId).toBe("merchant");
    }
    // Otra categoría no se toca.
    expect(positions("bebidas")).toEqual(["agua"]);
  });

  it("sólo escribe los platos cuya posición cambió", async () => {
    // brownie ↔ tiramisu: flan sigue en 10.
    await patch({ categoryId: "postres", orderedIds: ["flan", "tiramisu", "brownie"] });
    expect(h.update.mock.calls.map((c) => c[0].where.id).sort()).toEqual([
      "brownie",
      "tiramisu",
    ]);
  });

  it("400 si la lista está incompleta (falta un plato de la categoría)", async () => {
    const res = await patch({ categoryId: "postres", orderedIds: ["tiramisu", "flan"] });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "incomplete" });
    expect(h.update).not.toHaveBeenCalled();
  });

  it("400 con un plato de OTRO comercio", async () => {
    const res = await patch({
      categoryId: "postres",
      orderedIds: ["tiramisu", "flan", "brownie", "ajeno"],
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "foreign_items" });
    expect(h.update).not.toHaveBeenCalled();
  });

  it("400 con un plato de otra categoría del mismo comercio", async () => {
    const res = await patch({
      categoryId: "postres",
      orderedIds: ["tiramisu", "flan", "agua"],
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "foreign_items" });
    expect(h.update).not.toHaveBeenCalled();
  });

  it("400 con ids repetidos", async () => {
    const res = await patch({
      categoryId: "postres",
      orderedIds: ["flan", "flan", "brownie"],
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "duplicate_ids" });
    expect(h.transaction).not.toHaveBeenCalled();
  });

  it("400 con una categoría de otro comercio o inexistente", async () => {
    for (const categoryId of ["ajena", "no-existe"]) {
      const res = await patch({ categoryId, orderedIds: ["ajeno"] });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "invalid_category" });
    }
    expect(h.transaction).not.toHaveBeenCalled();
    expect(h.update).not.toHaveBeenCalled();
  });

  it("400 con un cuerpo mal formado", async () => {
    expect((await patch({ categoryId: "postres" })).status).toBe(400);
    expect((await patch({ categoryId: "postres", orderedIds: [] })).status).toBe(400);
    expect((await patch({ categoryId: "", orderedIds: ["flan"] })).status).toBe(400);
    expect(h.update).not.toHaveBeenCalled();
  });

  it("un mesero no puede reordenar la carta", async () => {
    h.role = "mesero";
    const res = await patch({ categoryId: "postres", orderedIds: ["tiramisu", "flan", "brownie"] });
    expect(res.status).toBe(401);
    expect(h.update).not.toHaveBeenCalled();
  });
});
