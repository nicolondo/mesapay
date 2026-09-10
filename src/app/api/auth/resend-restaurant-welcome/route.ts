import { NextResponse } from "next/server";
import { getLocale } from "next-intl/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { secureApi } from "@/lib/secureApi";
import { rateLimit } from "@/lib/rateLimit";
import {
  PENDING_PASSWORD_HASH,
  generateResetToken,
  hashResetToken,
  WELCOME_TOKEN_TTL_MS,
} from "@/lib/passwordReset";
import { sendRestaurantWelcomeEmail } from "@/lib/mailer";

export const POST = secureApi(async (req: Request) => {
  const parsed = z
    .object({ email: z.string().trim().email().max(254) })
    .safeParse(await req.json().catch(() => null));
  if (!parsed.success)
    return NextResponse.json({ error: "invalid" }, { status: 400 });
  const email = parsed.data.email.toLowerCase();
  if (!(await rateLimit(`welcome:${email}`, 3, 900)))
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  const user = await db.user.findUnique({
    where: { email },
    select: {
      id: true,
      name: true,
      email: true,
      role: true,
      passwordHash: true,
      disabledAt: true,
      restaurant: { select: { name: true } },
    },
  });
  if (
    user?.role === "operator" &&
    user.passwordHash === PENDING_PASSWORD_HASH &&
    !user.disabledAt &&
    user.restaurant
  ) {
    const token = generateResetToken();
    const issued = await db.$transaction(async (tx) => {
      const pending = await tx.user.updateMany({
        where: { id: user.id, passwordHash: PENDING_PASSWORD_HASH },
        data: { passwordHash: PENDING_PASSWORD_HASH },
      });
      if (!pending.count) return false;
      await tx.passwordResetToken.create({
        data: {
          userId: user.id,
          tokenHash: hashResetToken(token),
          expiresAt: new Date(Date.now() + WELCOME_TOKEN_TTL_MS),
        },
      });
      return true;
    });
    // No revocar enlaces anteriores por un reenvío: todos caducan al crear la clave.
    const sent =
      !issued ||
      (await sendRestaurantWelcomeEmail(
        user,
        user.restaurant.name,
        token,
        await getLocale(),
      ));
    if (!sent) console.error("[welcome] resend delivery pending");
  }
  // Respuesta idéntica para cuentas inexistentes, activadas o invitadas.
  return NextResponse.json({ ok: true });
});
