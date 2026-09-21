import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { expiresAtFor, purgeExpiredBackups } from "./retention";
import { takeSnapshot } from "./snapshot";

export type BackupKind = "manual" | "auto" | "pre_restore";

/** Copias manuales vigentes que puede tener un comercio a la vez. */
export const MAX_MANUAL_BACKUPS = 5;
/** La automática diaria se salta si ya hay una `auto` más nueva que esto. */
export const AUTO_BACKUP_MIN_INTERVAL_MS = 20 * 60 * 60 * 1000;

export type BackupSummary = {
  id: string;
  kind: BackupKind;
  sizeBytes: number;
  tableCounts: Record<string, number>;
  note: string | null;
  createdAt: Date;
  expiresAt: Date;
  createdBy: { name: string | null; email: string } | null;
};

/** Lo que puede tardar leer un comercio grande tabla por tabla. */
export const SNAPSHOT_TX_OPTIONS = {
  isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
  timeout: 10 * 60_000,
  maxWait: 30_000,
};

export async function createBackup(args: {
  restaurantId: string;
  kind: BackupKind;
  createdById?: string | null;
  note?: string | null;
}): Promise<{ id: string; sizeBytes: number; tableCounts: Record<string, number>; createdAt: Date; expiresAt: Date }> {
  // REPEATABLE READ: todas las tablas se leen del mismo instante. Sin esto,
  // una copia tomada en plena operación puede traer un ítem cuya cuenta se
  // creó después de leer Order — y esa copia no restaura.
  const snapshot = await db.$transaction(
    (tx) => takeSnapshot(args.restaurantId, tx),
    SNAPSHOT_TX_OPTIONS,
  );
  const now = new Date();
  const row = await db.restaurantBackup.create({
    data: {
      restaurantId: args.restaurantId,
      kind: args.kind,
      createdById: args.createdById ?? null,
      note: args.note?.trim() || null,
      sizeBytes: snapshot.sizeBytes,
      tableCounts: snapshot.tableCounts,
      data: snapshot.data as unknown as Prisma.InputJsonValue,
      createdAt: now,
      expiresAt: expiresAtFor(now),
    },
    select: { id: true, sizeBytes: true, createdAt: true, expiresAt: true },
  });
  return { ...row, tableCounts: snapshot.tableCounts };
}

/** Lista sin el payload (`data`): puede pesar megas. */
export async function listBackups(restaurantId: string): Promise<BackupSummary[]> {
  const rows = await db.restaurantBackup.findMany({
    where: { restaurantId },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      kind: true,
      sizeBytes: true,
      tableCounts: true,
      note: true,
      createdAt: true,
      expiresAt: true,
      createdById: true,
    },
  });
  const userIds = [...new Set(rows.map((r) => r.createdById).filter((v): v is string => Boolean(v)))];
  const users = userIds.length
    ? await db.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true, email: true } })
    : [];
  const byId = new Map(users.map((u) => [u.id, { name: u.name, email: u.email }]));
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind as BackupKind,
    sizeBytes: r.sizeBytes,
    tableCounts: (r.tableCounts ?? {}) as Record<string, number>,
    note: r.note,
    createdAt: r.createdAt,
    expiresAt: r.expiresAt,
    createdBy: r.createdById ? (byId.get(r.createdById) ?? null) : null,
  }));
}

/** Borra una copia del comercio. `false` si no existe (o es de otro). */
export async function deleteBackup(restaurantId: string, id: string): Promise<boolean> {
  const { count } = await db.restaurantBackup.deleteMany({ where: { id, restaurantId } });
  return count > 0;
}

export async function countActiveManualBackups(restaurantId: string, now: Date = new Date()): Promise<number> {
  return db.restaurantBackup.count({ where: { restaurantId, kind: "manual", expiresAt: { gt: now } } });
}

/**
 * Corrida diaria (cron): una copia `auto` por comercio, salvo que ya tenga
 * una de las últimas 20 h (una corrida repetida no duplica), y después la
 * purga de vencidas. Un comercio que falle se loguea y no frena al resto.
 */
export async function runDailyBackups(now: Date = new Date()): Promise<{
  restaurants: number;
  created: number;
  skipped: number;
  failed: number;
  purged: number;
}> {
  const restaurants = await db.restaurant.findMany({ select: { id: true }, orderBy: { createdAt: "asc" } });
  const since = new Date(now.getTime() - AUTO_BACKUP_MIN_INTERVAL_MS);
  let created = 0;
  let skipped = 0;
  let failed = 0;
  for (const { id } of restaurants) {
    try {
      const recent = await db.restaurantBackup.findFirst({
        where: { restaurantId: id, kind: "auto", createdAt: { gte: since } },
        select: { id: true },
      });
      if (recent) {
        skipped++;
        continue;
      }
      await createBackup({ restaurantId: id, kind: "auto" });
      created++;
    } catch (error) {
      failed++;
      console.error("backup_auto_failed", {
        restaurantId: id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const purged = await purgeExpiredBackups(now);
  return { restaurants: restaurants.length, created, skipped, failed, purged };
}
