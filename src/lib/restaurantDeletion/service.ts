import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { delegate, takeSnapshot } from "@/lib/backups/snapshot";
import { serializeRow, type SnapshotRow } from "@/lib/backups/serialize";
import { tenantModels, topologicalOrder } from "@/lib/backups/tables";
import { buildArchive, MAX_ARCHIVE_BYTES } from "./archive";
import {
  countDeletion,
  findBlockers,
  findWarnings,
  remainingRows,
  type DeletionBlocker,
  type DeletionCounts,
  type DeletionWarning,
} from "./checks";
import { RestaurantDeletionError } from "./errors";
import { collectUploadRefs, removeUploadedFiles, type FileRemovalReport, type UploadRef } from "./files";
import { lockParentRows } from "./locks";
import { PLATFORM_MODEL_POLICY, STAFF_ROLES, tenantDeletionWhere } from "./policy";
import { planUsers, usersWithForeignReferences, type UserPlan } from "./users";

type Client = Prisma.TransactionClient;

/**
 * Una sola transacción para todo el borrado, en READ COMMITTED con locks
 * explícitos (ver locks.ts: por qué no REPEATABLE READ). Timeout amplio: un
 * comercio grande son decenas de miles de filas más el ZIP.
 */
export const DELETE_TX_OPTIONS = {
  timeout: 10 * 60_000,
  maxWait: 30_000,
};
const IN_CHUNK = 1000;

export type DeletionActor = { id: string | null; email: string; role: string };

export type DeletionPreview = {
  restaurant: {
    id: string;
    name: string;
    slug: string;
    legalName: string | null;
    taxId: string | null;
    groupName: string | null;
  };
  counts: DeletionCounts;
  blockers: DeletionBlocker[];
  warnings: DeletionWarning[];
};

/** Lo que muestra el diálogo antes de confirmar. null si el comercio no existe. */
export async function getDeletionPreview(restaurantId: string, now: Date = new Date()): Promise<DeletionPreview | null> {
  const restaurant = await db.restaurant.findUnique({
    where: { id: restaurantId },
    select: { id: true, name: true, slug: true, legalName: true, taxId: true, group: { select: { name: true } } },
  });
  if (!restaurant) return null;
  const [counts, blockers, warnings] = [
    await countDeletion(db, restaurantId),
    await findBlockers(db, restaurantId, now),
    await findWarnings(db, restaurantId),
  ];
  return {
    restaurant: {
      id: restaurant.id,
      name: restaurant.name,
      slug: restaurant.slug,
      legalName: restaurant.legalName,
      taxId: restaurant.taxId,
      groupName: restaurant.group?.name ?? null,
    },
    counts,
    blockers,
    warnings,
  };
}

export type DeletionSummary = {
  orders: number;
  payments: number;
  invoices: number;
  dianInvoices: number;
  creditNotes: number;
  ingredients: number;
  journalEntries: number;
  usersDeleted: number;
  usersDetached: number;
  usersDisabled: number;
  files: number;
  filesArchived: number;
};

export type DeletionResult = {
  archiveId: string;
  summary: DeletionSummary;
  files: FileRemovalReport;
};

type TxOutcome = { archiveId: string; summary: DeletionSummary; uploads: UploadRef[]; paymentIds: string[] };

/**
 * Elimina un comercio con TODA su información. Irreversible.
 *
 *   1. El slug tipeado tiene que coincidir (el servidor no confía en el botón).
 *   2. Bloqueos (plata o documentos DIAN en curso): se revisan antes y otra
 *      vez dentro de la transacción, bajo el lock.
 *   3. En UNA transacción: lock del comercio → snapshot completo → ZIP final
 *      → fila DeletedRestaurantArchive + AuditEvent de plataforma → borrado
 *      hijos→padres con el bypass de triggers de la restauración → usuarios
 *      → verificación de que no quedó nada → DELETE del Restaurant. Si el
 *      export falla (o cualquier paso), rollback: no se borra nada y el
 *      archivo tampoco queda.
 *   4. Después del commit, los archivos del disco. Un fallo se loguea; el
 *      archivo final vive en la base, no en el disco, así que no se toca.
 */
