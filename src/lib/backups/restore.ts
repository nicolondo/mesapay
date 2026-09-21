import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { BackupError } from "./errors";
import { deserializeRow, type SnapshotRow } from "./serialize";
import { createBackup } from "./service";
import { delegate, SNAPSHOT_VERSION, type Client, type SnapshotData } from "./snapshot";
import {
  backupModelNames,
  delegateName,
  ownerWhere,
  RESTAURANT_MODEL,
  restaurantFields,
  tenantModels,
  topologicalOrder,
  type ForeignKey,
  type TenantModel,
} from "./tables";

/**
 * Columnas de `Restaurant` que NO se pisan al restaurar. La fila nunca se
 * borra: se actualiza con lo que trae la copia, salvo esto.
 *
 *   - Identidad de la fila: id, slug (es la URL pública), createdAt,
 *     updatedAt (lo pone Prisma).
 *   - Credenciales y alta de pagos con Kushki: llaves, secretos cifrados,
 *     modo, estado del onboarding y datos bancarios. Una llave rotada no
 *     puede volver atrás desde una copia — misma regla que DianConfig y
 *     KushkiDocument, que no se respaldan (ver tables.ts).
 *   - Contrato con la plataforma: plan, precio, vencimiento, suspensión,
 *     recordatorios, grupo, razón social compartida, comercial asignado,
 *     módulos y medios de pago habilitados, cupos de IA. Los administra el
 *     admin de plataforma; restaurar los datos del comercio no puede
 *     des-suspenderlo ni cambiarle el plan.
 */
export const RESTAURANT_SKIPPED_COLUMNS: ReadonlySet<string> = new Set([
  "id",
  "slug",
  "createdAt",
  "updatedAt",
  "kushkiMerchantId",
  "kushkiPublicKey",
  "kushkiPrivateKeyEnc",
  "kushkiWebhookSecretEnc",
  "kushkiPayoutPublicKey",
  "kushkiPayoutPrivateKeyEnc",
  "cloudTerminalBusinessCode",
  "kushkiMode",
  "kushkiCard3ds",
  "kushkiOnboardingStatus",
  "kushkiOnboardingNotes",
  "kushkiSubmittedAt",
  "kushkiActivatedAt",
  "bankInfo",
  "autoDispersePolicy",
  "plan",
  "monthlyPriceCents",
  "periodEndsAt",
  "suspended",
  "lastReminderSentAt",
  "lastReminderKind",
  "groupId",
  "legalEntityId",
  "menuMode",
  "salesRepUserId",
  "salesRepCommissionBps",
  "enabledModules",
  "enabledPaymentMethods",
  "aiInsightsEnabled",
  "aiDailyMessageLimit",
]);

/**
 * Consecutivos que sólo pueden crecer: los números de comprobante ya
 * emitidos (a la DIAN o impresos) después de la copia quedan quemados; si
 * el contador volviera atrás se repetirían.
 */
export const RESTAURANT_MONOTONIC_COLUMNS = ["invoiceNextNumber"] as const;

export const RESTORE_TX_OPTIONS = { timeout: 10 * 60_000, maxWait: 30_000 };
/** Palabra exacta que el operador tiene que escribir para restaurar (la valida el servidor). */
export const RESTORE_CONFIRM_WORD = "RESTAURAR";
/** Tope de parámetros por INSERT (Postgres admite 65535). */
const MAX_PARAMS_PER_INSERT = 30_000;
const IN_CHUNK = 1000;

export type RestoreResult = {
  /** Filas insertadas por tabla. */
  restored: Record<string, number>;
  /** Filas de la copia descartadas por apuntar a algo que ya no existe. */
  pruned: Record<string, number>;
  preRestoreBackupId: string;
};

/**
 * Reemplaza TODOS los datos del comercio por los de una copia.
 *
 *   1. La copia tiene que ser de este comercio y de una versión conocida.
 *   2. Guardia de cobertura: si hoy hay una tabla del comercio que la
 *      copia no trae, se aborta — nunca se restaura a medias (esa tabla se
 *      borraría sin reinsertarse).
 *   3. Se guarda una copia `pre_restore` del estado actual, ANTES y fuera
 *      de la transacción, para poder deshacer la restauración.
 *   4. En una sola transacción: borrar hijos→padres, insertar padres→hijos
 *      (saneando referencias a usuarios u otras filas de plataforma que ya
 *      no existen: nulable → null, obligatoria → se omite la fila y sus
 *      hijos), y actualizar la fila `Restaurant` (nunca se borra).
 */
