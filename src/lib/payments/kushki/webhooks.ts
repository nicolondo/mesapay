import { createHmac, timingSafeEqual } from "crypto";
import { env } from "../../env";

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
 */
export function verifyKushkiSignature(
  rawBody: string,
  headers: Headers,
): { ok: true } | { ok: false; reason: string } {
  if (env.KUSHKI_MODE === "mock") return { ok: true };
  const secret = env.KUSHKI_WEBHOOK_SECRET;
  if (!secret) {
    if (env.KUSHKI_MODE === "sandbox") {
      // Permisivo en sandbox para destrabar testing antes de tener el
      // webhook secret. Log explícito para que no pase desapercibido
      // si alguien se olvida de setearlo después.
      console.warn(
        "[kushki/webhooks] sandbox mode without KUSHKI_WEBHOOK_SECRET — accepting webhook without verification. Set the secret before going to production.",
      );
      return { ok: true };
    }
    return { ok: false, reason: "KUSHKI_WEBHOOK_SECRET not configured" };
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
