import type { DeletionBlocker } from "./checks";

export type RestaurantDeletionErrorCode =
  | "not_found"
  | "confirm_mismatch"
  /** Hay algo en curso que hay que resolver antes (ver `details.blockers`). */
  | "blocked"
  /** El ZIP final supera MAX_ARCHIVE_BYTES: no se borra nada. */
  | "archive_too_large"
  /** Quedaron filas del comercio sin borrar: se aborta antes del DELETE final. */
  | "leftover_rows"
  /** Otra transacción tocó el comercio durante el borrado (se reintenta). */
  | "concurrent_activity";

/**
 * Error con código estable: la ruta lo traduce a HTTP y el cliente a un texto
 * en su idioma. Ningún mensaje en español viaja al cliente.
 */
export class RestaurantDeletionError extends Error {
  readonly code: RestaurantDeletionErrorCode;
  readonly details: { blockers?: DeletionBlocker[]; leftovers?: Record<string, number> };
  constructor(
    code: RestaurantDeletionErrorCode,
    details: { blockers?: DeletionBlocker[]; leftovers?: Record<string, number> } = {},
  ) {
    super(code);
    this.name = "RestaurantDeletionError";
    this.code = code;
    this.details = details;
  }
}

export function isRestaurantDeletionError(e: unknown): e is RestaurantDeletionError {
  return e instanceof RestaurantDeletionError;
}