export async function restoreSnapshot(args: {
  restaurantId: string;
  backupId: string;
  actorId?: string | null;
}): Promise<RestoreResult> {
  const backup = await db.restaurantBackup.findUnique({
    where: { id: args.backupId },
    select: { restaurantId: true, data: true },
  });
  if (!backup || backup.restaurantId !== args.restaurantId) throw new BackupError("backup_not_found");

  const data = backup.data as unknown as SnapshotData | null;
  if (
    !data ||
    data.version !== SNAPSHOT_VERSION ||
    data.restaurantId !== args.restaurantId ||
    typeof data.tables !== "object" ||
    data.tables === null
  ) {
    throw new BackupError("backup_version_unsupported");
  }

  const missing = backupModelNames().filter((name) => !Array.isArray(data.tables[name]));
  if (!data.restaurant || typeof data.restaurant !== "object") missing.unshift(RESTAURANT_MODEL);
  if (missing.length) throw new BackupError("backup_missing_tables", { missing });

  const pre = await createBackup({
    restaurantId: args.restaurantId,
    kind: "pre_restore",
    createdById: args.actorId ?? null,
  });

  const result = await db.$transaction(
    (tx) => restoreInTransaction(tx, args.restaurantId, data),
    RESTORE_TX_OPTIONS,
  );
  return { ...result, preRestoreBackupId: pre.id };
}

