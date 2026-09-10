import crypto from "node:crypto";

/** Vigencia del link de restablecimiento: 1 hora. */
export const RESET_TOKEN_TTL_MS = 60 * 60 * 1000;
export const WELCOME_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
/** No es un hash bcrypt: una cuenta invitada no admite login hasta crear su clave. */
export const PENDING_PASSWORD_HASH = "!pending-restaurant-welcome";

/** Token aleatorio que viaja en el link del correo (64 hex chars). */
export function generateResetToken(): string {
  return crypto.randomBytes(32).toString("hex");
}

/** En DB solo se guarda el hash — un leak de la tabla no expone tokens. */
export function hashResetToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}
