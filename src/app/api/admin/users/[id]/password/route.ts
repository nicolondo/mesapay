import { secureApi } from "@/lib/secureApi";
import { NextResponse } from "next/server";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { recordAuditEvent } from "@/lib/auditLog";
import { PASSWORD_MAX, PASSWORD_MIN } from "@/lib/passwordPolicy";

const schema = z.object({
  password: z.string().min(PASSWORD_MIN).max(PASSWORD_MAX),
});

/**
 * POST /api/admin/users/[id]/password — set a user's password directly.
 * platform_admin only. No permite tocar a otros platform_admin NI la propia:
 * el admin cambia la suya en /admin/cuenta (`POST /api/auth/password`), que
 * exige la contraseña actual. Así una sesión de admin robada no alcanza para
 * quedarse con la cuenta.
 */
async function POSTHandler(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session?.user || session.user.role !== "platform_admin") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const { id } = await params;
  const user = await db.user.findUnique({
    where: { id },
    select: { id: true, email: true, role: true },
  });
  if (!user) return NextResponse.json({ error: "not_found" }, { status: 404 });

  if (user.id === session.user.id) {
    return NextResponse.json({ error: "use_self_service" }, { status: 403 });
  }
  if (user.role === "platform_admin") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const body = await req.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "validation_error", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const passwordHash = await bcrypt.hash(parsed.data.password, 10);
  // sessionVersion: cierra las sesiones del usuario (el trigger
  // `revoke_sessions` hace lo mismo; acá queda explícito).
  await db.user.update({
    where: { id },
    data: { passwordHash, sessionVersion: { increment: 1 } },
  });

  await recordAuditEvent({
    kind: "user.password_set",
    restaurantId: null,
    target: { type: "user", id },
    summary: `Cambió la contraseña de ${user.email}`,
  });

  return NextResponse.json({ ok: true });
}

export const POST = secureApi(POSTHandler);
