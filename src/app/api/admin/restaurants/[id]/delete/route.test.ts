import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  remove: vi.fn(),
  preview: vi.fn(),
  cookie: { value: undefined as string | undefined },
  cookieDelete: vi.fn(),
}));
vi.mock("@/auth", () => ({ auth: mocks.auth }));
vi.mock("@/lib/secureApi", () => ({ secureApi: (handler: unknown) => handler }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: () => (mocks.cookie.value ? { value: mocks.cookie.value } : undefined),
    delete: mocks.cookieDelete,
  }),
}));
vi.mock("@/lib/restaurantDeletion", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/restaurantDeletion")>()),
  deleteRestaurant: mocks.remove,
  getDeletionPreview: mocks.preview,
}));

import { RestaurantDeletionError } from "@/lib/restaurantDeletion/errors";
import { GET, POST } from "./route";

const params = { params: Promise.resolve({ id: "r1" }) };
const post = (body: unknown) =>
  POST(
    new Request("http://localhost/api/admin/restaurants/r1/delete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    params,
  );
const get = () => GET(new Request("http://localhost/api/admin/restaurants/r1/delete"), params);
const admin = { user: { id: "admin-1", email: "admin@mesapay.co", role: "platform_admin" } };

beforeEach(() => {
  vi.resetAllMocks();
  mocks.cookie.value = undefined;
  mocks.auth.mockResolvedValue(admin);
  mocks.preview.mockResolvedValue({ restaurant: { id: "r1", slug: "sonymelona" }, counts: {}, blockers: [], warnings: [] });
  mocks.remove.mockResolvedValue({ archiveId: "arch-1", summary: { orders: 3 }, files: { deleted: 1, kept: 0, missing: 0, failed: 0 } });
});

describe("permisos: sólo platform_admin", () => {
  it("sin sesión → 401", async () => {
    mocks.auth.mockResolvedValue(null);
    expect((await get()).status).toBe(401);
    expect((await post({ confirmSlug: "sonymelona" })).status).toBe(401);
    expect(mocks.remove).not.toHaveBeenCalled();
  });

  it.each(["operator", "group_admin", "mesero", "kitchen", "bar", "terminal", "comercial", "gerente_comercial", "customer"])(
    "%s → 403, aunque esté impersonando este comercio",
    async (role) => {
      mocks.auth.mockResolvedValue({ user: { id: "u", email: "u@x.co", role, restaurantId: "r1" } });
      mocks.cookie.value = "r1";
      expect((await get()).status).toBe(403);
      expect((await post({ confirmSlug: "sonymelona" })).status).toBe(403);
      expect(mocks.preview).not.toHaveBeenCalled();
      expect(mocks.remove).not.toHaveBeenCalled();
    },
  );

  it("platform_admin ve el resumen", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ restaurant: { slug: "sonymelona" }, blockers: [] });
  });

  it("resumen de un comercio que no existe → 404", async () => {
    mocks.preview.mockResolvedValue(null);
    expect((await get()).status).toBe(404);
  });
});

describe("borrar", () => {
  it("sin confirmSlug → 400 sin llamar al servicio", async () => {
    expect((await post({})).status).toBe(400);
    expect((await post(null)).status).toBe(400);
    expect(mocks.remove).not.toHaveBeenCalled();
  });

  it("pasa el slug tipeado y el actor de la sesión al servicio", async () => {
    const res = await post({ confirmSlug: "sonymelona" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, archiveId: "arch-1" });
    expect(mocks.remove).toHaveBeenCalledWith({
      restaurantId: "r1",
      confirmSlug: "sonymelona",
      actor: { id: "admin-1", email: "admin@mesapay.co", role: "platform_admin" },
    });
  });

  it("confirmSlug incorrecto → 400 confirm_mismatch", async () => {
    mocks.remove.mockRejectedValue(new RestaurantDeletionError("confirm_mismatch"));
    const res = await post({ confirmSlug: "otro" });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "confirm_mismatch" });
  });

  it("bloqueado por pagos o DIAN pendientes → 409 con los bloqueos", async () => {
    const blockers = [
      { code: "payments_pending", count: 2 },
      { code: "dian_pending", count: 1 },
    ];
    mocks.remove.mockRejectedValue(new RestaurantDeletionError("blocked", { blockers: blockers as never }));
    const res = await post({ confirmSlug: "sonymelona" });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "blocked", blockers });
  });

  it.each(["archive_too_large", "concurrent_activity", "leftover_rows"] as const)("%s → 409", async (code) => {
    mocks.remove.mockRejectedValue(new RestaurantDeletionError(code));
    expect((await post({ confirmSlug: "sonymelona" })).status).toBe(409);
  });

  it("limpia la impersonación del admin si apuntaba al comercio borrado", async () => {
    mocks.cookie.value = "r1";
    await post({ confirmSlug: "sonymelona" });
    expect(mocks.cookieDelete).toHaveBeenCalledWith("mesapay_act_as");
  });

  it("no toca la impersonación si apuntaba a otro comercio", async () => {
    mocks.cookie.value = "r2";
    await post({ confirmSlug: "sonymelona" });
    expect(mocks.cookieDelete).not.toHaveBeenCalled();
  });
});
