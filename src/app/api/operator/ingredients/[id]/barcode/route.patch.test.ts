import { Prisma } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

// PATCH /api/operator/ingredients/[id]/barcode — corregir un código: cambiar
// su valor en el mismo insumo (`newBarcode`) o pasárselo a otro (`moveTo`).
const m = vi.hoisted(() => ({
  auth: vi.fn(), activeRestaurant: vi.fn(), restaurant: vi.fn(),
  find: vi.fn(), read: vi.fn(), primaryUpdate: vi.fn(),
  codeFind: vi.fn(), codeFirst: vi.fn(), codeCreate: vi.fn(), codeDelete: vi.fn(), codeUpdate: vi.fn(),
  ownerFind: vi.fn(), transaction: vi.fn(), lock: vi.fn(), audit: vi.fn(),
  events: [] as string[],
}));
vi.mock("@/lib/secureApi", () => ({ secureApi: (handler: unknown) => handler }));
vi.mock("@/auth", () => ({ auth: m.auth }));
vi.mock("@/lib/activeRestaurant", () => ({ getActiveRestaurantId: m.activeRestaurant }));
vi.mock("@/lib/orderLock", () => ({ lockStock: m.lock }));
vi.mock("@/lib/auditLog", () => ({ recordAuditEvent: m.audit }));
vi.mock("@/lib/db", () => ({ db: { restaurant: { findUnique: m.restaurant }, $transaction: m.transaction, ingredientBarcode: { findUnique: m.ownerFind } } }));

import { PATCH } from "./route";

const R = "restaurant-1";
type Row = { id: string; name: string; barcode: string | null; active: boolean; trackInventory: boolean };
const milk: Row = { id: "milk", name: "Leche", barcode: "PRIMARY", active: true, trackInventory: true };
const oat: Row = { id: "oat", name: "Bebida de avena", barcode: "OAT-1", active: true, trackInventory: true };
let rows: Record<string, Row>;
/** Código → insumo que lo tiene (registro canónico). */
let registry: Record<string, string>;

