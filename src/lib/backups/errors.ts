export type BackupErrorCode =
  | "restaurant_not_found"
  | "backup_not_found"
  | "backup_version_unsupported"
  | "backup_missing_tables";

/**
 * Error con código estable para que la ruta lo traduzca a HTTP y el cliente
 * a un texto en su idioma. `details.missing` acompaña a
 * `backup_missing_tables` con las tablas que la copia no trae.
 */
export class BackupError extends Error {
  readonly code: BackupErrorCode;
  readonly details: { missing?: string[] };
  constructor(code: BackupErrorCode, details: { missing?: string[] } = {}) {
    super(code);
    this.name = "BackupError";
    this.code = code;
    this.details = details;
  }
}

export function isBackupError(e: unknown): e is BackupError {
  return e instanceof BackupError;
}
