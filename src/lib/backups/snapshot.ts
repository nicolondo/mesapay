import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { BackupError } from "./errors";
import { serializeRow, type SnapshotRow } from "./serialize";
import { ownerWhere, restaurantFields, tenantModels, type TenantModel } from "./tables";

export const SNAPSHOT_VERSION = 1 as const;
/** Filas por consulta al leer cada tabla. */
export const BATCH_SIZE = 1000;

export type SnapshotData = {
  version: typeof SNAPSHOT_VERSION;
  takenAt: string;
  restaurantId: string;
  /** La fila `Restaurant` (se restaura por UPDATE, ver restore.ts). */
  restaurant: SnapshotRow;
  /** Modelo → filas, para todos los modelos de tables.ts (vacías incluidas). */
  tables: Record<string, SnapshotRow[]>;
};

export type Snapshot = {
  data: SnapshotData;
  tableCounts: Record<string, number>;
  sizeBytes: number;
};

/** Lo mínimo que se usa de un delegate de Prisma, sin atarse a cada modelo. */
export type Delegate = {
  findMany(args: {
    where: Record<string, unknown>;
    orderBy?: Record<string, "asc" | "desc">;
    skip?: number;
    take?: number;
    select?: Record<string, boolean>;
  }): Promise<SnapshotRow[]>;
  deleteMany(args: { where: Record<string, unknown> }): Promise<{ count: number }>;
  createMany(args: { data: SnapshotRow[]; skipDuplicates?: boolean }): Promise<{ count: number }>;
};

export type Client = Prisma.TransactionClient;

export function delegate(client: Client, model: TenantModel | { delegate: string }): Delegate {
  const d = (client as unknown as Record<string, Delegate | undefined>)[model.delegate];
  if (!d) throw new Error(`backup_delegate_missing:${model.delegate}`);
  return d;
}

/** Lee todas las filas del comercio para un modelo, en lotes de BATCH_SIZE. */
export async function readModelRows(
  client: Client,
  model: TenantModel,
  restaurantId: string,
): Promise<SnapshotRow[]> {
  const rows: SnapshotRow[] = [];
  const where = ownerWhere(model, restaurantId);
  for (let skip = 0; ; skip += BATCH_SIZE) {
    const batch = await delegate(client, model).findMany({
      where,
      orderBy: { [model.idField]: "asc" },
      skip,
      take: BATCH_SIZE,
    });
    for (const row of batch) rows.push(serializeRow(model.fields, row));
    if (batch.length < BATCH_SIZE) break;
  }
  return rows;
}

/**
 * Snapshot completo de un comercio: la fila `Restaurant` + todas las tablas
 * de tables.ts, como JSON puro (fechas ISO, Decimal/BigInt como string,
 * Bytes en base64, Json tal cual). No toca archivos en disco.
 */
export async function takeSnapshot(restaurantId: string, client: Client = db): Promise<Snapshot> {
  const restaurant = await client.restaurant.findUnique({ where: { id: restaurantId } });
  if (!restaurant) throw new BackupError("restaurant_not_found");

  const tables: Record<string, SnapshotRow[]> = {};
  const tableCounts: Record<string, number> = {};
  for (const model of tenantModels()) {
    const rows = await readModelRows(client, model, restaurantId);
    tables[model.name] = rows;
    tableCounts[model.name] = rows.length;
  }

  const data: SnapshotData = {
    version: SNAPSHOT_VERSION,
    takenAt: new Date().toISOString(),
    restaurantId,
    restaurant: serializeRow(restaurantFields(), restaurant as unknown as SnapshotRow),
    tables,
  };
  return { data, tableCounts, sizeBytes: Buffer.byteLength(JSON.stringify(data), "utf8") };
}

export function totalRows(tableCounts: Record<string, number>): number {
  return Object.values(tableCounts).reduce((a, b) => a + b, 0);
}
