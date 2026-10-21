import { Prisma } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  auth: vi.fn(), activeRestaurant: vi.fn(), restaurant: vi.fn(),
  find: vi.fn(), read: vi.fn(), codeFind: vi.fn(), codeCreate: vi.fn(),
  primaryUpdate: vi.fn(), transaction: vi.fn(), lock: vi.fn(), audit: vi.fn(),
}));
vi.mock("@/lib/secureApi", () => ({ secureApi: (handler: unknown) => handler }));
vi.mock("@/auth", () => ({ auth: m.auth }));
vi.mock("@/lib/activeRestaurant", () => ({ getActiveRestaurantId: m.activeRestaurant }));
vi.mock("@/lib/orderLock", () => ({ lockStock: m.lock }));
vi.mock("@/lib/auditLog", () => ({ recordAuditEvent: m.audit }));
vi.mock("@/lib/db", () => ({ db: { restaurant: { findUnique: m.restaurant }, $transaction: m.transaction } }));

import { POST } from "./route";

const original = { id: "ingredient-1", name: "Milk", barcode: "PRIMARY", active: true, trackInventory: true };
const tx = {
  ingredient: { findFirst: m.find, findUniqueOrThrow: m.read, updateMany: m.primaryUpdate },
  ingredientBarcode: { findUnique: m.codeFind, create: m.codeCreate },
};
const request = (body: unknown) => new Request("http://localhost/api/operator/ingredients/ingredient-1/barcode", {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
});
const assign = (body: unknown = { barcode: "00123ab" }) => POST(request(body), { params: Promise.resolve({ id: original.id }) });
const result = (barcode = "00123ab") => ({ id: original.id, barcode: original.barcode, barcodes: [{ barcode }, { barcode: original.barcode }] });

beforeEach(() => {
  vi.resetAllMocks();
  m.auth.mockResolvedValue({ user: { id: "operator-1", role: "operator" } });
  m.activeRestaurant.mockResolvedValue("restaurant-1");
  m.restaurant.mockResolvedValue({ enabledModules: ["inventory"], country: "CO" });
  m.find.mockResolvedValue(original);
  m.read.mockResolvedValue(result());
  m.codeFind.mockResolvedValue(null);
  m.codeCreate.mockResolvedValue({ id: "barcode-1" });
  m.primaryUpdate.mockResolvedValue({ count: 1 });
  m.transaction.mockImplementation((callback: (client: typeof tx) => unknown) => callback(tx));
});

describe("inventory barcode authorization", () => {
  it.each(["operator", "platform_admin", "group_admin"])("allows scoped %s with inventory", async (role) => {
    m.auth.mockResolvedValue({ user: { id: "operator-1", role } });
    expect((await assign()).status).toBe(200);
  });

  it.each([null, "mesero", "kitchen", "bar", "terminal", "diner"])("rejects role %s before mutation", async (role) => {
    m.auth.mockResolvedValue(role ? { user: { role } } : null);
    const response = await assign();
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthorized" });
    expect(m.transaction).not.toHaveBeenCalled();
  });

  it.each([{ modules: [] }, { modules: ["purchasing"] }, { modules: ["recipes"] }])("requires inventory: %j", async ({ modules }) => {
    m.restaurant.mockResolvedValue({ enabledModules: modules, country: "CO" });
    const response = await assign();
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "module_disabled" });
    expect(m.transaction).not.toHaveBeenCalled();
  });

  it("rejects a missing active restaurant", async () => {
    m.activeRestaurant.mockResolvedValue(null);
    expect((await assign()).status).toBe(400);
    expect(m.transaction).not.toHaveBeenCalled();
  });

  it("does not expose an ingredient outside the active tenant", async () => {
    m.find.mockResolvedValue(null);
    const response = await assign();
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not_found" });
    expect(m.find).toHaveBeenCalledWith(expect.objectContaining({ where: { id: original.id, restaurantId: "restaurant-1" } }));
    expect(m.codeCreate).not.toHaveBeenCalled();
    expect(m.primaryUpdate).not.toHaveBeenCalled();
    expect(m.audit).not.toHaveBeenCalled();
  });
});

describe("barcode input validation", () => {
  it.each([
    null, [], {}, { barcode: null }, { barcode: 123 }, { barcode: false },
    { barcode: "" }, { barcode: " \t\r\n\u0000á" }, { barcode: "x".repeat(65) },
    { barcode: "123", name: "changed" }, { barcode: "123", restaurantId: "other" },
  ])("rejects malformed or unrelated fields: %j", async (body) => {
    const response = await assign(body);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid" });
    expect(m.transaction).not.toHaveBeenCalled();
  });

  it("handles malformed JSON as a validation error", async () => {
    const response = await POST(new Request("http://localhost/api/operator/ingredients/ingredient-1/barcode", { method: "POST", body: "{" }), { params: Promise.resolve({ id: original.id }) });
    expect(response.status).toBe(400);
    expect(m.transaction).not.toHaveBeenCalled();
  });

  it.each([
    [" \t00 123ab\r\n", "00123ab"], ["ABcd\u00001\u001f2", "ABcd12"],
    ["0", "0"], ["x".repeat(64), "x".repeat(64)],
  ])("normalizes %j without changing case or leading zeroes", async (raw, barcode) => {
    m.read.mockResolvedValue(result(barcode));
    const response = await assign({ barcode: raw });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ingredient: result(barcode) });
    expect(m.codeCreate).toHaveBeenCalledWith({ data: { restaurantId: "restaurant-1", ingredientId: original.id, barcode } });
    expect(m.primaryUpdate).not.toHaveBeenCalled();
  });
});