async function restoreInTransaction(
  tx: Client,
  restaurantId: string,
  data: SnapshotData,
): Promise<Omit<RestoreResult, "preRestoreBackupId">> {
  // Una restauración por comercio a la vez; el 947 sólo separa este lock de
  // los otros advisory locks del proyecto (731 stock, 733 facturas, 917 bonos).
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${restaurantId}), 947)`;

  const models = new Map(tenantModels().map((m) => [m.name, m]));
  const order = topologicalOrder();

  for (const name of order.delete) {
    const model = models.get(name)!;
    await delegate(tx, model).deleteMany({ where: ownerWhere(model, restaurantId) });
  }

  const restored: Record<string, number> = {};
  const pruned: Record<string, number> = {};
  const dropped = new Map<string, Set<unknown>>();
  for (const name of order.insert) {
    const model = models.get(name)!;
    const raw = data.tables[name].map((row) => deserializeRow(model.fields, row));
    const rows = orderSelfReferencing(model, await sanitizeForeignKeys(tx, model, raw, models, dropped));
    if (raw.length !== rows.length) pruned[name] = raw.length - rows.length;
    await insertRows(tx, model, rows);
    restored[name] = rows.length;
  }

  await updateRestaurantRow(tx, restaurantId, data.restaurant);
  return { restored, pruned };
}

/**
 * Referencias que ya no resuelven:
 *   - hacia un modelo respaldado: sólo puede fallar si esa fila padre se
 *     descartó en este mismo restore (`dropped`);
 *   - hacia un modelo fuera del respaldo (User, Group, …): se consulta la
 *     base, porque esas filas no se tocan y pueden haber desaparecido.
 * Nulable → null; obligatoria → se omite la fila (y se anota para que sus
 * hijos hagan lo mismo).
 */
async function sanitizeForeignKeys(
  tx: Client,
  model: TenantModel,
  rows: SnapshotRow[],
  models: Map<string, TenantModel>,
  dropped: Map<string, Set<unknown>>,
): Promise<SnapshotRow[]> {
  const droppedHere = new Set<unknown>();
  let survivors = rows;
  for (const fk of model.foreignKeys) {
    if (fk.target === RESTAURANT_MODEL || fk.target === model.name) continue;
    const missing = models.has(fk.target)
      ? (dropped.get(fk.target) ?? new Set<unknown>())
      : await missingOutsideIds(tx, fk, survivors);
    if (!missing.size) continue;
    survivors = survivors.flatMap((row) => {
      const value = row[fk.field];
      if (value == null || !missing.has(value)) return [row];
      if (fk.required) {
        droppedHere.add(row[model.idField]);
        return [];
      }
      return [{ ...row, [fk.field]: null }];
    });
  }
  // Auto-referencias (Category.parentId, Expense.templateId): el padre tiene
  // que estar entre las supervivientes. Iterar: descartar uno puede dejar
  // huérfano a otro.
  for (const fk of model.foreignKeys.filter((k) => k.target === model.name)) {
    let changed = true;
    while (changed) {
      changed = false;
      const ids = new Set(survivors.map((r) => r[model.idField]));
      survivors = survivors.flatMap((row) => {
        const value = row[fk.field];
        if (value == null || ids.has(value)) return [row];
        if (fk.required) {
          droppedHere.add(row[model.idField]);
          changed = true;
          return [];
        }
        return [{ ...row, [fk.field]: null }];
      });
    }
  }
  if (droppedHere.size) dropped.set(model.name, droppedHere);
  return survivors;
}

async function missingOutsideIds(tx: Client, fk: ForeignKey, rows: SnapshotRow[]): Promise<Set<unknown>> {
  const ids = [...new Set(rows.map((r) => r[fk.field]).filter((v) => v != null))];
  if (!ids.length) return new Set();
  const target = delegate(tx, { delegate: delegateName(fk.target) });
  const found = new Set<unknown>();
  for (let i = 0; i < ids.length; i += IN_CHUNK) {
    const chunk = ids.slice(i, i + IN_CHUNK);
    const existing = await target.findMany({
      where: { [fk.targetField]: { in: chunk } },
      select: { [fk.targetField]: true },
    });
    for (const row of existing) found.add(row[fk.targetField]);
  }
  return new Set(ids.filter((id) => !found.has(id)));
}

/** Padres antes que hijos dentro de la misma tabla (auto-referencias). */
export function orderSelfReferencing(model: TenantModel, rows: SnapshotRow[]): SnapshotRow[] {
  const selfKeys = model.foreignKeys.filter((k) => k.target === model.name);
  if (!selfKeys.length) return rows;
  const byId = new Map(rows.map((r) => [r[model.idField], r]));
  const placed = new Set<unknown>();
  const visiting = new Set<unknown>();
  const out: SnapshotRow[] = [];
  const visit = (row: SnapshotRow) => {
    const id = row[model.idField];
    if (placed.has(id) || visiting.has(id)) return;
    visiting.add(id);
    for (const fk of selfKeys) {
      const parent = byId.get(row[fk.field]);
      if (parent) visit(parent);
    }
    visiting.delete(id);
    placed.add(id);
    out.push(row);
  };
  for (const row of rows) visit(row);
  return out;
}

async function insertRows(tx: Client, model: TenantModel, rows: SnapshotRow[]): Promise<void> {
  if (!rows.length) return;
  const chunk = Math.max(1, Math.min(1000, Math.floor(MAX_PARAMS_PER_INSERT / Math.max(1, model.fields.length))));
  for (let i = 0; i < rows.length; i += chunk) {
    await delegate(tx, model).createMany({ data: rows.slice(i, i + chunk), skipDuplicates: false });
  }
}

async function updateRestaurantRow(tx: Client, restaurantId: string, snapshot: SnapshotRow): Promise<void> {
  const current = await tx.restaurant.findUniqueOrThrow({
    where: { id: restaurantId },
    select: { invoiceNextNumber: true },
  });
  const row = deserializeRow(restaurantFields(), snapshot);
  const patch: SnapshotRow = {};
  for (const [column, value] of Object.entries(row)) {
    if (!RESTAURANT_SKIPPED_COLUMNS.has(column)) patch[column] = value;
  }
  for (const column of RESTAURANT_MONOTONIC_COLUMNS) {
    patch[column] = Math.max(current[column], Number(row[column] ?? 0));
  }
  await tx.restaurant.update({
    where: { id: restaurantId },
    data: patch as Prisma.RestaurantUncheckedUpdateInput,
  });
}
