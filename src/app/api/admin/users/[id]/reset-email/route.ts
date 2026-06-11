import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { recordAuditEvent } from "@/lib/auditLog";
import { sendPasswordResetEmail } from "@/lib/mailer";
import {
  generateResetToken,
  hashResetToken,
  RESET_TOKEN_TTL_MS,
} from "@/lib/passwordReset";

const BASE_URL = process.env.NEXTAUTH_URL ?? "https://mesapay.co";

/**
 * POST /api/admin/users/[id]/reset-email — sends a password-reset link.
 * platform_admin only. El link es de un solo uso y vence en 1 hora.
 */
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session?.user || session.user.role !== "platform_admin") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const { id } = await params;
  const user = await db.user.findUnique({
    where: { id },
    select: { id: true, email: true, name: true, role: true },
  });
  if (!user) return NextResponse.json({ error: "not_found" }, { status: 404 });

  if (user.role === "platform_admin" && user.id !== session.user.id) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const token = generateResetToken();
  await db.$transaction([
    // Invalida cualquier link anterior aún activo del mismo usuario.
    db.passwordResetToken.updateMany({
      where: { userId: id, usedAt: null },
      data: { usedAt: new Date() },
    }),
    db.passwordResetToken.create({
      data: {
        tokenHash: hashResetToken(token),
        userId: id,
        expiresAt: new Date(Date.now() + RESET_TOKEN_TTL_MS),
      },
    }),
  ]);

  const resetUrl = `${BASE_URL}/restablecer/${token}`;
  const sent = await sendPasswordResetEmail(
    { email: user.email, name: user.name },
    resetUrl,
  );

  await recordAuditEvent({
    kind: "user.reset_email",
    restaurantId: null,
    target: { type: "user", id },
    summary: `Envió restablecimiento de contraseña a ${user.email}`,
  });

  return NextResponse.json({ ok: true, sent });
}
