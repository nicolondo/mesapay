// Errores del POST de confirmación de la factura leída con IA → clave i18n
// (namespace opErp). Un código sin mapear NUNCA se vuelve un error mudo: se
// muestra el genérico CON el código crudo (errSaveFailedCode) — en producción
// un 409 `operation_conflict` sin mapear escondió por qué una factura entera
// no se podía guardar.
export const API_CONFIRM_ERROR_KEYS: Record<string, string> = {
  alias_invalid: "invAliasInvalid",
  alias_conflict: "invAliasConflict",
  invalid: "invReviewErrInvalid",
  supplier_not_found: "invReviewErrSupplierNotFound",
  supplier_archived: "invReviewErrSupplierArchived",
  ingredient_not_found: "invReviewErrIngredientNotFound",
  ingredient_archived: "invReviewErrIngredientArchived",
  ingredient_name_taken: "invReviewErrIngredientNameTaken",
  no_lines: "invReviewErrNoLines",
  not_found: "invReviewErrNotFound",
  not_pending: "invReviewErrNotPending",
  module_disabled: "invUploadErrModuleDisabled",
  totals_unconfirmed: "invRecAckRequired",
  line_invalid: "errLineInvalid",
  supplier_item_mismatch: "errSupplierItemMismatch",
  wrong_status: "errWrongStatus",
  nothing_to_receive: "errNothingToReceive",
  retention_exceeds_base: "errRetentionExceedsBase",
  retention_exceeds_total: "errRetentionExceedsTotal",
  operation_conflict: "errConcurrentConflict",
  rate_limited: "errRateLimited",
};

/**
 * Qué mostrar ante una respuesta no-ok del POST de confirmación: la clave
 * mapeada del código, o el genérico con el código crudo del servidor (o el
 * status HTTP si ni siquiera llegó un código).
 */
export function confirmErrorMessage(
  error: unknown,
  status: number,
): { key: string } | { key: "errSaveFailedCode"; code: string } {
  const code = typeof error === "string" && error ? error : `HTTP ${status}`;
  const key = API_CONFIRM_ERROR_KEYS[code];
  return key ? { key } : { key: "errSaveFailedCode", code };
}
