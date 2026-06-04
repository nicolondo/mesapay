/**
 * Configuración global de plataforma — singleton en DB editable desde
 * /admin. Hoy expone sólo el modo Kushki (mock/sandbox/production); el
 * patrón está pensado para sumar otros toggles plataforma-wide sin
 * tener que tocar env vars + redeploy.
 *
 * Cache in-memory por proceso (TTL 60s) para que cada llamada no le
 * pegue a la DB. Bounded staleness: si el admin cambia el modo, otros
 * procesos del blue/green deploy lo ven dentro de 60s. setKushkiMode()
 * actualiza el cache local de inmediato (process that handles the
 * write) y persiste a DB para los demás.
 *
 * Fallbacks (en este orden):
 *   1. Cache válido → return
 *   2. DB singleton → save to cache, return
 *   3. DB error / valor inválido → env.KUSHKI_MODE
 *   4. env vacío → "mock"
 */

import { db } from "./db";
import { env } from "./env";

export type KushkiMode = "mock" | "sandbox" | "production";

const VALID: readonly KushkiMode[] = ["mock", "sandbox", "production"];

function isValidMode(s: string | undefined | null): s is KushkiMode {
  return s != null && (VALID as readonly string[]).includes(s);
}

// Estado del cache. currentMode arranca con env para que las primeras
// llamadas sync funcionen antes del primer warm.
let currentMode: KushkiMode = env.KUSHKI_MODE;
let warmedAt = 0;
const CACHE_TTL_MS = 60_000;

async function refreshFromDb(): Promise<void> {
  try {
    const row = await db.platformConfig.findUnique({
      where: { id: "singleton" },
    });
    if (row && isValidMode(row.kushkiMode)) {
      currentMode = row.kushkiMode;
    }
    warmedAt = Date.now();
  } catch (err) {
    // Si la DB falla, dejamos el cache previo. No queremos romper el
    // app por un problema transitorio leyendo platform_config.
    console.error("[platformConfig] refresh failed:", err);
    warmedAt = Date.now(); // evitar reintento inmediato
  }
}

/**
 * Versión async — refresca el cache si está stale. Preferida en
 * server-side routes / server components. La primera invocación de
 * cada proceso warmea el cache.
 */
export async function getKushkiMode(): Promise<KushkiMode> {
  if (Date.now() - warmedAt > CACHE_TTL_MS) {
    await refreshFromDb();
  }
  return currentMode;
}

/**
 * Versión sync — usa el valor cacheado. Para paths que no pueden
 * volverse async (ej. helpers utilitarios profundos). El cache se
 * warmea naturalmente cuando algún path async lo invoca antes; si
 * nadie lo hizo en este proceso, devuelve el fallback de env.
 */
export function getKushkiModeSync(): KushkiMode {
  return currentMode;
}

/**
 * Setea el modo. Persiste a DB + actualiza cache local. Otros procesos
 * verán el cambio dentro de CACHE_TTL_MS (60s).
 */
export async function setKushkiMode(
  mode: KushkiMode,
  actorUserId: string | null = null,
): Promise<void> {
  await db.platformConfig.upsert({
    where: { id: "singleton" },
    create: {
      id: "singleton",
      kushkiMode: mode,
      updatedById: actorUserId,
    },
    update: {
      kushkiMode: mode,
      updatedById: actorUserId,
    },
  });
  currentMode = mode;
  warmedAt = Date.now();
}

/** Forzar refresh manual (testing / debugging). */
export async function invalidateKushkiModeCache(): Promise<void> {
  warmedAt = 0;
  await refreshFromDb();
}

/**
 * Resuelve el modo EFECTIVO de un comercio: si tiene un override propio
 * (Restaurant.kushkiMode) válido lo usa; si no, hereda el global. Es la
 * forma canónica de leer el modo en cualquier path que tenga el comercio
 * en scope (charges, datáfono, SDK del browser). Sin override → idéntico
 * a getKushkiMode().
 */
export async function getRestaurantKushkiMode(
  restaurant: { kushkiMode?: string | null } | null | undefined,
): Promise<KushkiMode> {
  const override = restaurant?.kushkiMode;
  if (isValidMode(override)) return override;
  return getKushkiMode();
}

/**
 * Variante pura/sync: aplica el override del comercio sobre un modo global
 * ya conocido. Útil cuando ya tenés el global en mano y no querés otro await.
 */
export function resolveKushkiMode(
  override: string | null | undefined,
  globalMode: KushkiMode,
): KushkiMode {
  return isValidMode(override) ? override : globalMode;
}
