/**
 * Copias de seguridad por comercio.
 *
 *   tables.ts    — qué modelos son "del comercio" (derivado del DMMF).
 *   snapshot.ts  — leer todo a JSON.
 *   restore.ts   — reemplazar todo desde un JSON, en una transacción.
 *   retention.ts — 7 días.
 *   service.ts   — crear / listar / borrar / corrida diaria.
 *
 * Es un "deshacer" del comercio que vive DENTRO de la misma base: no
 * protege contra la pérdida del servidor (para eso está el pg_dump del
 * VPS, ver docs/backups.md) y no incluye archivos subidos.
 */
export { BackupError, isBackupError, type BackupErrorCode } from "./errors";
export { expiresAtFor, purgeExpiredBackups, RETENTION_DAYS } from "./retention";
export {
  restoreSnapshot,
  RESTORE_CONFIRM_WORD,
  RESTAURANT_MONOTONIC_COLUMNS,
  RESTAURANT_SKIPPED_COLUMNS,
  type RestoreResult,
} from "./restore";
export {
  AUTO_BACKUP_MIN_INTERVAL_MS,
  countActiveManualBackups,
  createBackup,
  deleteBackup,
  listBackups,
  MAX_MANUAL_BACKUPS,
  runDailyBackups,
  type BackupKind,
  type BackupSummary,
} from "./service";
export { takeSnapshot, totalRows, type Snapshot, type SnapshotData } from "./snapshot";
export { backupModelNames, EXCLUDED_MODELS, tenantModels, topologicalOrder } from "./tables";
