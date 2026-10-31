import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ auth: vi.fn(), cookie: undefined as string | undefined, restaurant: vi.fn() }));
vi.mock("@/auth", () => ({ auth: h.auth }));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => (h.cookie ? { value: h.cookie } : undefined) }),
}));
vi.mock("@/lib/db", () => ({ db: { restaurant: { findUnique: h.restaurant } } }));

import { getActiveContext } from "./activeRestaurant";

beforeEach(() => {
  vi.resetAllMocks();
  h.cookie = undefined;
  h.auth.mockResolvedValue({ user: { id: "admin", role: "platform_admin" } });
});

describe("impersonación de un platform_admin", () => {
  it("entra al comercio de la cookie si existe", async () => {
    h.cookie = "r1";
    h.restaurant.mockResolvedValue({ id: "r1" });
    expect(await getActiveContext()).toMatchObject({ restaurantId: "r1", impersonating: true });
  });

  it("ignora la cookie de un comercio eliminado y vuelve a la plataforma", async () => {
    h.cookie = "borrado";
    h.restaurant.mockResolvedValue(null);
    expect(await getActiveContext()).toMatchObject({ restaurantId: null, impersonating: false });
  });

  it("sin cookie no consulta la base", async () => {
    expect(await getActiveContext()).toMatchObject({ restaurantId: null, impersonating: false });
    expect(h.restaurant).not.toHaveBeenCalled();
  });
});
