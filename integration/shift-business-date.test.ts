import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Prisma } from "@prisma/client";
import { db } from "../src/lib/db";
import { bogotaBusinessDateIso } from "../src/lib/bogota";
import { buildShiftReport, listShiftsWithSummary } from "../src/lib/shiftReport";
import { createBackup, restoreSnapshot, type SnapshotData } from "../src/lib/backups";
import { POST as openGlobal } from "../src/app/api/operator/shifts/open/route";
import { POST as openWaiter } from "../src/app/api/mesero/shift/open/route";
import { POST as closeGlobal } from "../src/app/api/operator/shifts/close/route";
import { POST as closeWaiter } from "../src/app/api/mesero/shift/close/route";

const scope = vi.hoisted(() => ({ restaurantId: "", userId: "", role: "operator" }));
vi.mock("../src/lib/secureApi", () => ({ secureApi: (handler: unknown) => handler }));
vi.mock("../src/auth", () => ({
  auth: async () => ({
    user: { id: scope.userId, role: scope.role, restaurantId: scope.restaurantId },
  }),
}));
vi.mock("../src/lib/activeRestaurant", () => ({ getActiveRestaurantId: async () => scope.restaurantId }));
vi.mock("../src/lib/events", () => ({ publishOrderEvent: vi.fn() }));

const database = new URL(process.env.DATABASE_URL ?? "postgresql://localhost/invalid");
if (!["localhost", "127.0.0.1"].includes(database.hostname) || !/^\/mesapay_.*(?:test|validation)$/.test(database.pathname)) {
  throw new Error("Isolated local database required");
}
const tenants: string[] = [];
let operatorId: string;
let waiterId: string;
const request = (data: unknown) => new Request("http://localhost/api/shifts", {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(data),
});

beforeEach(async () => {
  const restaurant = await db.restaurant.create({
    data: {
      name: "Shift date fixture", slug: `shift-date-${randomUUID()}`, businessDayCutoffHour: 5,
      shiftPolicy: "by_waiter", meseroShiftWithoutLocal: "auto_open",
    },
  });
  tenants.push(restaurant.id);
  scope.restaurantId = restaurant.id;
  operatorId = (await db.user.create({
    data: { restaurantId: restaurant.id, role: "operator", email: `${randomUUID()}@example.test`, passwordHash: "test-only" },
  })).id;
  waiterId = (await db.user.create({
    data: { restaurantId: restaurant.id, role: "mesero", email: `${randomUUID()}@example.test`, passwordHash: "test-only" },
  })).id;
  scope.userId = operatorId;
  scope.role = "operator";
});
afterEach(() => vi.useRealTimers());
afterAll(async () => {
  try {
    await db.restaurant.deleteMany({ where: { id: { in: tenants } } });
  } finally {
    await db.$disconnect();
  }
});

async function insertShift(openedAt: string, userId: string | null = null) {
  return db.shift.create({
    data: {
      restaurantId: scope.restaurantId, openedById: userId ?? operatorId, userId,
      openingCashCents: 1000, openedAt: new Date(openedAt),
    },
  });
}

