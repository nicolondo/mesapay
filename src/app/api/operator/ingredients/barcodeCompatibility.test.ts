import { Prisma } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  context: vi.fn(), find: vi.fn(), list: vi.fn(), code: vi.fn(),
  create: vi.fn(), update: vi.fn(), lock: vi.fn(), audit: vi.fn(),
}));
vi.mock("@/lib/secureApi", () => ({ secureApi: (handler: unknown) => handler }));
vi.mock("@/lib/erp/access", () => ({ getErpContext: m.context, isDenied: (ctx: { error?: string }) => !!ctx.error }));
vi.mock("@/lib/orderLock", () => ({ lockStock: m.lock }));
vi.mock("@/lib/auditLog", () => ({ recordAuditEvent: m.audit }));
vi.mock("@/lib/db", () => {
  const tx = {
    ingredient: { findUnique: m.find, findMany: m.list, create: m.create, update: m.update },
    ingredientBarcode: { findUnique: m.code },
  };
  return { db: { ...tx, $transaction: (callback: (client: typeof tx) => unknown) => callback(tx) } };
});

import { GET, POST } from "./route";
import { PATCH } from "./[id]/route";
import { GET as GETStock } from "../stock/route";

const current = {
  id: "ingredient", restaurantId: "restaurant", name: "Milk", measureKind: "volume",
  active: true, trackInventory: true, barcode: "PRIMARY", referencePriceCents: null,
  _count: { supplierItems: 0 },
};
const request = (body: unknown) => new Request("http://localhost/api/operator/ingredients", {
  method: "POST", body: JSON.stringify(body),
});
const create = (barcode: string | null = "ALIAS") => POST(request({ name: "New", measureKind: "count", barcode }));
const patch = (barcode: string | null = "ALIAS") => PATCH(request({ barcode }), { params: Promise.resolve({ id: current.id }) });
const race = (target?: unknown) => new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
  code: "P2002", clientVersion: "6", ...(target === undefined ? {} : { meta: { target } }),
});

beforeEach(() => {
  vi.resetAllMocks();
  m.context.mockResolvedValue({ restaurantId: current.restaurantId, userId: "operator" });
  m.find.mockImplementation(async ({ where }: { where: { id?: string } }) => where.id ? current : null);
  m.code.mockResolvedValue(null);
  m.list.mockResolvedValue([]);
  m.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: "new", ...data }));
  m.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ ...current, ...data }));
});

