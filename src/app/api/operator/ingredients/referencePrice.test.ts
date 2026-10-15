import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ context: vi.fn(), find: vi.fn(), list: vi.fn(), create: vi.fn(), update: vi.fn(), level: vi.fn(), lock: vi.fn(), movementCount: vi.fn(), audit: vi.fn() }));
vi.mock("@/lib/secureApi", () => ({ secureApi: (handler: unknown) => handler }));
vi.mock("@/lib/erp/access", () => ({ getErpContext: m.context, isDenied: (ctx: { error?: string }) => !!ctx.error }));
vi.mock("@/lib/orderLock", () => ({ lockStock: m.lock }));
vi.mock("@/lib/auditLog", () => ({ recordAuditEvent: m.audit }));
vi.mock("@/lib/db", () => {
  const tx = { ingredient: { findUnique: m.find, findMany: m.list, create: m.create, update: m.update }, stockLevel: { findUnique: m.level }, stockMovement: { count: m.movementCount } };
  return { db: { ...tx, $transaction: (fn: (tx: unknown) => unknown) => fn(tx) } };
});
import { GET, POST } from "./route";
import { PATCH } from "./[id]/route";

const current = { id: "ingredient", restaurantId: "restaurant", name: "Harina", measureKind: "mass", active: true, trackInventory: true, referencePriceCents: 180000, _count: { supplierItems: 0 } };
const params = { params: Promise.resolve({ id: current.id }) };
const request = (body: unknown) => new Request("http://localhost/api/operator/ingredients", { method: "POST", body: JSON.stringify(body) });
const patch = (body: unknown) => PATCH(request(body), params);

beforeEach(() => {
  vi.resetAllMocks();
  m.context.mockResolvedValue({ restaurantId: current.restaurantId, userId: "operator" });
  m.find.mockResolvedValue(current);
  m.list.mockResolvedValue([current]);
  m.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ ...current, ...data }));
  m.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: "new", ...data }));
  m.level.mockResolvedValue(null);
  m.movementCount.mockResolvedValue(0);
});

