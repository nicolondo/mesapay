import { NextResponse } from "next/server";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { recordAuditEvent } from "@/lib/auditLog";

const schema = z.object({
  password: z.string().min(8).max(100),
});

/**
 * POST /api/admin/users/[id]/password — set a user's password directly.
 * platform_admin only. No permite tocar a otros platform_admin.
 */
export async function POST(
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

  if (user.role === "platform_admin" && user.id !== session.user.id) {
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

  const password = await bcrypt.hash(parsed.data.password, 10);
  await db.user.update({ where: { id }, data: { password } });

  await recordAuditEvent({
    kind: "user.password_set",
    restaurantId: null,
    target: { type: "user", id },
    summary: `Cambió la contraseña de ${user.email}`,
  });

  return NextResponse.json({ ok: true });
}