const tx = {
  ingredient: { findFirst: m.find, findUniqueOrThrow: m.read, updateMany: m.primaryUpdate },
  ingredientBarcode: { findUnique: m.codeFind, findFirst: m.codeFirst, create: m.codeCreate, deleteMany: m.codeDelete, updateMany: m.codeUpdate },
};
const call = (body: unknown, id = "milk") => PATCH(
  new Request(`http://localhost/api/operator/ingredients/${id}/barcode`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  { params: Promise.resolve({ id }) },
);
const registryOf = (id: string) => ({
  id, barcode: rows[id].barcode,
  barcodes: Object.entries(registry).filter(([, owner]) => owner === id).map(([barcode]) => ({ barcode })).sort((a, b) => a.barcode.localeCompare(b.barcode)),
});

beforeEach(() => {
  vi.resetAllMocks();
  m.events = [];
  rows = { milk: { ...milk }, oat: { ...oat } };
  registry = { PRIMARY: "milk", "ALIAS-2": "milk", "OAT-1": "oat" };
  m.auth.mockResolvedValue({ user: { id: "operator-1", role: "operator" } });
  m.activeRestaurant.mockResolvedValue(R);
  m.restaurant.mockResolvedValue({ enabledModules: ["inventory"], country: "CO" });
  m.lock.mockImplementation(async () => { m.events.push("lock"); });
  // La transacción simulada deshace lo escrito si el callback lanza.
  m.transaction.mockImplementation(async (callback: (client: typeof tx) => unknown) => {
    const before = { rows: structuredClone(rows), registry: { ...registry } };
    try { return await callback(tx); } catch (error) { rows = before.rows; registry = before.registry; throw error; }
  });
  m.find.mockImplementation(async ({ where }: { where: { id: string; restaurantId: string } }) => {
    m.events.push(`find:${where.id}`);
    return where.restaurantId === R && rows[where.id] ? { ...rows[where.id] } : null;
  });
  m.read.mockImplementation(async ({ where }: { where: { id: string } }) => registryOf(where.id));
  m.codeFind.mockImplementation(async ({ where }: { where: { restaurantId_barcode: { barcode: string } } }) => {
    const owner = registry[where.restaurantId_barcode.barcode];
    return owner ? { ingredientId: owner } : null;
  });
  m.codeFirst.mockImplementation(async ({ where }: { where: { ingredientId: string; barcode: { not: string } } }) => {
    const next = Object.entries(registry).filter(([code, owner]) => owner === where.ingredientId && code !== where.barcode.not).map(([code]) => code).sort()[0];
    return next ? { barcode: next } : null;
  });
  // `Ingredient.barcode` + trigger: suelta el valor viejo y asegura el nuevo.
  m.primaryUpdate.mockImplementation(async ({ where, data }: { where: { id: string; barcode: string | null }; data: { barcode: string | null } }) => {
    const row = rows[where.id];
    if (!row || row.barcode !== where.barcode) return { count: 0 };
    if (data.barcode && registry[data.barcode] && registry[data.barcode] !== where.id) {
      throw new Prisma.PrismaClientKnownRequestError("duplicate", { code: "P2002", clientVersion: "6" });
    }
    if (row.barcode) delete registry[row.barcode];
    row.barcode = data.barcode;
    if (data.barcode) registry[data.barcode] = where.id;
    m.events.push(`primary:${where.id}=${data.barcode}`);
    return { count: 1 };
  });
  m.codeDelete.mockImplementation(async ({ where }: { where: { ingredientId: string; barcode: string } }) => {
    if (registry[where.barcode] !== where.ingredientId) return { count: 0 };
    delete registry[where.barcode];
    m.events.push(`delete:${where.barcode}`);
    return { count: 1 };
  });
  m.codeCreate.mockImplementation(async ({ data }: { data: { ingredientId: string; barcode: string } }) => {
    if (registry[data.barcode]) throw new Prisma.PrismaClientKnownRequestError("duplicate", { code: "P2002", clientVersion: "6" });
    registry[data.barcode] = data.ingredientId;
    m.events.push(`create:${data.barcode}@${data.ingredientId}`);
    return { id: "new" };
  });
  m.codeUpdate.mockImplementation(async ({ where, data }: { where: { ingredientId: string; barcode: string }; data: { barcode: string } }) => {
    if (registry[where.barcode] !== where.ingredientId) return { count: 0 };
    delete registry[where.barcode];
    registry[data.barcode] = where.ingredientId;
    m.events.push(`rename:${where.barcode}>${data.barcode}`);
    return { count: 1 };
  });
  m.ownerFind.mockImplementation(async ({ where }: { where: { restaurantId_barcode: { barcode: string } } }) => {
    const owner = registry[where.restaurantId_barcode.barcode];
    return owner ? { ingredient: { id: owner, name: rows[owner].name, active: rows[owner].active } } : null;
  });
});

describe("autorización y validación", () => {
  it.each([null, "mesero", "kitchen", "bar", "terminal", "diner"])("rechaza el rol %s antes de escribir", async (role) => {
    m.auth.mockResolvedValue(role ? { user: { role } } : null);
    const response = await call({ barcode: "ALIAS-2", moveTo: "oat" });
    expect(response.status).toBe(401);
    expect(m.transaction).not.toHaveBeenCalled();
  });

  it.each(["operator", "platform_admin", "group_admin"])("permite a %s con el módulo de inventario", async (role) => {
    m.auth.mockResolvedValue({ user: { id: "u", role } });
    expect((await call({ barcode: "ALIAS-2", newBarcode: "ALIAS-3" })).status).toBe(200);
  });

  it("exige el módulo de inventario y un comercio activo", async () => {
    m.restaurant.mockResolvedValue({ enabledModules: ["recipes"], country: "CO" });
    expect((await call({ barcode: "ALIAS-2", moveTo: "oat" })).status).toBe(403);
    m.activeRestaurant.mockResolvedValue(null);
    expect((await call({ barcode: "ALIAS-2", moveTo: "oat" })).status).toBe(400);
    expect(m.transaction).not.toHaveBeenCalled();
  });

  it.each([
    null, {}, { barcode: "ALIAS-2" }, { newBarcode: "X" }, { moveTo: "oat" },
    { barcode: "ALIAS-2", newBarcode: "X", moveTo: "oat" },
    { barcode: "", newBarcode: "X" }, { barcode: "ALIAS-2", newBarcode: " \t" }, { barcode: "ALIAS-2", newBarcode: 7 },
    { barcode: "ALIAS-2", newBarcode: "x".repeat(65) }, { barcode: "ALIAS-2", moveTo: "" },
    { barcode: "ALIAS-2", moveTo: "milk" }, { barcode: "ALIAS-2", moveTo: "oat", restaurantId: "other" },
  ])("rechaza cuerpos mal formados: %j", async (body) => {
    const response = await call(body);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid" });
    expect(m.transaction).not.toHaveBeenCalled();
  });

  it("no revela insumos de otro comercio (origen ni destino)", async () => {
    expect((await call({ barcode: "ALIAS-2", newBarcode: "X" }, "ghost")).status).toBe(404);
    const response = await call({ barcode: "ALIAS-2", moveTo: "ghost" });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "target_not_found" });
    expect(registry).toEqual({ PRIMARY: "milk", "ALIAS-2": "milk", "OAT-1": "oat" });
    expect(m.audit).not.toHaveBeenCalled();
  });
});