describe("ingredient reference price writes", () => {
  it("returns prices with the tenant-scoped catalog used by purchase selectors", async () => {
    const response = await GET();
    expect(response.status).toBe(200);
    expect((await response.json()).ingredients).toEqual([current]);
    expect(m.list).toHaveBeenCalledWith(expect.objectContaining({ where: { restaurantId: current.restaurantId } }));
  });

  it("rejects catalog reads and creates before querying or writing when the ERP gate denies access", async () => {
    m.context.mockResolvedValue({ error: "unauthorized", status: 401 });
    expect((await GET()).status).toBe(401);
    expect((await POST(request({ name: "Unauthorized", measureKind: "mass", referencePriceCents: 1 }))).status).toBe(401);
    expect(m.list).not.toHaveBeenCalled();
    expect(m.find).not.toHaveBeenCalled();
    expect(m.create).not.toHaveBeenCalled();
  });

  it.each([0, 2500000, 2_000_000_000, null])("creates a price of %s without supplier or stock writes", async (referencePriceCents) => {
    m.find.mockResolvedValue(null);
    const response = await POST(request({ name: "Arroz", measureKind: "mass", referencePriceCents }));
    expect(response.status).toBe(201);
    expect((await response.json()).ingredient.referencePriceCents).toBe(referencePriceCents);
    expect(m.create).toHaveBeenCalledWith({ data: expect.objectContaining({ referencePriceCents }) });
    expect(m.level).not.toHaveBeenCalled();
  });

  it("creates ingredients without inventing a missing reference price", async () => {
    m.find.mockResolvedValue(null);
    const response = await POST(request({ name: "Arroz", measureKind: "mass" }));
    expect((await response.json()).ingredient.referencePriceCents).toBeNull();
  });

  it.each([-1, 1.5, 2_000_000_001, "1500", true])("rejects an invalid reference price %j on create and update", async (referencePriceCents) => {
    expect((await POST(request({ name: "Arroz", measureKind: "mass", referencePriceCents }))).status).toBe(400);
    expect((await patch({ referencePriceCents })).status).toBe(400);
    expect(m.create).not.toHaveBeenCalled();
    expect(m.update).not.toHaveBeenCalled();
  });

  it.each([0, 350000, null])("updates or clears a price to %s without mutating the stock", async (referencePriceCents) => {
    const response = await patch({ referencePriceCents });
    expect(response.status).toBe(200);
    expect((await response.json()).ingredient.referencePriceCents).toBe(referencePriceCents);
    expect(m.lock).toHaveBeenCalled();
    expect(m.update).toHaveBeenCalledWith({ where: { id: current.id, restaurantId: current.restaurantId }, data: { referencePriceCents } });
    expect(m.level).not.toHaveBeenCalled();
    expect(m.audit).toHaveBeenCalledWith(expect.objectContaining({
      kind: "ingredient.reference_price.update", restaurantId: current.restaurantId,
      diff: { before: { referencePriceCents: 180000, measureKind: "mass" }, after: { referencePriceCents, measureKind: "mass" } },
    }));
  });

  it("preserves omitted reference prices during ordinary edits", async () => {
    expect((await patch({ notes: "Updated" })).status).toBe(200);
    expect(m.update).toHaveBeenCalledWith(expect.objectContaining({ data: { notes: "Updated" } }));
    expect(m.audit).not.toHaveBeenCalled();
  });

  it("clears the old reference when changing measurement dimension without a replacement price", async () => {
    expect((await patch({ measureKind: "volume" })).status).toBe(200);
    expect(m.update).toHaveBeenCalledWith(expect.objectContaining({ data: { measureKind: "volume", referencePriceCents: null } }));
  });

  it("preserves a price when the submitted dimension is unchanged", async () => {
    expect((await patch({ measureKind: "mass" })).status).toBe(200);
    expect(m.update).toHaveBeenCalledWith(expect.objectContaining({ data: { measureKind: "mass" } }));
    expect(m.audit).not.toHaveBeenCalled();
  });

  it("accepts an explicit replacement price for the new dimension", async () => {
    expect((await patch({ measureKind: "volume", referencePriceCents: 90000 })).status).toBe(200);
    expect(m.update).toHaveBeenCalledWith(expect.objectContaining({ data: { measureKind: "volume", referencePriceCents: 90000 } }));
  });

  it("audits the current price read under lock instead of an earlier stale read", async () => {
    m.find.mockResolvedValueOnce(current).mockResolvedValueOnce({ ...current, referencePriceCents: 190000 });
    await patch({ referencePriceCents: 220000 });
    expect(m.audit).toHaveBeenCalledWith(expect.objectContaining({ diff: expect.objectContaining({ before: { referencePriceCents: 190000, measureKind: "mass" } }) }));
  });

  it("does not record a price change when the price did not change", async () => {
    await patch({ referencePriceCents: current.referencePriceCents });
    expect(m.audit).not.toHaveBeenCalled();
  });

  it("rejects foreign ingredients and module denial before mutation", async () => {
    m.find.mockResolvedValue({ ...current, restaurantId: "other" });
    expect((await patch({ referencePriceCents: 500 })).status).toBe(404);
    m.context.mockResolvedValue({ error: "module_disabled", status: 403 });
    expect((await patch({ referencePriceCents: 500 })).status).toBe(403);
    expect(m.update).not.toHaveBeenCalled();
    expect(m.audit).not.toHaveBeenCalled();
  });

  it("rejects a duplicate name without applying the submitted price", async () => {
    expect((await POST(request({ name: current.name, measureKind: "mass", referencePriceCents: 1 }))).status).toBe(409);
    expect((await patch({ name: "Duplicate name", referencePriceCents: 1 })).status).toBe(409);
    expect(m.create).not.toHaveBeenCalled();
    expect(m.update).not.toHaveBeenCalled();
    expect(m.audit).not.toHaveBeenCalled();
  });

  it("rejects barcode collisions without partially saving a price", async () => {
    m.find.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: "barcode-owner" });
    expect((await POST(request({ name: "New", measureKind: "mass", barcode: "123456", referencePriceCents: 1 }))).status).toBe(409);
    m.find.mockResolvedValueOnce(current).mockResolvedValueOnce({ id: "barcode-owner" });
    expect((await patch({ barcode: "123456", referencePriceCents: 1 })).status).toBe(409);
    expect(m.create).not.toHaveBeenCalled();
    expect(m.update).not.toHaveBeenCalled();
    expect(m.audit).not.toHaveBeenCalled();
  });
});
