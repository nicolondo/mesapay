/**
 * Enlace de acceso directo ("magic link") para el comensal.
 *
 * Lo que vence es el ENLACE, no la sesión. El token dura 20 minutos y es de
 * un solo uso; pero una vez canjeado crea una DinerSession permanente —
 * o sea, el comensal toca el enlace del correo una vez y no vuelve a ver un
 * login nunca más.
 *
 * El enlace es DEL COMERCIO que lo emitió: el token cuelga de un `Diner`,
 * que pertenece a un solo restaurante, y la URL de canje vive bajo
 * `/t/[slug]/cuenta/enlace/[token]`. Un enlace emitido por el restaurante A
 * abierto en la URL del B no abre nada.
 *
 * Igual que en `passwordReset.ts`, en DB solo vive el SHA-256: el token
 * plano existe únicamente dentro del correo.
 */

import crypto from "node:crypto";

/**
 * 20 minutos. Corto a propósito: un enlace de acceso sin contraseña que
 * quede vivo en una bandeja de entrada por días es una llave suelta.
 */
export const MAGIC_LINK_TTL_MS = 20 * 60 * 1000;

export function generateMagicLinkToken(): string {
  return crypto.randomBytes(32).toString("hex");
}

export function hashMagicLinkToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

/**
 * Un token sirve si existe, no se usó y no venció. Función pura para poder
 * probar la lógica de vigencia sin DB.
 */
export function isMagicLinkUsable(
  record: { usedAt: Date | null; expiresAt: Date } | null | undefined,
  now: Date = new Date(),
): boolean {
  if (!record) return false;
  if (record.usedAt) return false;
  return record.expiresAt.getTime() > now.getTime();
}
