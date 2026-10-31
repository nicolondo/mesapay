import { db } from "./db";
import { sendPasswordResetEmail, sendRestaurantWelcomeEmail } from "./mailer";
import {
  generateResetToken,
  hashResetToken,
  PENDING_PASSWORD_HASH,
  RESET_TOKEN_TTL_MS,
  WELCOME_TOKEN_TTL_MS,
} from "./passwordReset";

const BASE_URL = process.env.NEXTAUTH_URL ?? "https://mesapay.co";

export type ResetLinkUser = {
  id: string;
  email: string;
  name: string | null;
  passwordHash: string;
  restaurant: { name: string } | null;
};

/**
 * Emite un enlace de restablecimiento para un usuario del PERSONAL y lo manda
 * por correo. Es el mecanismo único que usan el admin ("enviar reset por
 * correo") y el "olvidé mi contraseña" público:
 *
 *   - Token aleatorio de 32 bytes; en la base sólo queda su SHA-256.
 *   - Un solo uso; vence en 1 hora (24 h si es la bienvenida de un dueño de
 *     comercio que todavía no creó su clave).
 *   - Emitir uno nuevo invalida TODOS los pendientes del usuario. La fila del
 *     usuario se bloquea (`FOR UPDATE`) para que dos pedidos simultáneos no
 *     dejen dos enlaces vivos.
 *
 * Nunca loguea el token ni la URL. Devuelve si el correo salió.
 */
export async function issuePasswordResetLink(
  user: ResetLinkUser,
  opts: { locale?: string | null } = {},
): Promise<{ sent: boolean; welcome: boolean }> {
  const token = generateResetToken();
  const welcome =
    user.passwordHash === PENDING_PASSWORD_HASH && !!user.restaurant;
  const now = new Date();
  await db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${user.id} FOR UPDATE`;
    // Invalida cualquier enlace anterior aún activo del mismo usuario.
    await tx.passwordResetToken.updateMany({
      where: { userId: user.id, usedAt: null },
      data: { usedAt: now },
    });
    await tx.passwordResetToken.create({
      data: {
        tokenHash: hashResetToken(token),
        userId: user.id,
        expiresAt: new Date(
          now.getTime() + (welcome ? WELCOME_TOKEN_TTL_MS : RESET_TOKEN_TTL_MS),
        ),
      },
    });
  });

  const sent = welcome
    ? await sendRestaurantWelcomeEmail(
        user,
        user.restaurant!.name,
        token,
        opts.locale,
      )
    : await sendPasswordResetEmail(
        { email: user.email, name: user.name },
        `${BASE_URL}/restablecer/${token}`,
        opts.locale,
      );
  return { sent, welcome };
}