export async function deleteRestaurant(args: {
  restaurantId: string;
  confirmSlug: string;
  actor: DeletionActor;
  now?: Date;
  /** Para tests: lectura/borrado de archivos sin tocar el disco. */
  readUpload?: (absolutePath: string) => Promise<Buffer>;
  removeFile?: (absolutePath: string) => Promise<void>;
}): Promise<DeletionResult> {
  const now = args.now ?? new Date();
  const restaurant = await db.restaurant.findUnique({
    where: { id: args.restaurantId },
    select: { id: true, slug: true },
  });
  if (!restaurant) throw new RestaurantDeletionError("not_found");
  if (args.confirmSlug !== restaurant.slug) throw new RestaurantDeletionError("confirm_mismatch");

  const early = await findBlockers(db, restaurant.id, now);
  if (early.length) throw new RestaurantDeletionError("blocked", { blockers: early });

  let outcome: TxOutcome;
  try {
    outcome = await db.$transaction(
      (tx) => deleteInTransaction(tx, restaurant.id, args.actor, now, args.readUpload),
      DELETE_TX_OPTIONS,
    );
  } catch (error) {
    if (isSerializationFailure(error)) throw new RestaurantDeletionError("concurrent_activity");
    throw error;
  }

  // Ya commiteado: de acá en adelante nada puede deshacer el borrado, sólo
  // limpiar. Los archivos del disco se borran recién ahora.
  const files = await removeUploadedFiles(
    outcome.uploads.map((u) => u.url),
    { remove: args.removeFile },
  );
  // Tablas SIN FK al comercio: un INSERT concurrente no lo frena ningún lock
  // (un aviso SSE, una suscripción push, una operación de cobro). Lo que se
  // haya colado no tiene a quién servirle: barrido final, best-effort.
  const sweeps: [string, () => Promise<unknown>][] = [
    ["PlatformEvent", () => db.platformEvent.deleteMany({ where: { restaurantId: restaurant.id } })],
    ["PushSubscription", () => db.pushSubscription.deleteMany({ where: { restaurantId: restaurant.id } })],
    ...chunks(outcome.paymentIds).map(
      (ids): [string, () => Promise<unknown>] => ["FinancialOperation", () => db.financialOperation.deleteMany({ where: { paymentId: { in: ids } } })],
    ),
  ];
  for (const [model, sweep] of sweeps) {
    await sweep().catch((error: unknown) => {
      console.error("restaurant_delete_cleanup_failed", {
        restaurantId: restaurant.id,
        model,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }
  return { archiveId: outcome.archiveId, summary: outcome.summary, files };
}

async function deleteInTransaction(
  tx: Client,
  restaurantId: string,
  actor: DeletionActor,
  now: Date,
  readUpload: ((absolutePath: string) => Promise<Buffer>) | undefined,
): Promise<TxOutcome> {
  // Primero el advisory lock (mismo orden que las notas crédito: lock →
  // fila del comercio), después la fila: un INSERT con FK al comercio toma
  // KEY SHARE sobre ella, así que FOR UPDATE frena altas nuevas hasta el fin.
  // 947 = el mismo advisory lock por comercio que la restauración de copias
  // y la emisión de notas crédito (literal: es int4, no un parámetro).
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${restaurantId}), 947)`;
  await tx.$queryRaw`SELECT id FROM "Restaurant" WHERE id = ${restaurantId} FOR UPDATE`;
  // Y las filas padre: desde acá no aparece ninguna fila nueva del comercio,
  // así que lo que se archiva es exactamente lo que se borra.
  await lockParentRows(tx, restaurantId);

  const blockers = await findBlockers(tx, restaurantId, now);
  if (blockers.length) throw new RestaurantDeletionError("blocked", { blockers });

  // ── 1. Leer todo ────────────────────────────────────────────────────────
  const snapshot = await takeSnapshot(restaurantId, tx);
  const info = await tx.restaurant.findUniqueOrThrow({
    where: { id: restaurantId },
    select: { name: true, slug: true, legalName: true, taxId: true, country: true },
  });

  const users = await tx.user.findMany({ where: { restaurantId }, select: { id: true, role: true } });
  const staffIds = users.filter((u) => STAFF_ROLES.includes(u.role)).map((u) => u.id);
  const foreign = await usersWithForeignReferences(tx, restaurantId, staffIds);
  const plan: UserPlan = planUsers(users, new Set(foreign.keys()));

  const paymentIds = (snapshot.data.tables.Payment ?? []).map((row) => row.id).filter((id): id is string => typeof id === "string");
  const platform = await readPlatformRows(tx, restaurantId, paymentIds);
  const uploads = collectUploadRefs({ restaurant: snapshot.data.restaurant, tables: snapshot.data.tables, platform });

  const counts = snapshot.tableCounts;
  const baseSummary = {
    orders: counts.Order ?? 0,
    payments: counts.Payment ?? 0,
    invoices: counts.SimpleInvoice ?? 0,
    dianInvoices: (snapshot.data.tables.DianDocument ?? []).filter((d) => d.kind === "invoice").length,
    creditNotes: counts.CreditNote ?? 0,
    ingredients: counts.Ingredient ?? 0,
    journalEntries: counts.JournalEntry ?? 0,
    usersDeleted: plan.deleteIds.length,
    usersDetached: plan.detachIds.length,
    usersDisabled: plan.disableIds.length,
    files: uploads.length,
  };

  // ── 2. Archivo final (si falla, rollback: no se borra nada) ─────────────
  const archive = await buildArchive({
    restaurantId,
    restaurant: info,
    deletedAt: now,
    deletedBy: { id: actor.id, email: actor.email },
    snapshot: snapshot.data,
    platform,
    summary: baseSummary,
    users: {
      deleted: plan.deleteIds,
      detached: plan.detachIds,
      disabled: plan.disableIds.map((id) => ({ id, references: foreign.get(id) ?? [] })),
    },
    uploads,
    readUpload,
  });
  if (archive.zip.length > MAX_ARCHIVE_BYTES) throw new RestaurantDeletionError("archive_too_large");
  const summary: DeletionSummary = { ...baseSummary, filesArchived: archive.manifest.files.archived.length };

  const row = await tx.deletedRestaurantArchive.create({
    data: {
      deletedRestaurantId: restaurantId,
      name: info.name,
      slug: info.slug,
      legalName: info.legalName,
      taxId: info.taxId,
      country: info.country,
      deletedAt: now,
      deletedById: actor.id,
      deletedByEmail: actor.email,
      counts: { summary, tables: { ...archive.manifest.tables, ...archive.manifest.platformTables } },
      // El Buffer de jszip es un ArrayBuffer común (no compartido): sin copiar 200 MB.
      archive: archive.zip as Uint8Array<ArrayBuffer>,
      archiveBytes: archive.zip.length,
      archiveSha256: archive.sha256,
    },
    select: { id: true },
  });
  // Auditoría de PLATAFORMA (restaurantId null): no depende del comercio.
  await tx.auditEvent.create({
    data: {
      actorUserId: actor.id,
      actorEmail: actor.email,
      actorRole: actor.role,
      restaurantId: null,
      kind: "restaurant.delete",
      targetType: "restaurant",
      targetId: restaurantId,
      summary: `Eliminó el comercio ${info.name} (/${info.slug})`,
      diff: {
        before: { name: info.name, slug: info.slug, legalName: info.legalName, taxId: info.taxId },
        after: { archiveId: row.id, ...summary },
      },
    },
  });

  // ── 3. Borrar ───────────────────────────────────────────────────────────
  // Bypass de los triggers de negocio (reserve_payment, order_event y la
  // sincronización de códigos de barras), igual que la restauración: sólo
  // dentro de esta transacción. Las FKs y los CHECK siguen activos.
  await tx.$executeRaw`SET LOCAL app.restoring = '1'`;
  await tx.$executeRaw`SET LOCAL app.ingredient_barcodes_restore = '1'`;

  const models = new Map(tenantModels().map((m) => [m.name, m]));
  for (const name of topologicalOrder().delete) {
    const model = models.get(name)!;
    await delegate(tx, model).deleteMany({ where: tenantDeletionWhere(model, restaurantId) });
  }
  for (const ids of chunks(paymentIds)) {
    await tx.financialOperation.deleteMany({ where: { paymentId: { in: ids } } });
  }
  for (const [name, policy] of Object.entries(PLATFORM_MODEL_POLICY)) {
    if (policy.action !== "delete" || name === "FinancialOperation") continue;
    await delegate(tx, { delegate: delegateOf(name) }).deleteMany({ where: { restaurantId } });
  }
  // Registros de plataforma que se conservan: el nombre queda copiado antes
  // de que la FK pase a null con el DELETE del comercio.
  await tx.membershipPayment.updateMany({ where: { restaurantId }, data: { deletedRestaurantName: info.name } });
  await tx.commissionEntry.updateMany({ where: { restaurantId }, data: { deletedRestaurantName: info.name } });

  // Usuarios. Cambiar restaurantId/disabledAt sube sessionVersion (trigger
  // revoke_sessions): sus sesiones abiertas mueren. Los borrados, igual (el
  // callback jwt de auth.ts ya no los encuentra).
  if (plan.detachIds.length) {
    await tx.user.updateMany({ where: { id: { in: plan.detachIds }, restaurantId }, data: { restaurantId: null } });
  }
  if (plan.disableIds.length) {
    await tx.user.updateMany({ where: { id: { in: plan.disableIds }, disabledAt: null }, data: { disabledAt: now } });
    await tx.user.updateMany({ where: { id: { in: plan.disableIds }, restaurantId }, data: { restaurantId: null } });
  }
  if (plan.deleteIds.length) {
    // Doble guarda: aunque el plan se equivocara, este DELETE sólo alcanza
    // roles de personal del comercio. Un platform_admin no entra nunca.
    await tx.user.deleteMany({
      where: { id: { in: plan.deleteIds }, restaurantId, role: { in: [...STAFF_ROLES] } },
    });
  }

  // Nada de lo que había que borrar puede quedar: el DELETE del comercio lo
  // arrastraría en cascada sin pasar por el archivo (o se llevaría un User).
  const leftovers = await remainingRows(tx, restaurantId);
  if (Object.keys(leftovers).length) throw new RestaurantDeletionError("leftover_rows", { leftovers });

  await tx.restaurant.delete({ where: { id: restaurantId } });
  return { archiveId: row.id, summary, uploads, paymentIds };
}

function chunks<T>(items: readonly T[], size = IN_CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function delegateOf(model: string): string {
  return model.charAt(0).toLowerCase() + model.slice(1);
}

function scalarFields(model: string) {
  const m = Prisma.dmmf.datamodel.models.find((x) => x.name === model);
  if (!m) throw new Error(`restaurant_delete_model_missing:${model}`);
  return { fields: m.fields.filter((f) => f.kind !== "object"), idField: m.fields.find((f) => f.isId)?.name ?? "id" };
}

async function readRows(client: Client, model: string, where: Record<string, unknown>): Promise<SnapshotRow[]> {
  const { fields, idField } = scalarFields(model);
  const rows: SnapshotRow[] = [];
  for (let skip = 0; ; skip += IN_CHUNK) {
    const batch = await delegate(client, { delegate: delegateOf(model) }).findMany({
      where,
      orderBy: { [idField]: "asc" },
      skip,
      take: IN_CHUNK,
    });
    for (const row of batch ?? []) rows.push(serializeRow(fields, row));
    if (!batch || batch.length < IN_CHUNK) break;
  }
  return rows;
}

/** Filas de las tablas de plataforma que van al archivo final. */
async function readPlatformRows(
  client: Client,
  restaurantId: string,
  paymentIds: readonly string[],
): Promise<Record<string, SnapshotRow[]>> {
  const out: Record<string, SnapshotRow[]> = {};
  for (const [model, policy] of Object.entries(PLATFORM_MODEL_POLICY)) {
    if (policy.action === "with_owner" || !policy.archive) continue;
    if (model === "FinancialOperation") {
      const rows: SnapshotRow[] = [];
      for (const ids of chunks(paymentIds)) rows.push(...(await readRows(client, model, { paymentId: { in: ids } })));
      out[model] = rows;
      continue;
    }
    out[model] = await readRows(client, model, { restaurantId });
  }
  return out;
}

function isSerializationFailure(error: unknown): boolean {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034") return true;
  const message = error instanceof Error ? error.message : "";
  return /could not serialize access|deadlock detected|40001|40P01/.test(message);
}

/** Lista de "Comercios eliminados" (sin el ZIP). */
export async function listDeletedRestaurants() {
  return db.deletedRestaurantArchive.findMany({
    orderBy: { deletedAt: "desc" },
    select: {
      id: true,
      deletedRestaurantId: true,
      name: true,
      slug: true,
      legalName: true,
      taxId: true,
      country: true,
      deletedAt: true,
      deletedByEmail: true,
      counts: true,
      archiveBytes: true,
      archiveSha256: true,
    },
  });
}

/** ZIP del archivo final para descargar. null si no existe. */
export async function getDeletedRestaurantArchive(id: string) {
  return db.deletedRestaurantArchive.findUnique({
    where: { id },
    select: { id: true, slug: true, name: true, deletedAt: true, archive: true, archiveSha256: true },
  });
}
