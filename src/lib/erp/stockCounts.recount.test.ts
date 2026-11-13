import { Prisma } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

// El conteo definitivo solo pide recontar lo que lo necesita: lo que cuadró
// en el preliminar y no se movió queda confirmado (se arrastra su conteo).
type Item = { id: string; ingredientId: string; expectedQty: number; countedQty: number | null; countedParts: number[]; preliminaryQty: number | null; preliminaryParts: number[]; finalExpectedQty: number | null; ingredient: { id: string; trackInventory: boolean } };
type Count = { id: string; restaurantId: string; status: string; revision: number; createdAt: Date; preliminaryAt: Date | null; recountStartedAt: Date | null; recountSnapshot: unknown; finalReview: unknown; items: Item[] };
type Ingredient = { id: string; trackInventory: boolean; measureKind: string; stockLevel: { qtyBase: number; totalValueCents: number } | null };
type Movement = { ingredientId: string; createdAt: Date };

const m = vi.hoisted(() => ({
  count: null! as Count,
  ingredients: [] as Ingredient[],
  movements: [] as Movement[],
  movedQuery: [] as unknown[],
  apply: vi.fn(),
  lock: vi.fn(),
}));
vi.mock("@/lib/orderLock", () => ({ lockStock: m.lock }));
vi.mock("@/lib/erp/stock", () => ({ applyStockMovement: m.apply }));
vi.mock("@/lib/db", () => {
  const tx = {
    stockCount: {
      findFirst: vi.fn(async ({ where }: { where: { id: string; restaurantId: string } }) => m.count?.id === where.id && m.count?.restaurantId === where.restaurantId ? structuredClone(m.count) : null),
      update: vi.fn(async ({ data }: { data: Partial<Count> }) => { Object.assign(m.count, data, data.finalReview === Prisma.DbNull ? { finalReview: null } : {}); return m.count; }),
      findUniqueOrThrow: vi.fn(async () => structuredClone(m.count)),
      delete: vi.fn(),
    },
    stockCountItem: { update: vi.fn(async ({ where, data }: { where: { id: string }; data: Partial<Item> }) => { Object.assign(m.count.items.find((item) => item.id === where.id)!, data); }) },
    ingredient: { findMany: vi.fn(async () => structuredClone(m.ingredients)) },
    stockMovement: {
      count: vi.fn(async () => m.movements.length),
      findMany: vi.fn(async (args: { where: { ingredientId: { in: string[] }; createdAt: { gte: Date } } }) => {
        m.movedQuery.push(args);
        const ids = new Set(m.movements.filter((movement) => args.where.ingredientId.in.includes(movement.ingredientId) && movement.createdAt >= args.where.createdAt.gte).map((movement) => movement.ingredientId));
        return [...ids].map((ingredientId) => ({ ingredientId }));
      }),
    },
  };
  return { db: { $transaction: (callback: (client: unknown) => unknown) => callback(tx) } };
});

import { mutateStockCount } from "./stockCounts";
import { parseRecountPlan } from "./recountPlan";

const R = "restaurant";
const OPENED = new Date("2026-11-10T08:00:00.000Z");
const item = (id: string, expectedQty: number, countedQty: number | null, parts?: number[], trackInventory = true): Item => ({
  id: `item-${id}`, ingredientId: id, expectedQty, countedQty, countedParts: parts ?? (countedQty === null ? [] : [countedQty]),
  preliminaryQty: null, preliminaryParts: [], finalExpectedQty: null, ingredient: { id, trackInventory },
});
const level = (id: string, qtyBase: number, trackInventory = true): Ingredient => ({ id, trackInventory, measureKind: "count", stockLevel: { qtyBase, totalValueCents: qtyBase * 2 } });
const of = (id: string) => m.count.items.find((entry) => entry.ingredientId === id)!;
const stock = (id: string) => m.ingredients.find((entry) => entry.id === id)!.stockLevel!;
const mutate = (action: Parameters<typeof mutateStockCount>[2], extra: Record<string, unknown> = {}) => mutateStockCount(R, "count", action, { revision: m.count.revision, ...extra });
const save = (quantities: Record<string, number>) => mutate("save", { items: Object.entries(quantities).map(([id, countedQty]) => ({ itemId: `item-${id}`, countedQty })) });
const plan = () => parseRecountPlan(m.count.recountSnapshot)!;

