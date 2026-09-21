import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { db } from "../src/lib/db";
import {
  BackupError,
  createBackup,
  deleteBackup,
  listBackups,
  purgeExpiredBackups,
  restoreSnapshot,
  runDailyBackups,
  type SnapshotData,
} from "../src/lib/backups";

const url = new URL(process.env.DATABASE_URL ?? "postgresql://localhost/invalid");
if (!["127.0.0.1", "localhost"].includes(url.hostname) || !/^\/mesapay_.*(?:test|validation)$/.test(url.pathname)) {
  throw new Error("Isolated local database required");
}

const fixture = `backups-${randomUUID().slice(0, 12)}`;
const restaurants: string[] = [];
let restaurantId: string;
let otherRestaurantId: string;
let userId: string;
let table1: string;
let categoryId: string;
let item2: string;
let accountId: string;
let entryId: string;

async function createTable(number: number, label: string) {
  return (await db.table.create({ data: { restaurantId, number, label, qrToken: randomUUID() } })).id;
}

beforeAll(async () => {
  restaurantId = (
    await db.restaurant.create({
      data: { slug: fixture, name: "Fixture backups", tagline: "original", invoiceNextNumber: 10 },
    })
  ).id;
  otherRestaurantId = (await db.restaurant.create({ data: { slug: `${fixture}-b`, name: "Other" } })).id;
  restaurants.push(restaurantId, otherRestaurantId);
  userId = (
    await db.user.create({
      data: { email: `${fixture}@example.test`, passwordHash: "x", role: "operator", restaurantId },
    })
  ).id;
  table1 = await createTable(1, "Ventana");
  await createTable(2, "Barra");
  categoryId = (await db.category.create({ data: { restaurantId, slug: "platos", label: "Platos" } })).id;
  await db.menuItem.create({ data: { restaurantId, categoryId, name: "Bandeja", priceCents: 3500000 } });
  item2 = (await db.menuItem.create({ data: { restaurantId, categoryId, name: "Ajiaco", priceCents: 2800000 } })).id;
  accountId = (
    await db.ledgerAccount.create({
      data: { restaurantId, code: "110505", name: "Caja", type: "activo", nature: "debito", level: 4, postable: true },
    })
  ).id;
  entryId = (
    await db.journalEntry.create({
      data: {
        restaurantId,
        date: new Date("2026-09-01T12:00:00.000Z"),
        source: "manual",
        sourceRef: "fixture-1",
        memo: "Asiento de prueba",
        lines: {
          create: [
            { accountId, accountCode: "110505", debitCents: 1000, creditCents: 0, memo: "debe" },
            { accountId, accountCode: "110505", debitCents: 0, creditCents: 1000, memo: "haber" },
          ],
        },
      },
    })
  ).id;
});

// Limpieza en el orden que exigen las FKs RESTRICT (JournalLine → LedgerAccount
// no cascadea desde Restaurant), tolerante a un caso que haya quedado a medias:
// cada paso se intenta aunque el anterior falle, y la desconexión siempre corre.
async function cleanup() {
  const steps = [
    () => db.restaurantBackup.deleteMany({ where: { restaurantId: { in: restaurants } } }),
    () => db.journalEntry.deleteMany({ where: { restaurantId: { in: restaurants } } }),
    () => db.order.deleteMany({ where: { restaurantId: { in: restaurants } } }),
    () => db.restaurant.deleteMany({ where: { id: { in: restaurants } } }),
    () => db.platformEvent.deleteMany({ where: { restaurantId: { in: restaurants } } }),
  ];
  const errors: unknown[] = [];
  for (const step of steps) await step().catch((e) => errors.push(e));
  if (errors.length) throw errors[0];
}
afterAll(async () => {
  try {
    await cleanup();
  } finally {
    await db.$disconnect();
  }
});