describe("editar el valor de un código", () => {
  it("cambia un código adicional bajo el lock de stock, conserva el principal y audita", async () => {
    const response = await call({ barcode: " ALIAS-2\r\n", newBarcode: " ALIAS 3\t" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ingredient: { id: "milk", barcode: "PRIMARY", barcodes: [{ barcode: "ALIAS3" }, { barcode: "PRIMARY" }] } });
    expect(m.events.slice(0, 2)).toEqual(["lock", "find:milk"]);
    expect(m.codeUpdate).toHaveBeenCalledWith({ where: { restaurantId: R, ingredientId: "milk", barcode: "ALIAS-2" }, data: { barcode: "ALIAS3" } });
    expect(m.primaryUpdate).not.toHaveBeenCalled();
    expect(m.audit).toHaveBeenCalledWith({
      kind: "ingredient.barcode.replace", restaurantId: R,
      target: { type: "ingredient", id: "milk" }, summary: "Leche",
      diff: { before: { barcode: "ALIAS-2" }, after: { barcode: "ALIAS3" } },
    });
  });

  it("si era el principal, el valor nuevo sigue siendo el principal", async () => {
    const response = await call({ barcode: "PRIMARY", newBarcode: "PRIMARY-OK" });
    expect(response.status).toBe(200);
    expect((await response.json()).ingredient).toEqual({ id: "milk", barcode: "PRIMARY-OK", barcodes: [{ barcode: "ALIAS-2" }, { barcode: "PRIMARY-OK" }] });
    expect(m.primaryUpdate).toHaveBeenCalledWith({ where: { id: "milk", restaurantId: R, barcode: "PRIMARY" }, data: { barcode: "PRIMARY-OK" } });
    expect(registry).toEqual({ "PRIMARY-OK": "milk", "ALIAS-2": "milk", "OAT-1": "oat" });
  });

  it("si el valor nuevo ya era otro código del mismo insumo, solo desaparece el viejo", async () => {
    const response = await call({ barcode: "ALIAS-2", newBarcode: "PRIMARY" });
    expect(response.status).toBe(200);
    expect((await response.json()).ingredient).toEqual({ id: "milk", barcode: "PRIMARY", barcodes: [{ barcode: "PRIMARY" }] });
    expect(m.codeDelete).toHaveBeenCalledWith({ where: { restaurantId: R, ingredientId: "milk", barcode: "ALIAS-2" } });
    expect(m.codeUpdate).not.toHaveBeenCalled();
  });

  it("guardar el mismo valor no escribe ni audita", async () => {
    const response = await call({ barcode: "ALIAS-2", newBarcode: " ALIAS-2 " });
    expect(response.status).toBe(200);
    expect(m.codeUpdate).not.toHaveBeenCalled();
    expect(m.primaryUpdate).not.toHaveBeenCalled();
    expect(m.audit).not.toHaveBeenCalled();
  });

  it("no pisa el código de otro insumo: dice quién lo tiene", async () => {
    rows.oat.active = false;
    const response = await call({ barcode: "ALIAS-2", newBarcode: "OAT-1" });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "barcode_taken", owner: { id: "oat", name: "Bebida de avena", active: false } });
    expect(registry).toEqual({ PRIMARY: "milk", "ALIAS-2": "milk", "OAT-1": "oat" });
    expect(m.audit).not.toHaveBeenCalled();
  });

  it("no edita un código que el insumo no tiene", async () => {
    for (const barcode of ["OAT-1", "NOPE"]) {
      const response = await call({ barcode, newBarcode: "X" });
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: "barcode_not_found" });
    }
    expect(m.codeUpdate).not.toHaveBeenCalled();
    expect(m.audit).not.toHaveBeenCalled();
  });

  it.each([
    [{ active: false }, "ingredient_inactive"],
    [{ trackInventory: false }, "ingredient_not_tracked"],
  ])("un valor nuevo exige lo mismo que un alta: %j", async (change, error) => {
    Object.assign(rows.milk, change);
    const response = await call({ barcode: "ALIAS-2", newBarcode: "X" });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error });
    expect(m.audit).not.toHaveBeenCalled();
  });

  it("una carrera con otro escritor del principal se informa como código ocupado", async () => {
    m.primaryUpdate.mockRejectedValueOnce(new Prisma.PrismaClientKnownRequestError("duplicate", { code: "P2002", clientVersion: "6" }));
    const response = await call({ barcode: "PRIMARY", newBarcode: "RACE" });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "barcode_taken", owner: null });
    expect(m.audit).not.toHaveBeenCalled();
  });

  it("si el registro cambió por fuera del lock, no deja nada a medias", async () => {
    m.codeUpdate.mockResolvedValueOnce({ count: 0 });
    const response = await call({ barcode: "ALIAS-2", newBarcode: "X" });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "operation_conflict" });
    expect(m.audit).not.toHaveBeenCalled();
  });
});

