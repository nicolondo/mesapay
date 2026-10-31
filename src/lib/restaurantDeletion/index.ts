/**
 * Eliminar un comercio con toda su información (sólo platform_admin).
 *
 *   policy.ts  — qué pasa con cada tabla, cada rol y cada archivo (y por qué).
 *   checks.ts  — bloqueos, avisos y conteos del diálogo; verificación final.
 *   users.ts   — personal que se borra vs. roles de plataforma que se desvinculan.
 *   archive.ts — el ZIP final (formato de las copias + documentos DIAN + archivos).
 *   files.ts   — archivos subidos: qué se conserva y qué se borra del disco.
 *   service.ts — la transacción completa y la lista de comercios eliminados.
 *   resolution.ts — qué se puede hacer con cada bloqueo desde el diálogo (puro, sirve en cliente).
 *   resolve.ts — las acciones que resuelven bloqueos (anular solicitudes, links, débito).
 */
export { RestaurantDeletionError, isRestaurantDeletionError, type RestaurantDeletionErrorCode } from "./errors";
export type { BlockerCode, DeletionBlocker, DeletionCounts, DeletionWarning, WarningCode } from "./checks";
export {
  deleteRestaurant,
  getDeletedRestaurantArchive,
  getDeletionPreview,
  listDeletedRestaurants,
  type DeletionPreview,
  type DeletionResult,
  type DeletionSummary,
} from "./service";
