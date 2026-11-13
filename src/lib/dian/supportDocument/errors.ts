/**
 * Motivo por el que un documento soporte no se puede generar o enviar. El
 * `code` es estable: la API lo devuelve tal cual y la pantalla lo traduce
 * (opSupportDoc.errors.<code>). `detail` lleva los campos faltantes.
 */
export const SUPPORT_DOC_ERROR_CODES = [
  "module_disabled",
  "not_enabled",
  "no_config",
  "no_certificate",
  "certificate_expired",
  "missing_software",
  "master_key_missing",
  "decrypt_failed",
  "missing_resolution",
  "resolution_expired",
  "numbering_exhausted",
  "test_set_missing",
  "emisor_incomplete",
  "source_not_found",
  "source_not_ready",
  "no_supplier",
  "supplier_not_flagged",
  "supplier_incomplete",
  "inc_not_supported",
  "iva_mismatch",
  "operation_in_future",
  "operation_too_old",
  "empty_document",
  "already_exists",
  "not_found",
  "not_adjustable",
  "adjustment_exceeds",
  "reason_too_short",
  "invalid_reason",
  "not_resendable",
  "environment_changed",
] as const;

export type SupportDocErrorCode = (typeof SUPPORT_DOC_ERROR_CODES)[number];

export class SupportDocError extends Error {
  constructor(
    public code: SupportDocErrorCode,
    public detail: string[] = [],
  ) {
    super(code);
  }
}

/** HTTP status para la API: 404 lo que no existe, 409 los conflictos, 400 el resto. */
export function supportDocErrorStatus(code: SupportDocErrorCode): number {
  if (code === "not_found" || code === "source_not_found") return 404;
  if (
    code === "already_exists" ||
    code === "not_resendable" ||
    code === "not_adjustable" ||
    code === "environment_changed"
  ) {
    return 409;
  }
  if (code === "module_disabled") return 403;
  return 400;
}
