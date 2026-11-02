import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * GET /api/operator/menu-items/sold-out: los platos agotados del comercio
 * activo (y sólo de él), con su categoría y ordenados como la carta. Lo
 * consume el aviso de «Platos agotados» al abrir el turno.
 */

const m = vi.hoisted(() => ({ auth: vi.fn(), findMany: vi.fn() }));

vi.mock("@/lib/secureApi", () => ({ secureApi: (fn: unknown) => fn }));
vi.mock("@/auth", () => ({ auth: m.auth }));
vi.mock("@/lib/activeRestaurant", () => ({ getActiveRestaurantId: async () => "rest-1" }));
vi.mock("@/lib/db", () => ({ db: { menuItem: { findMany: m.findMany } } }));

import { GET } from "./route";

const get = () => GET(new Request("http://localhost/api/operator/menu-items/sold-out"));

beforeEach(() => {
  vi.clearAllMocks();
  m.auth.mockResolvedValue({ user: { id: "op-1", role: "operator" } });
  m.findMany.mockResolvedValue([
    {
      id: "it-2",
      name: "Bandeja paisa",
      sortOrder: 20,
      updatedAt: new Date("2026-11-01T18:00:00Z"),
      category: { label: "Fuertes", sortOrder: 20, parent: null },
    },
    {
      id: "it-1",
      name: "Ceviche",
      sortOrder: 5,
      updatedAt: new Date("2026-10-28T18:00:00Z"),
      category: { label: "Entradas", sortOrder: 10, parent: null },
    },
    {
      id: "it-3",
      name: "Catena",
      sortOrder: 1,
      updatedAt: new Date("2026-10-20T18:00:00Z"),
      category: { label: "Malbec", sortOrder: 1, parent: { label: "Vinos", sortOrder: 30 } },
    },
  ]);
});

describe("GET /api/operator/menu-items/sold-out", () => {
  it("pide sólo los agotados del comercio activo", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(m.findMany).toHaveBeenCalledTimes(1);
    expect(m.findMany.mock.calls[0][0]).toMatchObject({
      where: { restaurantId: "rest-1", available: false },
    });
  });

  it("devuelve id, nombre, categoría y desde cuándo, en el orden de la carta", async () => {
    const res = await get();
    const body = (await res.json()) as { items: Array<Record<string, string>> };
    expect(body.items).toEqual([
      { id: "it-1", name: "Ceviche", categoryName: "Entradas", soldOutSince: "2026-10-28T18:00:00.000Z" },
      { id: "it-2", name: "Bandeja paisa", categoryName: "Fuertes", soldOutSince: "2026-11-01T18:00:00.000Z" },
      { id: "it-3", name: "Catena", categoryName: "Vinos › Malbec", soldOutSince: "2026-10-20T18:00:00.000Z" },
    ]);
  });

  it("sin carta agotada devuelve la lista vacía", async () => {
    m.findMany.mockResolvedValue([]);
    const res = await get();
    expect(await res.json()).toEqual({ items: [] });
  });

  it("un mesero no puede leer la lista", async () => {
    m.auth.mockResolvedValue({ user: { id: "w-1", role: "mesero" } });
    const res = await get();
    expect(res.status).toBe(401);
    expect(m.findMany).not.toHaveBeenCalled();
  });
});