describe("persisted shift business dates on PostgreSQL", () => {
  it("stores the opening date before close for legacy inserts that omit the new field", async () => {
    const shift = await insertShift("2026-10-18T06:18:00Z");
    const [stored] = await db.$queryRaw<{ businessDate: string }[]>`
      SELECT "businessDate"::text AS "businessDate" FROM "Shift" WHERE id = ${shift.id}`;
    expect(stored.businessDate).toBe("2026-10-17");
    expect(shift.status).toBe("open");
    expect(shift.closedAt).toBeNull();
  });

  it.each([
    [0, "2026-10-18T04:59:59.999Z", "2026-10-17"],
    [0, "2026-10-18T05:00:00.000Z", "2026-10-18"],
    [5, "2026-10-18T09:59:59.999Z", "2026-10-17"],
    [5, "2026-10-18T10:00:00.000Z", "2026-10-18"],
    [23, "2026-10-19T03:59:59.999Z", "2026-10-17"],
    [23, "2026-10-19T04:00:00.000Z", "2026-10-18"],
  ])("persists cutoff %i at %s consistently with the reporting helper", async (cutoff, instant, expected) => {
    await db.restaurant.update({ where: { id: scope.restaurantId }, data: { businessDayCutoffHour: cutoff } });
    const shift = await insertShift(instant);
    expect(shift.businessDate?.toISOString()).toBe(`${expected}T00:00:00.000Z`);
    expect(bogotaBusinessDateIso(shift.openedAt, cutoff)).toBe(expected);
  });

  it("does not depend on the database session timezone", async () => {
    await db.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL TIME ZONE 'Pacific/Auckland'`;
      const shift = await tx.shift.create({
        data: {
          restaurantId: scope.restaurantId, openedById: operatorId, openingCashCents: 0,
          openedAt: new Date("2027-01-01T06:18:00Z"),
        },
      });
      expect(shift.businessDate?.toISOString()).toBe("2026-12-31T00:00:00.000Z");
      expect(shift.openedAt.toISOString()).toBe("2027-01-01T06:18:00.000Z");
    });
  });

  it("covers operator opening and both automatic-global and personal waiter opening", async () => {
    const operatorResponse = await openGlobal(request({ openingCashCents: 1000 }));
    expect(operatorResponse.status).toBe(200);
    const { shiftId } = await operatorResponse.json();
    const operatorShift = await db.shift.findUniqueOrThrow({ where: { id: shiftId } });
    expect(operatorShift.businessDate?.toISOString().slice(0, 10)).toBe(bogotaBusinessDateIso(operatorShift.openedAt, 5));
    await db.shift.update({ where: { id: shiftId }, data: { status: "closed", closedAt: new Date() } });

    scope.userId = waiterId;
    scope.role = "mesero";
    const response = await openWaiter(request({ openingCashCents: 1000 }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ localAutoOpened: true });
    const shifts = await db.shift.findMany({ where: { restaurantId: scope.restaurantId, status: "open" } });
    expect(shifts).toHaveLength(2);
    expect(shifts.map((shift) => shift.userId).sort()).toEqual([waiterId, null].sort());
    for (const shift of shifts) {
      expect(shift.businessDate?.toISOString().slice(0, 10)).toBe(bogotaBusinessDateIso(shift.openedAt, 5));
    }
    expect(shifts.find((shift) => shift.userId === null)?.autoOpened).toBe(true);
  });

  it.each([
    ["2026-10-17T17:10:00Z", "2026-10-18T06:18:00Z", "2026-10-17"],
    ["2026-10-11T16:07:00Z", "2026-10-12T06:01:00Z", "2026-10-11"],
    ["2026-10-17T17:10:00Z", "2026-10-19T11:18:00Z", "2026-10-17"],
  ])("keeps the opening's date when a shift opened at %s closes at %s", async (openedAt, closedAt, expected) => {
    const shift = await insertShift(openedAt);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(closedAt));
    const response = await closeGlobal(request({ declaredCashCents: 1000 }));
    expect(response.status).toBe(200);
    const stored = await db.shift.findUniqueOrThrow({ where: { id: shift.id } });
    expect(stored.businessDate?.toISOString().slice(0, 10)).toBe(expected);
    expect(stored.openedAt.toISOString()).toBe(new Date(openedAt).toISOString());
    expect(stored.closedAt?.toISOString()).toBe(new Date(closedAt).toISOString());
    expect(stored).toMatchObject({ declaredCashCents: BigInt(1000), expectedCashCents: BigInt(1000), cashDiffCents: BigInt(0) });
    const report = await buildShiftReport(shift.id);
    expect(report?.shift.businessDate?.toISOString().slice(0, 10)).toBe(expected);
    const summary = await listShiftsWithSummary(scope.restaurantId);
    expect(summary.items[0].businessDate?.toISOString().slice(0, 10)).toBe(expected);
  });

  it("preserves the stored date after cutoff changes and waiter close", async () => {
    const shift = await insertShift("2026-10-18T06:00:00Z", waiterId);
    await db.restaurant.update({ where: { id: scope.restaurantId }, data: { businessDayCutoffHour: 0 } });
    scope.userId = waiterId;
    scope.role = "mesero";
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-18T11:18:00Z"));
    expect((await closeWaiter(request({ declaredCashCents: 1000 }))).status).toBe(200);
    const stored = await db.shift.findUniqueOrThrow({ where: { id: shift.id } });
    expect(stored.businessDate?.toISOString()).toBe("2026-10-17T00:00:00.000Z");
    expect(stored.closedAt?.toISOString()).toBe("2026-10-18T11:18:00.000Z");
    expect(stored.cashDiffCents).toBe(BigInt(0));
  });

  it("preserves each opening's date when the global close also closes waiter shifts", async () => {
    const global = await insertShift("2026-10-17T17:10:00Z");
    const waiter = await insertShift("2026-10-18T10:10:00Z", waiterId);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-18T11:18:00Z"));
    expect((await closeGlobal(request({ declaredCashCents: 1000, closeMeseroShifts: true }))).status).toBe(200);
    const shifts = await db.shift.findMany({ where: { id: { in: [global.id, waiter.id] } } });
    expect(shifts.every((shift) => shift.status === "closed")).toBe(true);
    expect(shifts.find((shift) => shift.id === global.id)?.businessDate?.toISOString()).toBe("2026-10-17T00:00:00.000Z");
    expect(shifts.find((shift) => shift.id === waiter.id)?.businessDate?.toISOString()).toBe("2026-10-18T00:00:00.000Z");
  });

  it("preserves an explicit business date even while restoring and fills explicit nulls", async () => {
    await db.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL app.restoring = '1'`;
      const data = {
        restaurantId: scope.restaurantId, openedById: operatorId, openingCashCents: 0,
        openedAt: new Date("2026-10-18T06:00:00Z"),
      };
      const explicit = await tx.shift.create({ data: { ...data, businessDate: new Date("2026-10-15T00:00:00Z") } });
      const missing = await tx.shift.create({ data: { ...data, businessDate: null } });
      expect(explicit.businessDate?.toISOString()).toBe("2026-10-15T00:00:00.000Z");
      expect(missing.businessDate?.toISOString()).toBe("2026-10-17T00:00:00.000Z");
    });
  });

  it.each([false, true])("restores a snapshot's jornada when the live cutoff changed (legacy: %s)", async (legacy) => {
    const shift = await insertShift("2026-10-18T06:18:00Z");
    if (!legacy) {
      // The date predates the snapshot's policy: the stored assignment must win.
      await db.restaurant.update({ where: { id: scope.restaurantId }, data: { businessDayCutoffHour: 0 } });
    }
    const backup = await createBackup({ restaurantId: scope.restaurantId, kind: "manual", createdById: operatorId });
    if (legacy) {
      const stored = await db.restaurantBackup.findUniqueOrThrow({ where: { id: backup.id } });
      const data = stored.data as unknown as SnapshotData;
      const shifts = data.tables.Shift.map((row) => Object.fromEntries(Object.entries(row).filter(([key]) => key !== "businessDate")));
      await db.restaurantBackup.update({
        where: { id: backup.id },
        data: { data: { ...data, tables: { ...data.tables, Shift: shifts } } as unknown as Prisma.InputJsonValue },
      });
    }
    await db.restaurant.update({ where: { id: scope.restaurantId }, data: { businessDayCutoffHour: legacy ? 0 : 23 } });
    await restoreSnapshot({ restaurantId: scope.restaurantId, backupId: backup.id, actorId: operatorId });
    const restored = await db.shift.findUniqueOrThrow({ where: { id: shift.id } });
    expect(restored.businessDate?.toISOString()).toBe("2026-10-17T00:00:00.000Z");
    expect(restored.openedAt).toEqual(shift.openedAt);
    expect(restored.openingCashCents).toBe(BigInt(1000));
    expect((await db.restaurant.findUniqueOrThrow({ where: { id: scope.restaurantId } })).businessDayCutoffHour).toBe(legacy ? 5 : 0);
  });

  it("backfills historical global and personal shifts without changing real times or money", async () => {
    const migration = readFileSync(new URL("../prisma/migrations/20261020180000_shift_business_date/migration.sql", import.meta.url), "utf8");
    const backfill = migration.match(/^UPDATE "Shift"[\s\S]*?;/m)?.[0];
    if (!backfill) throw new Error("Shift business-date backfill not found");
    await db.$transaction(async (tx) => {
      // Temporary tables shadow only this connection, so the real migration's
      // backfill can be tested without changing any live fixture or trigger.
      await tx.$executeRaw`CREATE TEMP TABLE "Restaurant" (id text, "businessDayCutoffHour" integer) ON COMMIT DROP`;
      await tx.$executeRaw`CREATE TEMP TABLE "Shift" (
        id text, "restaurantId" text, "userId" text, "openedAt" timestamp(3),
        "closedAt" timestamp(3), "openingCashCents" bigint, "businessDate" date
      ) ON COMMIT DROP`;
      await tx.$executeRaw`INSERT INTO "Restaurant" VALUES ('r', 5)`;
      await tx.$executeRaw`INSERT INTO "Shift" VALUES
        ('global', 'r', NULL, '2026-10-17 17:10:00', '2026-10-18 06:18:00', 2771025000, NULL),
        ('personal', 'r', 'waiter', '2026-10-11 16:07:00', '2026-10-12 06:01:00', 3433623000, NULL),
        ('overnight', 'r', NULL, '2026-10-18 06:18:00', NULL, 1000, NULL),
        ('already-set', 'r', NULL, '2026-10-18 06:18:00', NULL, 1000, '2026-10-15')`;
      const before = await tx.$queryRaw<Record<string, unknown>[]>`
        SELECT id, "userId", "openedAt", "closedAt", "openingCashCents" FROM "Shift" ORDER BY id`;
      expect(await tx.$executeRawUnsafe(backfill)).toBe(3);
      expect(await tx.$queryRaw`
        SELECT id, "userId", "openedAt", "closedAt", "openingCashCents" FROM "Shift" ORDER BY id`).toEqual(before);
      expect(await tx.$queryRaw`SELECT id, "businessDate"::text AS day FROM "Shift" ORDER BY id`).toEqual([
        { id: "already-set", day: "2026-10-15" },
        { id: "global", day: "2026-10-17" },
        { id: "overnight", day: "2026-10-17" },
        { id: "personal", day: "2026-10-11" },
      ]);
    });
  });
});
