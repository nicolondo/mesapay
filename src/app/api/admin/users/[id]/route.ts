import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { db } from "@/lib/db";

/**
 * Delete a user. Platform-admin-only. We do not allow an admin to delete
 * their own account through this endpoint — that would be a foot-gun.
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
  await db.user.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}
