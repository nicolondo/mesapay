import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  auth: vi.fn(), activeRestaurant: vi.fn(), restaurant: vi.fn(),
  check: vi.fn(), run: vi.fn(), preview: vi.fn(),
}));
vi.mock("@/lib/secureApi", () => ({ secureApi: (handler: unknown) => handler }));
vi.mock("@/auth", () => ({ auth: m.auth }));
vi.mock("@/lib/activeRestaurant", () => ({ getActiveRestaurantId: m.activeRestaurant }));
vi.mock("@/lib/db", () => ({ db: { restaurant: { findUnique: m.restaurant } } }));
vi.mock("@/lib/erp/ingredientDeletion", () => ({
  ingredientDeletionCheck: m.check, runIngredientDeletion: m.run, previewIngredientDeletion: m.preview,
}));

import { db } from "@/lib/db";
import { DELETE, GET } from "./route";
import { POST } from "../../bulk-delete/route";

const params = { params: Promise.resolve({ id: "ing-1" }) };
const check = () => GET(new Request("http://localhost/api/operator/ingredients/ing-1/delete"), params);
const remove = () => DELETE(new Request("http://localhost/api/operator/ingredients/ing-1/delete", { method: "DELETE" }), params);
const bulk = (body: unknown) => POST(new Request("http://localhost/api/operator/ingredients/bulk-delete", {
  method: "POST", headers: { "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body),
}));
const reasons = [{ code: "recipes", count: 3, labels: ["Ajiaco"] }, { code: "movements", count: 12 }, { code: "stock", count: 1 }];

beforeEach(() => {
  vi.resetAllMocks();
  m.auth.mockResolvedValue({ user: { id: "owner-1", role: "operator" } });
  m.activeRestaurant.mockResolvedValue("restaurant-1");
  m.restaurant.mockResolvedValue({ enabledModules: ["inventory"], country: "CO" });
  m.check.mockResolvedValue({ deletable: true, removes: { barcodes: 2, supplierItems: 0, invoiceAliases: 0 } });
  m.run.mockResolvedValue({ deleted: [{ id: "ing-1", name: "Tomate" }], skipped: [], missing: [] });
  m.preview.mockResolvedValue({ deletable: [{ id: "ing-1", name: "Tomate" }], skipped: [], missing: [] });
});

describe("quién puede eliminar insumos", () => {
  it.each(["operator", "platform_admin", "group_admin"])("permite al rol %s con alguno de los módulos", async (role) => {
    m.auth.mockResolvedValue({ user: { id: "u", role } });
    expect((await check()).status).toBe(200);
    expect((await remove()).status).toBe(200);
    expect((await bulk({ ids: ["ing-1"] })).status).toBe(200);
  });

  it.each([null, "mesero", "kitchen", "bar", "terminal", "customer"])("rechaza el rol %s antes de consultar o borrar", async (role) => {
    m.auth.mockResolvedValue(role ? { user: { role } } : null);
    for (const response of [await check(), await remove(), await bulk({ ids: ["ing-1"] })]) {
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: "unauthorized" });
    }
    expect(m.check).not.toHaveBeenCalled();
    expect(m.run).not.toHaveBeenCalled();
    expect(m.preview).not.toHaveBeenCalled();
  });

  it.each([[["inventory"], 200], [["purchasing"], 200], [["recipes"], 200], [[], 403], [["accounting", "staff"], 403]] as const)(
    "módulos %j → %i", async (modules, status) => {
      m.restaurant.mockResolvedValue({ enabledModules: modules, country: "CO" });
      expect((await check()).status).toBe(status);
      expect((await remove()).status).toBe(status);
      expect((await bulk({ ids: ["ing-1"] })).status).toBe(status);
      if (status === 403) expect(m.run).not.toHaveBeenCalled();
    },
  );

  it("sin comercio activo no hace nada", async () => {
    m.activeRestaurant.mockResolvedValue(null);
    expect((await remove()).status).toBe(400);
    expect(m.run).not.toHaveBeenCalled();
  });
});

