/**
 * El Business-Code del Cloud Terminal de Kushki: la clave con la que se
 * firma (HMAC) y se cifra cada cobro al datáfono (ver kushki/cloudTerminal.ts).
 * Lo entrega Kushki para el datáfono; NO es el Merchant ID ni la llave
 * pública del comercio.
 *
 * Son y Melona, 2026-10-31: el campo decía "Código de comercio" y quedó
 * guardado el Merchant ID (32 hex, idéntico a `kushkiMerchantId`), así que
 * `cloudt` respondía `CLOUDPAYMENT_VALIDATION_ERROR` a cada cobro.
 *
 * Archivo sin dependencias de servidor: lo usan la ruta, la página y los tests.
 */

export type BusinessCodeProblem = "business_code_is_merchant_id" | "business_code_is_public_key";

const same = (a: string, b: string | null | undefined) => !!b && a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * ¿Este valor es en realidad otra credencial de Kushki del comercio? null si
 * no lo parece. Compara sin mayúsculas ni espacios.
 */
export function businessCodeProblem(
  code: string | null | undefined,
  credentials: { kushkiMerchantId?: string | null; kushkiPublicKey?: string | null },
): BusinessCodeProblem | null {
  if (!code || !code.trim()) return null;
  if (same(code, credentials.kushkiMerchantId)) return "business_code_is_merchant_id";
  if (same(code, credentials.kushkiPublicKey)) return "business_code_is_public_key";
  return null;
}

/**
 * Lo que la pantalla puede mostrar de un Business-Code guardado: sólo los
 * últimos 4 caracteres. Es una clave: nunca se manda entera al navegador.
 */
export function maskBusinessCode(code: string | null | undefined): string | null {
  const v = code?.trim();
  if (!v) return null;
  return v.length <= 4 ? "••••" : `••••${v.slice(-4)}`;
}
