/**
 * Reglas de vigencia de los documentos del onboarding de pagos (Kushki).
 *
 * Kushki exige que algunos documentos estén expedidos hace poco (p. ej. la
 * certificación de composición accionaria, menos de 90 días). MESAPAY no
 * captura la fecha de expedición, así que la vigencia se aproxima con la
 * fecha de subida: un documento subido hace más de N días seguro está vencido
 * (la expedición es anterior a la subida). Es una cota conservadora, y sólo
 * sirve para avisar: nunca bloquea el envío de la solicitud.
 */

export const DEFAULT_MAX_DOCUMENT_AGE_DAYS = 90;

/** Vigencia máxima por tipo de documento. Los que no figuran no vencen. */
export const DOCUMENT_MAX_AGE_DAYS: Partial<Record<string, number>> = {
  composicion_accionaria: DEFAULT_MAX_DOCUMENT_AGE_DAYS,
};

const MS_PER_DAY = 86_400_000;

/**
 * true si el documento se subió hace MÁS de `maxDays` días respecto a `now`.
 * Exactamente `maxDays` días todavía no vence. Una fecha inválida o ausente
 * no vence (no hay con qué juzgarla y no queremos alarmar de más).
 */
export function isStaleDocument(
  createdAt: Date | string | null | undefined,
  now: Date | number = Date.now(),
  maxDays: number = DEFAULT_MAX_DOCUMENT_AGE_DAYS,
): boolean {
  if (createdAt === null || createdAt === undefined) return false;
  const created = createdAt instanceof Date ? createdAt.getTime() : Date.parse(createdAt);
  const reference = now instanceof Date ? now.getTime() : now;
  if (!Number.isFinite(created) || !Number.isFinite(reference)) return false;
  if (!Number.isFinite(maxDays) || maxDays < 0) return false;
  return reference - created > maxDays * MS_PER_DAY;
}
