import type { KushkiMode } from "../../platformConfig";
import { kushkiFetch } from "./client";
import {
  buildTransferConfigRequest,
  parseTransferConfigResponse,
  selectPseProcessor,
  type TransferConfig,
  type TransferProcessor,
} from "./breB";

/**
 * Config de «Transfer In» de un comercio de Kushki
 * (`GET /transfer/v1/config?paymentType=PAYMENT`, con la llave pública):
 * qué procesadores de transferencia tiene (PSE, Bre-B…). Es el punto de
 * partida obligatorio de Bre-B —el nombre y el canal del procesador se
 * copian de acá al token— y lo que dice si un comercio está en modo
 * multiprocesador.
 *
 * Caché corta en memoria por (modo, llave pública): la config casi nunca
 * cambia, pero cuando Kushki habilita Bre-B a un comercio no puede tardar
 * una hora en verse. Un init que responde E046 (el token no es del
 * procesador resuelto) la invalida.
 */

const TTL_MS = 5 * 60_000;
const cache = new Map<string, { at: number; config: TransferConfig }>();
const cacheKey = (mode: KushkiMode, publicKey: string) => `${mode}:${publicKey}`;

export async function getTransferConfig(
  mode: Exclude<KushkiMode, "mock">,
  publicKey: string,
  opts: { fresh?: boolean } = {},
): Promise<TransferConfig> {
  const key = cacheKey(mode, publicKey);
  const hit = cache.get(key);
  if (!opts.fresh && hit && Date.now() - hit.at < TTL_MS) return hit.config;
  const request = buildTransferConfigRequest();
  const config = parseTransferConfigResponse(
    await kushkiFetch<unknown>(request.path, {
      method: request.method,
      auth: { kind: "submerchant_public", publicKey },
      mode,
      retries: 1,
    }),
  );
  cache.set(key, { at: Date.now(), config });
  return config;
}

export function invalidateTransferConfig(mode: KushkiMode, publicKey: string): void {
  cache.delete(cacheKey(mode, publicKey));
}

/** Sólo para los tests: la caché es del proceso. */
export function clearTransferConfigCache(): void {
  cache.clear();
}

/**
 * El `processor` que tiene que llevar un token de PSE, o null si no lleva
 * ninguno (lo normal: un comercio con PSE como único procesador).
 *
 * Sólo en modo multiprocesador —el MISMO comercio con PSE y Bre-B— Kushki
 * exige `processor` en todo token. Si la config no se puede leer, se
 * devuelve null: el token sale como siempre y PSE no se rompe porque el
 * endpoint de config no responda.
 */
export async function pseProcessorFor(
  mode: Exclude<KushkiMode, "mock">,
  publicKey: string,
  opts: { fresh?: boolean } = {},
): Promise<TransferProcessor | null> {
  try {
    return selectPseProcessor(await getTransferConfig(mode, publicKey, opts));
  } catch (err) {
    console.warn("[kushki/transfer-config] no se pudo leer la config", err instanceof Error ? err.name : "unknown");
    return null;
  }
}