describe("legacy ingredient writers with multiple barcodes", () => {
  it.each([create, patch])("rejects codes held as additional aliases before writing", async (write) => {
    m.code.mockResolvedValue({ ingredientId: "another-ingredient" });
    const response = await write(" 00 ALIAS\r\n");
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "barcode_taken" });
    expect(m.code).toHaveBeenCalledWith({
      where: { restaurantId_barcode: { restaurantId: current.restaurantId, barcode: "00ALIAS" } },
      select: { ingredientId: true },
    });
    expect(m.create).not.toHaveBeenCalled();
    expect(m.update).not.toHaveBeenCalled();
    expect(m.audit).not.toHaveBeenCalled();
  });

  it("can promote the same ingredient's existing alias to its primary code", async () => {
    m.code.mockResolvedValue({ ingredientId: current.id });
    const response = await patch(" 00ab\r\n");
    expect(response.status).toBe(200);
    expect((await response.json()).ingredient.barcode).toBe("00ab");
    expect(m.update).toHaveBeenCalledWith({
      where: { id: current.id, restaurantId: current.restaurantId }, data: { barcode: "00ab" },
    });
    expect(m.lock).toHaveBeenCalled();
  });

  it("does not change additional codes when the primary is cleared", async () => {
    expect((await patch(null)).status).toBe(200);
    expect(m.update).toHaveBeenCalledWith(expect.objectContaining({ data: { barcode: null } }));
    expect(m.code).not.toHaveBeenCalled();
  });

  it.each([create, patch])("preserves leading zeroes and letter case in primary writes", async (write) => {
    const response = await write(" 00 ab\r\n");
    expect(response.status).toBe(write === create ? 201 : 200);
    expect((await response.json()).ingredient.barcode).toBe("00ab");
  });

  it.each([create, patch])("rejects access before looking up barcode ownership", async (write) => {
    m.context.mockResolvedValue({ error: "module_disabled", status: 403 });
    expect((await write()).status).toBe(403);
    expect(m.code).not.toHaveBeenCalled();
    expect(m.update).not.toHaveBeenCalled();
    expect(m.create).not.toHaveBeenCalled();
  });

  it("does not reveal aliases on an ingredient owned by a different restaurant", async () => {
    m.find.mockResolvedValue({ ...current, restaurantId: "other" });
    expect((await patch()).status).toBe(404);
    expect(m.code).not.toHaveBeenCalled();
    expect(m.update).not.toHaveBeenCalled();
  });

  for (const [name, write, mutation] of [["create", create, m.create], ["update", patch, m.update]] as const) {
    describe(`${name} unique races`, () => {
      it.each([{ target: ["restaurantId", "barcode"] }, { target: "IngredientBarcode_restaurantId_barcode_key" }])("translates barcode uniqueness with target $target", async ({ target }) => {
        mutation.mockRejectedValue(race(target));
        const response = await write();
        expect(response.status).toBe(409);
        expect(await response.json()).toEqual({ error: "barcode_taken" });
        expect(m.audit).not.toHaveBeenCalled();
      });

      it("checks the canonical registry after an unlabelled trigger collision", async () => {
        m.code.mockResolvedValueOnce(null).mockResolvedValueOnce({ ingredientId: "another-ingredient" });
        mutation.mockRejectedValue(race());
        const response = await write();
        expect(response.status).toBe(409);
        expect(await response.json()).toEqual({ error: "barcode_taken" });
        expect(m.code).toHaveBeenCalledTimes(2);
      });

      it("does not disguise a different unique constraint as a barcode collision", async () => {
        const error = race(["restaurantId", "name"]);
        mutation.mockRejectedValue(error);
        await expect(write()).rejects.toBe(error);
      });

      it("does not disguise storage failures as duplicate barcodes", async () => {
        const error = new Error("storage unavailable");
        mutation.mockRejectedValue(error);
        await expect(write()).rejects.toBe(error);
      });
    });
  }

  it("does not classify an unlabelled own-alias error as another owner's collision", async () => {
    m.code.mockResolvedValue({ ingredientId: current.id });
    const error = race();
    m.update.mockRejectedValue(error);
    await expect(patch()).rejects.toBe(error);
  });
});

describe("barcode catalog projections", () => {
  it("returns all tenant-owned codes in the ingredient catalog", async () => {
    const row = { ...current, barcodes: [{ barcode: "PRIMARY" }, { barcode: "ALIAS" }] };
    m.list.mockResolvedValue([row]);
    const response = await GET(new Request("http://localhost/api/operator/ingredients"));
    expect((await response.json()).ingredients).toEqual([row]);
    expect(m.list).toHaveBeenCalledWith(expect.objectContaining({
      where: { restaurantId: current.restaurantId },
      include: expect.objectContaining({ barcodes: { where: { restaurantId: current.restaurantId }, select: { barcode: true }, orderBy: { barcode: "asc" } } }),
    }));
  });

  it("returns the primary and additional codes for stock scanning", async () => {
    const row = { ...current, barcodes: [{ barcode: "PRIMARY" }, { barcode: "ALIAS" }], stockLevel: null };
    m.list.mockResolvedValue([row]);
    const response = await GETStock(new Request("http://localhost/api/operator/stock"));
    expect((await response.json()).stock).toEqual([row]);
    expect(m.list).toHaveBeenCalledWith(expect.objectContaining({
      where: { restaurantId: current.restaurantId, trackInventory: true },
      select: expect.objectContaining({ barcode: true, barcodes: { where: { restaurantId: current.restaurantId }, select: { barcode: true }, orderBy: { barcode: "asc" } } }),
    }));
  });
});
