import { beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";

/**
 * Flujo de la restauración con la base mockeada: el orden exacto de lo que
 * pasa dentro de la transacción es lo que importa (lock → SET LOCAL
 * app.restoring → borrado → inserción → Restaurant), y eso no lo puede
 * verificar el test de integración desde afuera.
 */
const mocks = vi.hoisted(() => {
  const log: string[] = [];
  const raw = vi.fn<(...args: unknown[]) => Promise<unknown>>();
  const query = vi.fn<(...args: unknown[]) => Promise<unknown>>();
  const restaurantFind = vi.fn();
  const restaurantUpdate = vi.fn();
  const backupFind = vi.fn();
  const createBackup = vi.fn();
  const delegates = new Map<string, { deleteMany: ReturnType<typeof vi.fn>; createMany: ReturnType<typeof vi.fn>; findMany: ReturnType<typeof vi.fn> }>();
  const delegateFor = (name: string) => {
    let d = delegates.get(name);
    if (!d) {
      d = {
        deleteMany: vi.fn(async () => {
          log.push(`delete:${name}`);
          return { count: 0 };
        }),
        createMany: vi.fn(async (args: { data: unknown[] }) => {
          log.push(`insert:${name}:${args.data.length}`);
          return { count: args.data.length };
        }),
        findMany: vi.fn(async () => []),
      };
      delegates.set(name, d);
    }
    return d;
  };
  const tx = new Proxy(
    {},
    {
      get(_t, prop: string) {
        if (prop === "$executeRaw") return raw;
        if (prop === "$queryRaw") return query;
        if (prop === "restaurant") return { findUniqueOrThrow: restaurantFind, update: restaurantUpdate };
        return delegateFor(prop);
      },
    },
  );
  const db = {
    restaurantBackup: { findUnique: backupFind },
    $transaction: vi.fn(async (run: (tx: unknown) => unknown) => run(tx)),
  };
  return { log, raw, query, restaurantFind, restaurantUpdate, backupFind, createBackup, delegates, db };
});
vi.mock("@/lib/db", () => ({ db: mocks.db }));
vi.mock("./service", () => ({ createBackup: mocks.createBackup }));
import { BackupError } from "./errors";
import { restoreSnapshot } from "./restore";
import { backupModelNames, delegateName, topologicalOrder } from "./tables";

/** Tagged template (`strings, ...values`) o `Prisma.Sql` ya armado → Sql. */
const sqlOf = (call: unknown[]): Prisma.Sql =>
  typeof (call[0] as { sql?: unknown })?.sql === "string"
    ? (call[0] as Prisma.Sql)
    : Prisma.sql(call[0] as TemplateStringsArray, ...(call.slice(1) as Prisma.Sql[]));

function snapshot(overrides: Partial<Record<string, Record<string, unknown>[]>> = {}) {
  const tables: Record<string, Record<string, unknown>[]> = {};
  for (const name of backupModelNames()) tables[name] = [];
  return {
    version: 1,
    takenAt: "2026-09-18T04:00:00.000Z",
    restaurantId: "r1",
    restaurant: { id: "r1", slug: "fixture", name: "Fixture", tagline: "vieja", plan: "trial", invoiceNextNumber: 3 },
    tables: { ...tables, ...overrides },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.log.length = 0;
  mocks.raw.mockImplementation(async (...args: unknown[]) => {
    mocks.log.push(`raw:${sqlOf(args).sql.replace(/\s+/g, " ").trim().slice(0, 60)}`);
    return 0;
  });
  mocks.restaurantFind.mockResolvedValue({ invoiceNextNumber: 9 });
  mocks.restaurantUpdate.mockImplementation(async () => {
    mocks.log.push("update:Restaurant");
    return {};
  });
  mocks.createBackup.mockResolvedValue({ id: "pre-1" });
});

describe("restoreSnapshot", () => {
  it("rejects a backup of another restaurant before touching anything", async () => {
    mocks.backupFind.mockResolvedValue({ restaurantId: "other", data: snapshot() });
    await expect(restoreSnapshot({ restaurantId: "r1", backupId: "b1" })).rejects.toMatchObject({ code: "backup_not_found" });
    expect(mocks.createBackup).not.toHaveBeenCalled();
    expect(mocks.db.$transaction).not.toHaveBeenCalled();
  });
  it("refuses a partial snapshot, naming the missing tables, without a pre_restore copy", async () => {
    const data = snapshot();
    delete data.tables.Voucher;
    delete data.tables.OrderItem;
    mocks.backupFind.mockResolvedValue({ restaurantId: "r1", data });
    let error: unknown;
    await restoreSnapshot({ restaurantId: "r1", backupId: "b1" }).catch((e) => (error = e));
    expect(error).toBeInstanceOf(BackupError);
    expect((error as BackupError).details.missing?.sort()).toEqual(["OrderItem", "Voucher"]);
    expect(mocks.createBackup).not.toHaveBeenCalled();
    expect(mocks.db.$transaction).not.toHaveBeenCalled();
  });
  it("takes the pre_restore copy first and runs the transaction in the right order", async () => {
    mocks.backupFind.mockResolvedValue({
      restaurantId: "r1",
      data: snapshot({
        Table: [{ id: "t1", restaurantId: "r1", number: 1, qrToken: "q", createdAt: "2026-09-18T04:00:00.000Z" }],
        Order: [{ id: "o1", restaurantId: "r1", tableId: "t1", status: "cancelled", shortCode: "A", createdAt: "2026-09-18T04:00:00.000Z" }],
        Payment: [{ id: "p1", orderId: "o1", method: "demo_cash", status: "approved", amountCents: 1000, shiftId: null, collectedByUserId: null, createdAt: "2026-09-18T04:00:00.000Z" }],
      }),
    });
    const result = await restoreSnapshot({ restaurantId: "r1", backupId: "b1", actorId: "u1" });
    expect(mocks.createBackup).toHaveBeenCalledWith({ restaurantId: "r1", kind: "pre_restore", createdById: "u1" });
    expect(mocks.db.$transaction).toHaveBeenCalledWith(expect.any(Function), { timeout: 600000, maxWait: 30000 });
    expect(result).toEqual({ restored: expect.objectContaining({ Table: 1, Order: 1, Payment: 1, MenuItem: 0 }), pruned: {}, preRestoreBackupId: "pre-1" });

    const order = topologicalOrder();
    const log = mocks.log;
    // 1. lock, 2. GUC de bypass (local a la transacción), 3. borrado
    // hijos→padres, 4. inserción padres→hijos, 5. Restaurant. Nada después.
    expect(log[0]).toMatch(/^raw:SELECT pg_advisory_xact_lock/);
    expect(log[1]).toBe("raw:SET LOCAL app.restoring = '1'");
    // El log registra el delegate (`orderItem`), el orden trae el modelo (`OrderItem`).
    expect(log[2]).toBe("delete:" + delegateName(order.delete[0]));
    const deletes = log.filter((l) => l.startsWith("delete:")).map((l) => l.slice(7));
    expect(deletes).toEqual(order.delete.map(delegateName));
    const inserts = log.filter((l) => l.startsWith("insert:")).map((l) => l.split(":")[1]);
    expect(inserts).toEqual(["table", "order", "payment"]); // sólo las tablas con filas
    expect(log.indexOf("delete:" + delegateName(order.delete.at(-1)!))).toBeLessThan(log.indexOf("insert:table:1"));
    expect(log.indexOf("insert:payment:1")).toBeLessThan(log.indexOf("update:Restaurant"));
    expect(log.at(-1)).toBe("update:Restaurant");
    // El GUC se pone UNA vez y con SET LOCAL: sin RESET al final (muere con la
    // transacción) y sin ALTER TABLE (nada de locks de tabla).
    expect(log.filter((l) => l.includes("app.restoring"))).toHaveLength(1);
    expect(log.some((l) => /ALTER TABLE|TRIGGER|RESET/.test(l))).toBe(false);
    expect(mocks.query).not.toHaveBeenCalled();
  });
  it("updates the restaurant row without identity, credentials or platform columns, and never lowers the invoice counter", async () => {
    mocks.backupFind.mockResolvedValue({
      restaurantId: "r1",
      data: snapshot(),
    });
    await restoreSnapshot({ restaurantId: "r1", backupId: "b1" });
    const patch = mocks.restaurantUpdate.mock.calls[0][0].data;
    expect(patch).toMatchObject({ name: "Fixture", tagline: "vieja", invoiceNextNumber: 9 });
    for (const skipped of ["id", "slug", "plan", "kushkiPrivateKeyEnc", "suspended", "enabledModules"]) {
      expect(patch).not.toHaveProperty(skipped);
    }
  });
  it("does not touch the triggers themselves, only the transaction-local setting", async () => {
    mocks.backupFind.mockResolvedValue({ restaurantId: "r1", data: snapshot() });
    await restoreSnapshot({ restaurantId: "r1", backupId: "b1" });
    expect(mocks.log.filter((l) => l.startsWith("raw:"))).toEqual([
      expect.stringMatching(/^raw:SELECT pg_advisory_xact_lock/),
      "raw:SET LOCAL app.restoring = '1'",
    ]);
  });
});
