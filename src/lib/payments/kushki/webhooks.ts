import { createHmac, timingSafeEqual } from "crypto";
import { env } from "../../env";
import { getKushkiModeSync } from "../../platformConfig";

/**
 * Verify a Kushki webhook delivery. Kushki signs each webhook with an
 * HMAC-SHA256 of the raw body using the partner's webhook secret, returning
 * the digest in a header (we accept either `Kushki-Signature` or
 * `X-Kushki-Signature` to cover doc variations).
 *
 * Política por modo:
 *   - mock: bypass total (dev local + mocks)
 *   - sandbox sin secret: bypass con warning en logs — útil cuando
 *     Kushki nos da credenciales de sub-merchant antes de mandarnos
 *     el webhook signing secret. NO usar en prod
 *   - sandbox con secret: verifica firma estrictamente
 *   - production: secret OBLIGATORIO, rechaza todo lo demás
 *
 * Si `restaurantSecret` viene seteado lo usamos primero — es el secret
 * por-sub-merchant que el admin configuró en /admin. Si no, caemos al
 * `KUSHKI_WEBHOOK_SECRET` global del .env (configurado a nivel partner).
 */
export function verifyKushkiSignature(
  rawBody: string,
  headers: Headers,
  restaurantSecret?: string | null,
): { ok: true } | { ok: false; reason: string } {
  const mode = getKushkiModeSync();
  if (mode === "mock") return { ok: true };
  const secret = restaurantSecret ?? env.KUSHKI_WEBHOOK_SECRET;
  if (!secret) {
    if (mode === "sandbox") {
      // Permisivo en sandbox para destrabar testing antes de tener el
      // webhook secret. Log explícito para que no pase desapercibido
      // si alguien se olvida de setearlo después.
      console.warn(
        "[kushki/webhooks] sandbox mode without webhook secret (per-restaurant or env) — accepting webhook without verification. Set the secret before going to production.",
      );
      return { ok: true };
    }
    return { ok: false, reason: "webhook secret not configured" };
  }
  const provided =
    headers.get("kushki-signature") ?? headers.get("x-kushki-signature");
  if (!provided) {
    return { ok: false, reason: "missing signature header" };
  }
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  // timing-safe compare; lengths must match for Buffer.compare
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return { ok: false, reason: "signature mismatch" };
  if (!timingSafeEqual(a, b)) return { ok: false, reason: "signature mismatch" };
  return { ok: true };
}

function hexEq(provided: string, expected: string): boolean {
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expected, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Verificación FLEXIBLE para el webhook de transacciones reales de Kushki.
 * Kushki tiene (al menos) dos esquemas de firma según el producto:
 *   1. HMAC-SHA256(secret, rawBody) — el simple (datáfono / notificaciones).
 *   2. HMAC-SHA256(secret, body + "." + X-Kushki-Id) — el de "notifications"
 *      con timestamp (suscripciones). Probamos rawBody y JSON.stringify(parse).
 * Aceptamos si CUALQUIERA matchea. Misma política por modo que
 * verifyKushkiSignature (mock/sandbox-sin-secret bypass; producción obligatorio).
 */
export function verifyKushkiWebhookFlexible(
  rawBody: string,
  headers: Headers,
  restaurantSecret?: string | null,
): { ok: true } | { ok: false; reason: string } {
  const mode = getKushkiModeSync();
  if (mode === "mock") return { ok: true };
  const secret = restaurantSecret ?? env.KUSHKI_WEBHOOK_SECRET;
  if (!secret) {
    if (mode === "sandbox") {
      console.warn(
        "[kushki/webhooks] sandbox sin webhook secret — acepto sin verificar. Setealo antes de producción.",
      );
      return { ok: true };
    }
    return { ok: false, reason: "webhook secret not configured" };
  }
  const provided =
    headers.get("kushki-signature") ?? headers.get("x-kushki-signature");
  if (!provided) return { ok: false, reason: "missing signature header" };

  const xId = headers.get("x-kushki-id") ?? "";
  const candidates: string[] = [rawBody];
  if (xId) {
    candidates.push(`${rawBody}.${xId}`);
    try {
      candidates.push(`${JSON.stringify(JSON.parse(rawBody))}.${xId}`);
    } catch {
      /* rawBody ya se probó */
    }
  }
  for (const c of candidates) {
    const expected = createHmac("sha256", secret).update(c).digest("hex");
    if (hexEq(provided, expected)) return { ok: true };
  }
  return { ok: false, reason: "signature mismatch" };
}