describe("additional barcode mutation", () => {
  it("preserves the primary and returns the complete own registry", async () => {
    const response = await assign();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ingredient: result() });
    expect(m.primaryUpdate).not.toHaveBeenCalled();
    expect(m.read).toHaveBeenCalledWith({
      where: { id: original.id, restaurantId: "restaurant-1" },
      select: { id: true, barcode: true, barcodes: { where: { restaurantId: "restaurant-1" }, select: { barcode: true }, orderBy: { barcode: "asc" } } },
    });
  });

  it("locks before reading and audits only the committed addition", async () => {
    await assign();
    expect(m.lock).toHaveBeenCalledWith(tx, "restaurant-1");
    expect(m.lock.mock.invocationCallOrder[0]).toBeLessThan(m.find.mock.invocationCallOrder[0]);
    expect(m.codeFind).toHaveBeenCalledWith({ where: { restaurantId_barcode: { restaurantId: "restaurant-1", barcode: "00123ab" } }, select: { ingredientId: true } });
    expect(m.audit).toHaveBeenCalledWith({
      kind: "ingredient.barcode.add", restaurantId: "restaurant-1",
      target: { type: "ingredient", id: original.id }, summary: original.name,
      diff: { before: { barcode: null }, after: { barcode: "00123ab" } },
    });
    expect(m.codeCreate.mock.invocationCallOrder[0]).toBeLessThan(m.audit.mock.invocationCallOrder[0]);
  });

  it.each([
    [{ active: false }, "ingredient_inactive"],
    [{ trackInventory: false }, "ingredient_not_tracked"],
  ])("rejects unavailable inventory ingredients: %j", async (change, error) => {
    m.find.mockResolvedValue({ ...original, ...change });
    const response = await assign();
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error });
    expect(m.codeCreate).not.toHaveBeenCalled();
    expect(m.primaryUpdate).not.toHaveBeenCalled();
    expect(m.audit).not.toHaveBeenCalled();
  });

  it("sets the first code only when the primary is still missing", async () => {
    m.find.mockResolvedValue({ ...original, barcode: null });
    const ingredient = { id: original.id, barcode: "00123ab", barcodes: [{ barcode: "00123ab" }] };
    m.read.mockResolvedValue(ingredient);
    const response = await assign();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ingredient });
    expect(m.primaryUpdate).toHaveBeenCalledWith({
      where: { id: original.id, restaurantId: "restaurant-1", barcode: null, active: true, trackInventory: true },
      data: { barcode: "00123ab" },
    });
    expect(m.codeCreate).not.toHaveBeenCalled();
    expect(m.audit).toHaveBeenCalledTimes(1);
  });

  it.each(["PRIMARY", "00123ab"])("makes a repeated own code idempotent: %s", async (barcode) => {
    m.codeFind.mockResolvedValue({ ingredientId: original.id });
    const response = await assign({ barcode: " " + barcode + "\r\n" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ingredient: result() });
    expect(m.codeCreate).not.toHaveBeenCalled();
    expect(m.primaryUpdate).not.toHaveBeenCalled();
    expect(m.audit).not.toHaveBeenCalled();
  });

  it("can select an existing own alias as the first primary without duplicating it", async () => {
    m.find.mockResolvedValue({ ...original, barcode: null });
    m.codeFind.mockResolvedValue({ ingredientId: original.id });
    expect((await assign()).status).toBe(200);
    expect(m.primaryUpdate).toHaveBeenCalledTimes(1);
    expect(m.codeCreate).not.toHaveBeenCalled();
    expect(m.audit).not.toHaveBeenCalled();
  });

  it("rejects another ingredient's code without exposing its owner", async () => {
    m.codeFind.mockResolvedValue({ ingredientId: "another-ingredient" });
    const response = await assign();
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "barcode_taken" });
    expect(m.codeCreate).not.toHaveBeenCalled();
    expect(m.primaryUpdate).not.toHaveBeenCalled();
    expect(m.audit).not.toHaveBeenCalled();
  });

  it("does not overwrite a first primary added outside the advisory lock", async () => {
    m.find.mockResolvedValue({ ...original, barcode: null });
    m.primaryUpdate.mockResolvedValue({ count: 0 });
    const response = await assign();
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "operation_conflict" });
    expect(m.codeCreate).not.toHaveBeenCalled();
    expect(m.audit).not.toHaveBeenCalled();
  });

  it.each(["primary", "additional"])("translates a %s unique-index race to barcode_taken", async (kind) => {
    const duplicate = new Prisma.PrismaClientKnownRequestError("duplicate", { code: "P2002", clientVersion: "6" });
    if (kind === "primary") {
      m.find.mockResolvedValue({ ...original, barcode: null });
      m.primaryUpdate.mockRejectedValue(duplicate);
    } else m.codeCreate.mockRejectedValue(duplicate);
    const response = await assign();
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "barcode_taken" });
    expect(m.audit).not.toHaveBeenCalled();
  });

  it("does not disguise unrelated storage errors as duplicate barcodes", async () => {
    const failure = new Error("storage unavailable");
    m.codeCreate.mockRejectedValue(failure);
    await expect(assign()).rejects.toBe(failure);
    expect(m.audit).not.toHaveBeenCalled();
  });
});
