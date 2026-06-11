import { NextResponse } from "next/server";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { recordAuditEvent } from "@/lib/auditLog";

const patchSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  email: z.string().email().transform((s) => s.toLowerCase().trim()).optional(),
  password: z.string().min(8).max(100).optional(),
  commissionBps: z.number().int().min(0).max(5000).nullable().optional(),
  disabled: z.boolean().optional(),
}).refine(
  (d) =>
    d.name !== undefined ||
    d.email !== undefined ||
    d.password !== undefined ||
    d.commissionBps !== undefined ||
    d.disabled !== undefined,
  { message: "at_least_one_field" },
);

/**
 * PATCH /api/admin/users/[id]
 * Edit or disable/reactivate a comercial. platform_admin only.
 * Only allowed when target user role === "comercial".
 */
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session?.user || session.user.role !== "platform_admin") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const { id } = await params;
  const user = await db.user.findUnique({ where: { id } });
  if (!user) return NextResponse.json({ error: "not_found" }, { status: 404 });

  // Only comerciales may be edited through this endpoint.
  if (user.role !== "comercial") {
    return NextResponse.json({ error: "only_comercial" }, { status: 403 });
  }

  const body = await req.json().catch(() => null);
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const { name, email, password, commissionBps, disabled } = parsed.data;

  // Build update data.
  const data: Record<string, unknown> = {};
  if (name !== undefined) data.name = name;
  if (email !== undefined) data.email = email;
  if (password !== undefined) data.passwordHash = await bcrypt.hash(password, 10);
  if (commissionBps !== undefined) data.commissionBps = commissionBps;
  if (disabled !== undefined) {
    if (disabled) {
      // Keep existing disabledAt if already set (idempotent).
      data.disabledAt = user.disabledAt ?? new Date();
    } else {
      data.disabledAt = null;
    }
  }

  // Determine audit kind.
  let auditKind: string;
  if (disabled === true) {
    auditKind = "comercial.disable";
  } else if (disabled === false) {
    auditKind = "comercial.enable";
  } else {
    auditKind = "comercial.update";
  }

  // Build diff for audit.
  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};
  if (name !== undefined) { before.name = user.name; after.name = name; }
  if (email !== undefined) { before.email = user.email; after.email = email; }
  if (password !== undefined) { after.password = "(changed)"; }
  if (commissionBps !== undefined) { before.commissionBps = user.commissionBps; after.commissionBps = commissionBps; }
  if (disabled !== undefined) { before.disabledAt = user.disabledAt; after.disabledAt = data.disabledAt; }

  try {
    const updated = await db.user.update({
      where: { id },
      data,
      select: {
        id: true,
        email: true,
        name: true,
        commissionBps: true,
        disabledAt: true,
      },
    });

    await recordAuditEvent({
      kind: auditKind,
      restaurantId: null,
      target: { type: "user", id },
      summary: `${auditKind === "comercial.disable" ? "Desactivó" : auditKind === "comercial.enable" ? "Reactivó" : "Editó"} comercial ${user.email}`,
      diff: { before, after },
    });

    return NextResponse.json({ ok: true, user: updated });
  } catch (err: unknown) {
    // P2002 = unique constraint (email already taken).
    if (
      typeof err === "object" &&
      err !== null &&
      "code" in err &&
      (err as { code: string }).code === "P2002"
    ) {
      return NextResponse.json({ error: "email_taken" }, { status: 409 });
    }
    throw err;
  }
}

/**
 * DELETE /api/admin/users/[id]
 * Delete a user. Platform-admin-only.
 * For role=comercial: only allowed when they have zero CommissionEntry rows.
 * Cannot delete your own account.
 */
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session?.user || session.user.role !== "platform_admin") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const { id } = await params;
  if (id === session.user.id) {
    return NextResponse.json({ error: "cannot_delete_self" }, { status: 400 });
  }
  const user = await db.user.findUnique({ where: { id } });
  if (!user) return NextResponse.json({ error: "not_found" }, { status: 404 });

  // Guard: comercial with commission history must not be hard-deleted.
  if (user.role === "comercial") {
    const count = await db.commissionEntry.count({
      where: { salesRepUserId: id },
    });
    if (count > 0) {
      return NextResponse.json({ error: "has_commissions" }, { status: 409 });
    }
    // Explicitly clear restaurant assignments (onDelete SetNull handles it in
    // Prisma cascade, but explicit is fine and avoids any race).
    await db.restaurant.updateMany({
      where: { salesRepUserId: id },
      data: { salesRepUserId: null },
    });
  }

  await db.user.delete({ where: { id } });

  if (user.role === "comercial") {
    await recordAuditEvent({
      kind: "comercial.delete",
      restaurantId: null,
      target: { type: "user", id },
      summary: `Eliminó comercial ${user.email}`,
    });
  }

  return NextResponse.json({ ok: true });
}
