import { secureApi } from "@/lib/secureApi";
import { NextResponse } from "next/server";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { db } from "@/lib/db";
import { hashResetToken } from "@/lib/passwordReset";

const schema = z.object({
  token: z.string().min(32).max(128),
  password: z.string().min(8).max(100),
});

/**
 * POST /api/auth/reset-password — público. Canjea un token de
 * restablecimiento (un solo uso, 1 h) por una contraseña nueva.
 * Respuesta genérica para no revelar si el token existe.
 */
async function POSTHandler(req: Request) {
  const body = await req.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid" }, { status: 400 });
  }

  const tokenHash = hashResetToken(parsed.data.token);
  const record = await db.passwordResetToken.findUnique({
    where: { tokenHash },
    select: {
      id: true,
      userId: true,
      usedAt: true,
      expiresAt: true,
      user: { select: { passwordHash: true } },
    },
  });

  if (!record || record.usedAt || record.expiresAt < new Date()) {
    return NextResponse.json({ error: "invalid" }, { status: 400 });
  }

  const passwordHash = await bcrypt.hash(parsed.data.password, 10);
  const changed = await db
    .$transaction(async (tx) => {
      // Bloqueo por usuario antes que por token: dos enlaces distintos no pueden
      // cambiar la contraseña a la vez ni dejar reutilizable un enlace anterior.
      const user = await tx.user.updateMany({
        where: { id: record.userId, passwordHash: record.user.passwordHash },
        data: { passwordHash },
      });
      if (!user.count) return false;
      const claim = await tx.passwordResetToken.updateMany({
        where: { id: record.id, usedAt: null, expiresAt: { gt: new Date() } },
        data: { usedAt: new Date() },
      });
      if (!claim.count) throw new Error("password_token_expired");
      await tx.passwordResetToken.updateMany({
        where: { userId: record.userId, usedAt: null },
        data: { usedAt: new Date() },
      });
      return true;
    })
    .catch((error) => {
      if (error instanceof Error && error.message === "password_token_expired")
        return false;
      throw error;
    });
  if (!changed) return NextResponse.json({ error: "invalid" }, { status: 400 });

  return NextResponse.json({ ok: true });
}

export const POST = secureApi(POSTHandler);