describe("restaurant backups on PostgreSQL", () => {
  it("snapshots every tenant table, counts rows and lists without the payload", async () => {
    const created = await createBackup({ restaurantId, kind: "manual", createdById: userId, note: " antes " });
    expect(created.tableCounts).toMatchObject({ Table: 2, Category: 1, MenuItem: 2, LedgerAccount: 1, JournalEntry: 1, JournalLine: 2 });
    expect(created.sizeBytes).toBeGreaterThan(1000);
    expect(created.expiresAt.getTime() - created.createdAt.getTime()).toBe(7 * 24 * 3600 * 1000);

    const list = await listBackups(restaurantId);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: created.id, kind: "manual", note: "antes", createdBy: { email: `${fixture}@example.test` } });
    expect(list[0]).not.toHaveProperty("data");

    const stored = await db.restaurantBackup.findUniqueOrThrow({ where: { id: created.id } });
    const data = stored.data as unknown as SnapshotData;
    expect(data.version).toBe(1);
    expect(data.restaurant.slug).toBe(fixture);
    expect(data.tables.JournalLine.map((l) => l.memo).sort()).toEqual(["debe", "haber"]);
    expect(typeof data.tables.JournalEntry[0].date).toBe("string");
    expect(data.tables).not.toHaveProperty("User");
    expect(data.tables).not.toHaveProperty("RestaurantBackup");
  });

  it("restores tables, menu and ledger, keeps the pre_restore copy and never lowers the invoice counter", async () => {
    const backup = await createBackup({ restaurantId, kind: "manual", createdById: userId });

    // Desastre operativo después de la copia.
    await db.table.update({ where: { id: table1 }, data: { label: "Renombrada" } });
    await db.menuItem.delete({ where: { id: item2 } });
    const table3 = await createTable(3, "Nueva");
    await db.journalLine.deleteMany({ where: { entryId, memo: "haber" } });
    await db.restaurant.update({
      where: { id: restaurantId },
      data: { tagline: "cambiada", plan: "pro", suspended: true, invoiceNextNumber: 50 },
    });

    const result = await restoreSnapshot({ restaurantId, backupId: backup.id, actorId: userId });
    expect(result.restored).toMatchObject({ Table: 2, MenuItem: 2, JournalLine: 2 });
    expect(result.pruned).toEqual({});

    expect((await db.table.findUniqueOrThrow({ where: { id: table1 } })).label).toBe("Ventana");
    expect(await db.table.findUnique({ where: { id: table3 } })).toBeNull();
    expect(await db.table.count({ where: { restaurantId } })).toBe(2);
    expect((await db.menuItem.findUniqueOrThrow({ where: { id: item2 } })).name).toBe("Ajiaco");
    expect(await db.menuItem.count({ where: { restaurantId } })).toBe(2);
    expect(await db.journalLine.count({ where: { entryId } })).toBe(2);
    expect(await db.ledgerAccount.count({ where: { restaurantId } })).toBe(1);

    const restaurant = await db.restaurant.findUniqueOrThrow({ where: { id: restaurantId } });
    expect(restaurant.tagline).toBe("original"); // dato del comercio: vuelve
    expect(restaurant.plan).toBe("pro"); // contrato con la plataforma: se queda
    expect(restaurant.suspended).toBe(true);
    expect(restaurant.invoiceNextNumber).toBe(50); // nunca baja
    expect(restaurant.slug).toBe(fixture);

    // El usuario que restauró sigue existiendo (User no se toca).
    expect(await db.user.findUnique({ where: { id: userId } })).not.toBeNull();

    const pre = await db.restaurantBackup.findUniqueOrThrow({ where: { id: result.preRestoreBackupId } });
    expect(pre.kind).toBe("pre_restore");
    expect(pre.restaurantId).toBe(restaurantId);
    expect(pre.createdById).toBe(userId);
    const preData = pre.data as unknown as SnapshotData;
    expect(preData.tables.Table).toHaveLength(3); // el estado que había ANTES de restaurar
    expect(preData.tables.MenuItem).toHaveLength(1);
    expect(preData.restaurant.tagline).toBe("cambiada");

    await db.restaurant.update({ where: { id: restaurantId }, data: { suspended: false } });
  });

  it("refuses a backup that belongs to another restaurant", async () => {
    const foreign = await createBackup({ restaurantId: otherRestaurantId, kind: "manual" });
    const before = await db.restaurantBackup.count({ where: { restaurantId, kind: "pre_restore" } });
    await expect(restoreSnapshot({ restaurantId, backupId: foreign.id })).rejects.toMatchObject({ code: "backup_not_found" });
    expect(await db.restaurantBackup.count({ where: { restaurantId, kind: "pre_restore" } })).toBe(before);
  });

  it("refuses a partial restore when the snapshot lacks a table that exists today", async () => {
    const backup = await createBackup({ restaurantId, kind: "manual" });
    const stored = await db.restaurantBackup.findUniqueOrThrow({ where: { id: backup.id } });
    const data = stored.data as unknown as SnapshotData;
    const tables = { ...data.tables };
    delete tables.Table;
    await db.restaurantBackup.update({
      where: { id: backup.id },
      data: { data: { ...data, tables } as unknown as Prisma.InputJsonValue },
    });

    const before = await db.restaurantBackup.count({ where: { restaurantId, kind: "pre_restore" } });
    const tablesBefore = await db.table.count({ where: { restaurantId } });
    let error: unknown;
    await restoreSnapshot({ restaurantId, backupId: backup.id }).catch((e) => (error = e));
    expect(error).toBeInstanceOf(BackupError);
    expect((error as BackupError).code).toBe("backup_missing_tables");
    expect((error as BackupError).details.missing).toEqual(["Table"]);
    // Ni copia previa ni un solo borrado: la guardia corre antes de tocar nada.
    expect(await db.restaurantBackup.count({ where: { restaurantId, kind: "pre_restore" } })).toBe(before);
    expect(await db.table.count({ where: { restaurantId } })).toBe(tablesBefore);
  });

  it("drops rows whose required reference points to a user that no longer exists", async () => {
    const ghost = await db.user.create({
      data: { email: `${fixture}-ghost@example.test`, passwordHash: "x", role: "mesero", restaurantId },
    });
    const shift = await db.shift.create({
      data: { restaurantId, openedById: ghost.id, openingCashCents: 0, userId: ghost.id },
    });
    // La cuenta lleva saldo: el trigger reserve_payment rechaza un cobro que
    // supere subtotal + impuesto − descuento (así se creó el estado real).
    const order = await db.order.create({
      data: { restaurantId, tableId: table1, shortCode: randomUUID().slice(0, 8), status: "paid", subtotalCents: 1000, totalCents: 1000 },
    });
    const payment = await db.payment.create({
      data: { orderId: order.id, method: "demo_cash", amountCents: 1000, status: "approved", shiftId: shift.id, collectedByUserId: ghost.id },
    });
    // Después del cobro la cuenta se cancela: estado histórico legítimo que el
    // trigger, evaluado fila por fila al recargar, rechazaría (`order_closed`).
    await db.order.update({ where: { id: order.id }, data: { status: "cancelled" } });
    const backup = await createBackup({ restaurantId, kind: "manual" });

    await db.payment.delete({ where: { id: payment.id } });
    await db.shift.delete({ where: { id: shift.id } });
    await db.user.delete({ where: { id: ghost.id } });
    const eventsBefore = await db.platformEvent.count({ where: { restaurantId } });

    const result = await restoreSnapshot({ restaurantId, backupId: backup.id });
    // El turno exige openedById: sin el usuario, se omite. El cobro apunta al
    // turno (nulable) y al cobrador (nulable): sobrevive con esas columnas en null.
    expect(result.pruned).toEqual({ Shift: 1 });
    expect(await db.shift.findUnique({ where: { id: shift.id } })).toBeNull();
    const restoredPayment = await db.payment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(restoredPayment.shiftId).toBeNull();
    expect(restoredPayment.collectedByUserId).toBeNull();
    expect(restoredPayment.amountCents).toBe(1000);
    expect((await db.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe("cancelled");
    // order_event estuvo apagado durante la recarga: ni un evento SSE por las
    // órdenes reinsertadas…
    expect(await db.platformEvent.count({ where: { restaurantId } })).toBe(eventsBefore);
    // …y los triggers volvieron a quedar activos al terminar.
    const triggers = await db.$queryRaw<{ tgname: string; tgenabled: string }[]>`
      SELECT tgname, tgenabled::text AS tgenabled FROM pg_trigger WHERE tgname IN ('reserve_payment', 'order_event')`;
    expect(triggers.map((t) => t.tgenabled)).toEqual(["O", "O"]);
    await expect(
      db.payment.create({ data: { orderId: order.id, method: "demo_cash", amountCents: 5000, status: "approved" } }),
    ).rejects.toThrow(/order_closed|amount_exceeds_outstanding/);
  });

  it("runs the daily job once per restaurant and purges what expired", async () => {
    await db.restaurantBackup.deleteMany({ where: { restaurantId: { in: restaurants }, kind: "auto" } });
    const first = await runDailyBackups();
    expect(first.created).toBeGreaterThanOrEqual(2);
    expect(await db.restaurantBackup.count({ where: { restaurantId, kind: "auto" } })).toBe(1);
    expect(await db.restaurantBackup.count({ where: { restaurantId: otherRestaurantId, kind: "auto" } })).toBe(1);

    const second = await runDailyBackups();
    expect(second.skipped).toBeGreaterThanOrEqual(2);
    expect(await db.restaurantBackup.count({ where: { restaurantId, kind: "auto" } })).toBe(1);

    const expired = await createBackup({ restaurantId, kind: "manual" });
    await db.restaurantBackup.update({ where: { id: expired.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect(await purgeExpiredBackups()).toBeGreaterThanOrEqual(1);
    expect(await db.restaurantBackup.findUnique({ where: { id: expired.id } })).toBeNull();
  });

  it("deletes only within the restaurant", async () => {
    const mine = await createBackup({ restaurantId, kind: "manual" });
    expect(await deleteBackup(otherRestaurantId, mine.id)).toBe(false);
    expect(await db.restaurantBackup.findUnique({ where: { id: mine.id } })).not.toBeNull();
    expect(await deleteBackup(restaurantId, mine.id)).toBe(true);
    expect(await db.restaurantBackup.findUnique({ where: { id: mine.id } })).toBeNull();
  });
});