describe("pasar un código a otro insumo", () => {
  it("pasa un código adicional: queda solo en el destino y se auditan origen y destino", async () => {
    const response = await call({ barcode: "ALIAS-2", moveTo: "oat" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ingredient: { id: "milk", barcode: "PRIMARY", barcodes: [{ barcode: "PRIMARY" }] },
      target: { id: "oat", barcode: "OAT-1", barcodes: [{ barcode: "ALIAS-2" }, { barcode: "OAT-1" }] },
    });
    // Lock primero; se suelta del origen antes de crearlo en el destino.
    expect(m.events).toEqual(["lock", "find:milk", "find:oat", "delete:ALIAS-2", "create:ALIAS-2@oat"]);
    expect(registry["ALIAS-2"]).toBe("oat");
    expect(m.audit).toHaveBeenCalledWith({
      kind: "ingredient.barcode.move", restaurantId: R,
      target: { type: "ingredient", id: "oat" }, summary: "Leche → Bebida de avena",
      diff: {
        before: { barcode: "ALIAS-2", ingredientId: "milk", ingredient: "Leche" },
        after: { barcode: "ALIAS-2", ingredientId: "oat", ingredient: "Bebida de avena" },
      },
    });
  });

  it("si era el principal del origen, asciende el más antiguo que le queda", async () => {
    const response = await call({ barcode: "PRIMARY", moveTo: "oat" });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ingredient).toEqual({ id: "milk", barcode: "ALIAS-2", barcodes: [{ barcode: "ALIAS-2" }] });
    expect(body.target.barcodes).toEqual([{ barcode: "OAT-1" }, { barcode: "PRIMARY" }]);
    expect(m.codeFirst).toHaveBeenCalledWith({
      where: { restaurantId: R, ingredientId: "milk", barcode: { not: "PRIMARY" } },
      orderBy: [{ createdAt: "asc" }, { barcode: "asc" }], select: { barcode: true },
    });
    expect(m.audit).toHaveBeenCalledWith(expect.objectContaining({
      diff: expect.objectContaining({ after: expect.objectContaining({ sourcePrimary: "ALIAS-2" }) }),
    }));
  });

  it("si era el único código del origen, el origen queda sin principal", async () => {
    delete registry["ALIAS-2"];
    const response = await call({ barcode: "PRIMARY", moveTo: "oat" });
    expect((await response.json()).ingredient).toEqual({ id: "milk", barcode: null, barcodes: [] });
    expect(m.audit).toHaveBeenCalledWith(expect.objectContaining({
      diff: expect.objectContaining({ after: expect.objectContaining({ sourcePrimary: null }) }),
    }));
  });

  it("si el destino no tenía códigos, el que llega queda como su principal", async () => {
    rows.oat.barcode = null;
    delete registry["OAT-1"];
    const response = await call({ barcode: "ALIAS-2", moveTo: "oat" });
    expect((await response.json()).target).toEqual({ id: "oat", barcode: "ALIAS-2", barcodes: [{ barcode: "ALIAS-2" }] });
    expect(m.primaryUpdate).toHaveBeenCalledWith({
      where: { id: "oat", restaurantId: R, barcode: null, active: true, trackInventory: true }, data: { barcode: "ALIAS-2" },
    });
    expect(m.codeCreate).not.toHaveBeenCalled();
  });

  it("libera el código de un insumo archivado o que ya no lleva inventario (el caso del conteo)", async () => {
    Object.assign(rows.milk, { active: false, trackInventory: false });
    const response = await call({ barcode: "PRIMARY", moveTo: "oat" });
    expect(response.status).toBe(200);
    expect(registry.PRIMARY).toBe("oat");
  });

  it.each([
    [{ active: false }, "ingredient_inactive"],
    [{ trackInventory: false }, "ingredient_not_tracked"],
  ])("el destino debe estar activo y llevar inventario: %j", async (change, error) => {
    Object.assign(rows.oat, change);
    const response = await call({ barcode: "ALIAS-2", moveTo: "oat" });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error });
    expect(registry["ALIAS-2"]).toBe("milk");
    expect(m.codeDelete).not.toHaveBeenCalled();
    expect(m.audit).not.toHaveBeenCalled();
  });

  it("no pasa un código que el origen no tiene (dato viejo en pantalla)", async () => {
    for (const barcode of ["OAT-1", "NOPE"]) {
      const response = await call({ barcode, moveTo: "oat" });
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: "barcode_not_found" });
    }
    expect(m.codeCreate).not.toHaveBeenCalled();
    expect(m.audit).not.toHaveBeenCalled();
  });

  it("si no se puede dejar en el destino, se deshace el haberlo soltado: el código nunca queda sin dueño", async () => {
    m.codeCreate.mockRejectedValueOnce(new Prisma.PrismaClientKnownRequestError("duplicate", { code: "P2002", clientVersion: "6" }));
    const response = await call({ barcode: "ALIAS-2", moveTo: "oat" });
    expect(response.status).toBe(409);
    expect((await response.json()).error).toBe("barcode_taken");
    expect(registry).toEqual({ PRIMARY: "milk", "ALIAS-2": "milk", "OAT-1": "oat" });
    expect(m.audit).not.toHaveBeenCalled();
  });

  it("si el destino recibió un principal por fuera del lock, aborta y deshace", async () => {
    rows.oat.barcode = null;
    delete registry["OAT-1"];
    const real = m.primaryUpdate.getMockImplementation()!;
    m.primaryUpdate.mockImplementation(async (args: { where: { id: string; barcode: string | null }; data: { barcode: string | null } }) => (args.where.id === "oat" ? { count: 0 } : real(args)));
    const response = await call({ barcode: "PRIMARY", moveTo: "oat" });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "operation_conflict" });
    expect(rows.milk.barcode).toBe("PRIMARY");
    expect(registry.PRIMARY).toBe("milk");
    expect(m.audit).not.toHaveBeenCalled();
  });

  it("no disfraza un error de almacenamiento como código ocupado", async () => {
    const failure = new Error("storage unavailable");
    m.codeCreate.mockRejectedValueOnce(failure);
    await expect(call({ barcode: "ALIAS-2", moveTo: "oat" })).rejects.toBe(failure);
    expect(registry["ALIAS-2"]).toBe("milk");
    expect(m.audit).not.toHaveBeenCalled();
  });
});
