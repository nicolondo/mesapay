import { secureApi } from "@/lib/secureApi";
import { NextResponse, after } from "next/server";
import { getLocale } from "next-intl/server";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { auth, signIn } from "@/auth";
import { db } from "@/lib/db";
import { rateLimit } from "@/lib/rateLimit";
import { recordAuditEvent } from "@/lib/auditLog";
import { canStaffSignIn } from "@/lib/staffLogin";
import { sendPasswordChangedEmail } from "@/lib/mailer";
import { PASSWORD_MAX, PASSWORD_MIN } from "@/lib/passwordPolicy";

/** Intentos por usuario (aciertos incluidos) en la ventana. */
const CHANGE_LIMIT = 5;
const CHANGE_WINDOW_SECONDS = 15 * 60;

const schema = z.object({
  currentPassword: z.string().min(1).max(200),
  newPassword: z.string().max(10_000),
});

const fail = (error: string, status = 400) =>
  NextResponse.json({ error }, { status });

/**
 * POST /api/auth/password — "Cambiar mi contraseña" de cualquier usuario del
 * personal con sesión (empezando por el platform_admin).
 *
 * Sesiones: el JWT de Auth.js lleva `sessionVersion` y el callback `jwt` de
 * `src/auth.ts` lo compara contra `User.sessionVersion` en cada request. Al
 * cambiar `passwordHash` el trigger `revoke_sessions` lo sube (y acá también
 * se incrementa explícito, por si el trigger faltara), así que TODAS las
 * sesiones abiertas del usuario mueren — incluida la actual. Para no sacar a
 * quien acaba de cambiarla, la ruta vuelve a iniciar sesión en el servidor
 * con la contraseña nueva (`signIn("credentials")` de Auth.js, que deja la
 * cookie nueva en esta misma respuesta). Si ese re-login fallara, responde
 * `sessionKept: false` y la pantalla manda al login con un aviso.
 */
async function POSTHandler(req: Request) {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) return fail("unauthorized", 401);

  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return fail("invalid");
  const { currentPassword, newPassword } = parsed.data;
  if (newPassword.length < PASSWORD_MIN) return fail("new_password_too_short");
  if (newPassword.length > PASSWORD_MAX) return fail("new_password_too_long");

  // Antes de comparar la actual: frena la adivinanza con una sesión robada.
  if (!(await rateLimit(`password-change:${userId}`, CHANGE_LIMIT, CHANGE_WINDOW_SECONDS))) {
    const res = fail("rate_limited", 429);
    res.headers.set("Retry-After", String(CHANGE_WINDOW_SECONDS));
    return res;
  }

  const user = await db.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      email: true,
      name: true,
      role: true,
      restaurantId: true,
      passwordHash: true,
      disabledAt: true,
    },
  });
  if (!user || !canStaffSignIn(user) || user.passwordHash.startsWith("!pending-")) {
    return fail("unauthorized", 401);
  }

  if (!(await bcrypt.compare(currentPassword, user.passwordHash))) {
    return fail("wrong_current_password");
  }
  if (newPassword === currentPassword) return fail("same_password");

  const passwordHash = await bcrypt.hash(newPassword, 10);
  const now = new Date();
  const changed = await db.$transaction(async (tx) => {
    // Sólo si nadie la cambió entre la lectura y ahora (otra pestaña, un
    // enlace de restablecimiento): nunca pisar un cambio concurrente.
    const updated = await tx.user.updateMany({
      where: { id: user.id, passwordHash: user.passwordHash },
      data: { passwordHash, sessionVersion: { increment: 1 } },
    });
    if (!updated.count) return false;
    // Un enlace de restablecimiento pendiente ya no debe servir.
    await tx.passwordResetToken.updateMany({
      where: { userId: user.id, usedAt: null },
      data: { usedAt: now },
    });
    return true;
  });
  if (!changed) return fail("operation_conflict", 409);

  // Actor explícito: después del cambio, `auth()` ya no reconoce la cookie
  // vieja de este request y el evento quedaría como "system".
  await recordAuditEvent({
    kind: "user.password_change",
    restaurantId: user.restaurantId ?? null,
    target: { type: "user", id: user.id },
    summary: `Cambió su propia contraseña (${user.email})`,
    actor: { userId: user.id, email: user.email, role: user.role },
  });

  let sessionKept = false;
  try {
    await signIn("credentials", {
      email: user.email,
      password: newPassword,
      redirect: false,
    });
    sessionKept = true;
  } catch {
    console.warn("[password] re-login after change failed", { userId: user.id });
  }

  const locale = await getLocale().catch(() => null);
  after(async () => {
    const ok = await sendPasswordChangedEmail(
      { email: user.email, name: user.name },
      locale,
    ).catch(() => false);
    if (!ok) console.warn("[password] change notice not sent", { userId: user.id });
  });

  return NextResponse.json({ ok: true, sessionKept });
}

export const POST = secureApi(POSTHandler);
