import { db } from "@/lib/db";

/** Días que se conserva una copia, automática o manual (igual que zenith). */
export const RETENTION_DAYS = 7;

export function expiresAtFor(now: Date = new Date()): Date {
  return new Date(now.getTime() + RETENTION_DAYS * 24 * 60 * 60 * 1000);
}

/** Borra las copias vencidas. Devuelve cuántas se fueron. */
export async function purgeExpiredBackups(now: Date = new Date()): Promise<number> {
  const { count } = await db.restaurantBackup.deleteMany({ where: { expiresAt: { lt: now } } });
  return count;
}