beforeEach(() => {
  vi.clearAllMocks();
  m.movedQuery = [];
  m.movements = [{ ingredientId: "equal", createdAt: new Date("2026-11-09T12:00:00.000Z") }]; // anterior al conteo: no cuenta
  m.ingredients = [level("equal", 10_000), level("parts", 20_000), level("short", 10_000), level("blank", 5000), level("sold", 8000), level("swapped", 6000), level("service", 0, false)];
  m.count = {
    id: "count", restaurantId: R, status: "draft", revision: 0, createdAt: OPENED,
    preliminaryAt: null, recountStartedAt: null, recountSnapshot: null, finalReview: null,
    items: [
      item("equal", 10_000, 10_000),              // cuadró y no se movió → confirmado
      item("parts", 20_000, 20_000, [12_000, 3000, 5000]), // cuadró en tres cantidades → confirmado con sus partes
      item("short", 10_000, 9000),                // faltante en el preliminar → recontar
      item("blank", 5000, null),                  // sin contar → recontar
      item("sold", 8000, 8000),                   // cuadró, pero después se vendió → recontar
      item("swapped", 6000, 6000),                // cuadró y el saldo es igual, pero hubo venta + compra → recontar
      item("service", 0, null, undefined, false), // no inventariable: no participa
    ],
  };
});

/** Preliminar y, antes de iniciar el definitivo, los movimientos del día. */
async function startRecount(extra: Record<string, unknown> = {}) {
  await mutate("preliminary");
  stock("sold").qtyBase = 7000;
  m.movements.push({ ingredientId: "sold", createdAt: new Date("2026-11-10T09:00:00.000Z") });
  m.movements.push({ ingredientId: "swapped", createdAt: new Date("2026-11-10T09:30:00.000Z") }, { ingredientId: "swapped", createdAt: new Date("2026-11-10T09:45:00.000Z") });
  return mutate("recount", extra);
}

describe("iniciar el conteo definitivo", () => {
  it("arrastra como confirmado solo lo que cuadró en el preliminar y no se movió; el resto arranca vacío", async () => {
    await startRecount();
    expect(of("equal")).toMatchObject({ countedQty: 10_000, countedParts: [10_000], finalExpectedQty: 10_000, preliminaryQty: 10_000 });
    expect(of("parts")).toMatchObject({ countedQty: 20_000, countedParts: [12_000, 3000, 5000], finalExpectedQty: 20_000 });
    for (const id of ["short", "blank", "sold", "swapped", "service"]) expect(of(id), id).toMatchObject({ countedQty: null, countedParts: [] });
    // El teórico del definitivo sigue siendo la existencia al iniciarlo.
    expect(of("sold").finalExpectedQty).toBe(7000);
    expect(of("swapped").finalExpectedQty).toBe(6000);
    // El primer conteo se conserva intacto para todos.
    expect(of("short")).toMatchObject({ preliminaryQty: 9000 });
    expect(of("sold")).toMatchObject({ preliminaryQty: 8000 });
  });

  it("guarda por qué hay que recontar cada insumo (puede haber más de un motivo)", async () => {
    await startRecount();
    expect(plan()).toEqual({
      full: false,
      reasons: { short: ["difference"], blank: ["uncounted"], sold: ["moved"], swapped: ["moved"] },
    });
    // Faltante en el preliminar Y vendido después: los dos motivos.
    await mutate("recount");
    stock("short").qtyBase = 9500;
    m.movements.push({ ingredientId: "short", createdAt: new Date("2026-11-10T10:00:00.000Z") });
    await mutate("recount");
    expect(plan().reasons.short).toEqual(["difference", "moved"]);
  });

  it("pregunta por los movimientos de ESTE conteo, desde que se abrió e incluyendo el mismo instante", async () => {
    await startRecount();
    expect(m.movedQuery).toHaveLength(1);
    expect(m.movedQuery[0]).toEqual({
      where: { restaurantId: R, ingredientId: { in: ["equal", "parts", "short", "blank", "sold", "swapped", "service"] }, createdAt: { gte: OPENED } },
      select: { ingredientId: true }, distinct: ["ingredientId"],
    });
  });

  it("un movimiento en el mismo instante en que se abrió el conteo pide recontar (nunca se confirma de más)", async () => {
    await mutate("preliminary");
    m.movements.push({ ingredientId: "equal", createdAt: OPENED });
    await mutate("recount");
    expect(of("equal").countedQty).toBeNull();
    expect(plan().reasons.equal).toEqual(["moved"]);
  });

  it("un saldo distinto pide recontar aunque no se encuentre el movimiento", async () => {
    await mutate("preliminary");
    stock("equal").qtyBase = 9999;
    await mutate("recount");
    expect(of("equal")).toMatchObject({ countedQty: null, finalExpectedQty: 9999 });
    expect(plan().reasons.equal).toEqual(["moved"]);
  });

  it("«Recontar todo» deja todo vacío, como antes, y conserva los motivos", async () => {
    await startRecount({ full: true });
    for (const entry of m.count.items) expect(entry, entry.id).toMatchObject({ countedQty: null, countedParts: [] });
    expect(of("equal").finalExpectedQty).toBe(10_000);
    expect(plan()).toEqual({ full: true, reasons: { short: ["difference"], blank: ["uncounted"], sold: ["moved"], swapped: ["moved"] } });
    // Ahora sí hay que contar todo.
    await save({ short: 9000, blank: 5000, sold: 7000, swapped: 6000 });
    await expect(mutate("review")).rejects.toMatchObject({ code: "incomplete_count" });
  });

  it("volver a iniciarlo aplica la regla de nuevo: lo confirmado sigue confirmado y lo recontado se vacía", async () => {
    await startRecount();
    await save({ short: 9500, blank: 5000 });
    await mutate("recount");
    expect(of("equal").countedQty).toBe(10_000);
    expect(of("short").countedQty).toBeNull();
    expect(of("blank").countedQty).toBeNull();
  });
});

