import { beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";

/**
 * `db` falso: cualquier delegate devuelve [] salvo los que el test carga en
 * `rows`. Así takeSnapshot recorre los ~70 modelos reales sin base.
 */
const mocks = vi.hoisted(() => {
  const rows: Record<string, Record<string, unknown>[]> = {};
  const calls: Record<string, unknown[]> = {};
  const delegateFor = (name: string) => ({
    findMany: vi.fn(async (args: { skip?: number; take?: number }) => {
      (calls[name] ??= []).push(args);
      const all = rows[name] ?? [];
      return all.slice(args.skip ?? 0, (args.skip ?? 0) + (args.take ?? all.length));
    }),
  });
  const restaurant = { findUnique: vi.fn() };
  const db = new Proxy(
    {},
    {
      get(_target, prop: string) {
        if (prop === "restaurant") return restaurant;
        return delegateFor(prop);
      },
    },
  );
  return { rows, calls, restaurant, db };
});
vi.mock("@/lib/db", () => ({ db: mocks.db }));
import { BackupError } from "./errors";
import { deserializeRow, serializeRow } from "./serialize";
import { BATCH_SIZE, takeSnapshot, totalRows } from "./snapshot";
import { restaurantFields, tenantModel } from "./tables";

const restaurantRow = {
  id: "r1",
  slug: "fixture",
  name: "Fixture",
  createdAt: new Date("2026-01-02T03:04:05.000Z"),
  updatedAt: new Date("2026-01-02T03:04:05.000Z"),
  plan: "trial",
  barSubStations: ["Cocteles"],
  menuTags: null,
  invoiceNextNumber: 7,
};

beforeEach(() => {
  vi.clearAllMocks();
  for (const k of Object.keys(mocks.rows)) delete mocks.rows[k];
  for (const k of Object.keys(mocks.calls)) delete mocks.calls[k];
  mocks.restaurant.findUnique.mockResolvedValue(restaurantRow);
});

describe("takeSnapshot", () => {
  it("fails closed when the restaurant does not exist", async () => {
    mocks.restaurant.findUnique.mockResolvedValue(null);
    await expect(takeSnapshot("missing")).rejects.toBeInstanceOf(BackupError);
  });
  it("serializes dates to ISO, keeps json as is and counts every table", async () => {
    mocks.rows.order = [
      {
        id: "o1",
        restaurantId: "r1",
        tableId: "t1",
        status: "open",
        shortCode: "ABC",
        createdAt: new Date("2026-09-18T10:00:00.000Z"),
        paidAt: null,
        subtotalCents: 1000,
      },
    ];
    mocks.rows.orderItem = [
      { id: "i1", orderId: "o1", qty: 2, modifierSelections: { extra: ["queso"] }, servedAt: null },
    ];
    const snapshot = await takeSnapshot("r1");
    expect(snapshot.data.version).toBe(1);
    expect(snapshot.data.restaurantId).toBe("r1");
    expect(snapshot.data.restaurant.createdAt).toBe("2026-01-02T03:04:05.000Z");
    expect(snapshot.data.restaurant.barSubStations).toEqual(["Cocteles"]);
    expect(snapshot.data.tables.Order[0].createdAt).toBe("2026-09-18T10:00:00.000Z");
    expect(snapshot.data.tables.Order[0].paidAt).toBeNull();
    expect(snapshot.data.tables.OrderItem[0].modifierSelections).toEqual({ extra: ["queso"] });
    expect(snapshot.tableCounts.Order).toBe(1);
    expect(snapshot.tableCounts.OrderItem).toBe(1);
    expect(snapshot.tableCounts.MenuItem).toBe(0);
    expect(Object.keys(snapshot.data.tables)).toContain("JournalLine");
    expect(totalRows(snapshot.tableCounts)).toBe(2);
    expect(snapshot.sizeBytes).toBe(Buffer.byteLength(JSON.stringify(snapshot.data)));
    // Los hijos se leen por la relación al dueño, no por un restaurantId que no tienen.
    expect(mocks.calls.orderItem[0]).toMatchObject({ where: { order: { restaurantId: "r1" } } });
    expect(mocks.calls.order[0]).toMatchObject({ where: { restaurantId: "r1" }, orderBy: { id: "asc" } });
  });
  it("reads big tables in batches", async () => {
    mocks.rows.menuItem = Array.from({ length: BATCH_SIZE + 3 }, (_, i) => ({ id: `m${i}`, restaurantId: "r1" }));
    const snapshot = await takeSnapshot("r1");
    expect(snapshot.tableCounts.MenuItem).toBe(BATCH_SIZE + 3);
    expect(mocks.calls.menuItem.map((c) => (c as { skip: number }).skip)).toEqual([0, BATCH_SIZE]);
    expect(mocks.calls.menuItem.every((c) => (c as { take: number }).take === BATCH_SIZE)).toBe(true);
  });
});

describe("row serialization", () => {
  const fields = [
    { name: "id", kind: "scalar", type: "String", isList: false, isRequired: true },
    { name: "when", kind: "scalar", type: "DateTime", isList: false, isRequired: false },
    { name: "amount", kind: "scalar", type: "Decimal", isList: false, isRequired: true },
    { name: "big", kind: "scalar", type: "BigInt", isList: false, isRequired: true },
    { name: "blob", kind: "scalar", type: "Bytes", isList: false, isRequired: false },
    { name: "meta", kind: "scalar", type: "Json", isList: false, isRequired: false },
    { name: "payload", kind: "scalar", type: "Json", isList: false, isRequired: true },
    { name: "tags", kind: "scalar", type: "String", isList: true, isRequired: true },
    { name: "kind", kind: "enum", type: "Kind", isList: false, isRequired: true },
    { name: "relation", kind: "object", type: "Other", isList: false, isRequired: true },
  ] as unknown as ReturnType<typeof restaurantFields>;
  it("round-trips every scalar type through JSON", () => {
    const row = {
      id: "x",
      when: new Date("2026-09-18T10:00:00.000Z"),
      amount: new Prisma.Decimal("12.50"),
      big: BigInt("9007199254740993"),
      blob: new Uint8Array([1, 2, 255]),
      meta: { a: 1 },
      payload: [1, 2],
      tags: ["a", "b"],
      kind: "manual",
      relation: { ignored: true },
      unknownColumn: "dropped",
    };
    const json = serializeRow(fields, row);
    expect(json).toEqual({
      id: "x",
      when: "2026-09-18T10:00:00.000Z",
      amount: "12.5",
      big: "9007199254740993",
      blob: Buffer.from([1, 2, 255]).toString("base64"),
      meta: { a: 1 },
      payload: [1, 2],
      tags: ["a", "b"],
      kind: "manual",
    });
    expect(JSON.parse(JSON.stringify(json))).toEqual(json);
    const back = deserializeRow(fields, JSON.parse(JSON.stringify(json)));
    expect(back.when).toEqual(row.when);
    expect((back.amount as Prisma.Decimal).toString()).toBe("12.5");
    expect(back.big).toBe(BigInt("9007199254740993"));
    expect(Buffer.from(back.blob as Uint8Array)).toEqual(Buffer.from([1, 2, 255]));
    expect(back.meta).toEqual({ a: 1 });
    expect(back.tags).toEqual(["a", "b"]);
    expect(back).not.toHaveProperty("relation");
  });
  it("writes nulls the way Prisma wants them", () => {
    const back = deserializeRow(fields, { id: "x", when: null, blob: null, meta: null, payload: null });
    expect(back.when).toBeNull();
    expect(back.blob).toBeNull();
    expect(back.meta).toBe(Prisma.DbNull);
    expect(back.payload).toBe(Prisma.JsonNull);
    // Una columna nueva que la copia no trae no se toca (queda con su default).
    expect(back).not.toHaveProperty("amount");
  });
  it("uses the real Order fields, so a schema change is covered without edits", () => {
    const order = tenantModel("Order")!;
    const json = serializeRow(order.fields, { id: "o1", createdAt: new Date("2026-09-18T10:00:00.000Z"), items: [] });
    expect(json).toEqual({ id: "o1", createdAt: "2026-09-18T10:00:00.000Z" });
  });
});