describe("GET …/[id]/delete — ¿se puede eliminar?", () => {
  it("responde la regla tal cual, para el comercio de la sesión", async () => {
    const response = await check();
    expect(await response.json()).toEqual({ deletable: true, removes: { barcodes: 2, supplierItems: 0, invoiceAliases: 0 } });
    expect(m.check).toHaveBeenCalledWith(db, "restaurant-1", "ing-1");
    expect(m.run).not.toHaveBeenCalled();
  });

  it("devuelve los motivos cuando no se puede", async () => {
    m.check.mockResolvedValue({ deletable: false, reasons });
    const response = await check();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ deletable: false, reasons });
  });

  it("404 si el insumo no es de este comercio", async () => {
    m.check.mockResolvedValue(null);
    const response = await check();
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not_found" });
  });
});

describe("DELETE …/[id]/delete — eliminar de verdad", () => {
  it("elimina y devuelve el nombre", async () => {
    const response = await remove();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, deleted: { id: "ing-1", name: "Tomate" } });
    expect(m.run).toHaveBeenCalledWith("restaurant-1", ["ing-1"]);
  });

  it("409 con los motivos cuando la regla no lo permite", async () => {
    m.run.mockResolvedValue({ deleted: [], skipped: [{ id: "ing-1", name: "Tomate", reasons }], missing: [] });
    const response = await remove();
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "not_deletable", reasons });
  });

  it("409 «conflict» si chocó con otra operación", async () => {
    m.run.mockResolvedValue({ error: "conflict" });
    const response = await remove();
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "conflict" });
  });

  it("404 si no existe en este comercio", async () => {
    m.run.mockResolvedValue({ deleted: [], skipped: [], missing: ["ing-1"] });
    const response = await remove();
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not_found" });
  });
});

describe("POST bulk-delete — eliminación masiva", () => {
  it("elimina los que se pueden y reporta los demás con sus motivos", async () => {
    m.run.mockResolvedValue({
      deleted: [{ id: "a", name: "A", category: "X", barcodes: ["1"], removes: {} }],
      skipped: [{ id: "b", name: "B", reasons }],
      missing: ["c"],
    });
    const response = await bulk({ ids: ["a", "b", "c"] });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ deleted: [{ id: "a", name: "A" }], skipped: [{ id: "b", name: "B", reasons }], missing: ["c"] });
    expect(m.run).toHaveBeenCalledWith("restaurant-1", ["a", "b", "c"]);
    expect(m.preview).not.toHaveBeenCalled();
  });

  it("con dryRun solo dice qué pasaría: no elimina", async () => {
    m.preview.mockResolvedValue({ deletable: [{ id: "a", name: "A" }], skipped: [{ id: "b", name: "B", reasons }], missing: [] });
    const response = await bulk({ ids: ["a", "b"], dryRun: true });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ deletable: [{ id: "a", name: "A" }], skipped: [{ id: "b", name: "B", reasons }], missing: [] });
    expect(m.preview).toHaveBeenCalledWith(db, "restaurant-1", ["a", "b"]);
    expect(m.run).not.toHaveBeenCalled();
  });

  it("404 si ninguno es de este comercio (también en la vista previa)", async () => {
    m.run.mockResolvedValue({ deleted: [], skipped: [], missing: ["x"] });
    m.preview.mockResolvedValue({ deletable: [], skipped: [], missing: ["x"] });
    expect((await bulk({ ids: ["x"] })).status).toBe(404);
    expect((await bulk({ ids: ["x"], dryRun: true })).status).toBe(404);
  });

  it("409 «conflict» si chocó con otra operación", async () => {
    m.run.mockResolvedValue({ error: "conflict" });
    const response = await bulk({ ids: ["a"] });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "conflict" });
  });

  it.each([
    {}, { ids: [] }, { ids: "a" }, { ids: [""] }, { ids: [1] }, { ids: ["a"], dryRun: "yes" }, { ids: ["a"], extra: true },
    { ids: Array.from({ length: 201 }, (_, i) => `id-${i}`) }, "not json",
  ])("rechaza un cuerpo inválido sin tocar nada: %j", async (body) => {
    const response = await bulk(body);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid" });
    expect(m.run).not.toHaveBeenCalled();
    expect(m.preview).not.toHaveBeenCalled();
  });

  it("acepta hasta 200 insumos por llamada", async () => {
    expect((await bulk({ ids: Array.from({ length: 200 }, (_, i) => `id-${i}`) })).status).toBe(200);
  });
});