describe("revisión y cierre con insumos confirmados", () => {
  it("solo falta recontar lo pendiente; lo confirmado ya cuenta como contado", async () => {
    await startRecount();
    await save({ short: 9500, blank: 5000, sold: 7000 });
    await expect(mutate("review")).rejects.toMatchObject({ code: "incomplete_count" });
    await save({ swapped: 6000 });
    await mutate("review");
    expect((m.count.finalReview as { counted: number; differences: number })).toMatchObject({ counted: 6, differences: 1 });
  });

  it("al cerrar, lo confirmado no genera ajuste (contado = esperado = saldo) y solo se ajusta la diferencia real", async () => {
    await startRecount();
    await save({ short: 9500, blank: 5000, sold: 7000, swapped: 6000 });
    await mutate("review");
    const result = await mutate("close", { reviewToken: (m.count.finalReview as { token: string }).token });
    if (!("count" in result)) throw new Error("expected count");
    expect(result.adjustments).toBe(1);
    expect(m.apply).toHaveBeenCalledTimes(1);
    expect(m.apply).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ ingredientId: "short", kind: "count_adjust", qtyBase: -500 }), { allowInactive: true });
    expect(result.count.status).toBe("closed");
  });

  it("un insumo confirmado se puede corregir: se recuenta como cualquier otro", async () => {
    await startRecount();
    await save({ equal: 9800, short: 10_000, blank: 5000, sold: 7000, swapped: 6000 });
    await mutate("review");
    await mutate("close", { reviewToken: (m.count.finalReview as { token: string }).token });
    expect(m.apply).toHaveBeenCalledTimes(1);
    expect(m.apply.mock.calls[0][1]).toMatchObject({ ingredientId: "equal", qtyBase: -200 });
  });

  it("si el inventario de un insumo CONFIRMADO cambia después de iniciar el definitivo, el cierre se niega", async () => {
    await startRecount();
    await save({ short: 9500, blank: 5000, sold: 7000, swapped: 6000 });
    await mutate("review");
    stock("equal").qtyBase = 9000;
    m.movements.push({ ingredientId: "equal", createdAt: new Date("2026-11-10T11:00:00.000Z") });
    await expect(mutate("close", { reviewToken: (m.count.finalReview as { token: string }).token })).rejects.toMatchObject({ code: "stock_changed" });
    expect(m.apply).not.toHaveBeenCalled();
    // Reiniciar el definitivo ya no lo confirma: se movió.
    await mutate("recount");
    expect(of("equal").countedQty).toBeNull();
    expect(plan().reasons.equal).toEqual(["moved"]);
  });

  it("si todo cuadró y nada se movió, el definitivo queda listo para revisar sin recontar nada", async () => {
    m.count.items = [item("equal", 10_000, 10_000), item("parts", 20_000, 20_000, [12_000, 8000])];
    m.ingredients = [level("equal", 10_000), level("parts", 20_000)];
    await mutate("preliminary");
    await mutate("recount");
    expect(plan()).toEqual({ full: false, reasons: {} });
    await mutate("review");
    const result = await mutate("close", { reviewToken: (m.count.finalReview as { token: string }).token });
    if (!("count" in result)) throw new Error("expected count");
    expect(result.adjustments).toBe(0);
    expect(m.apply).not.toHaveBeenCalled();
  });
});
