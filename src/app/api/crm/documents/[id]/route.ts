import { NextResponse } from "next/server";
import { unlink } from "fs/promises";
import path from "path";
import { getCrmContext } from "@/lib/crm/access";
import { db } from "@/lib/db";

function uploadDir() {
  const base =
    process.env.UPLOAD_DIR ?? path.join(process.cwd(), "public", "uploads");
  return path.join(base, "crm");
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const ctx = await getCrmContext();
  if (!ctx) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const { id } = await params;

  const doc = await db.crmDocument.findUnique({ where: { id } });
  if (!doc) return NextResponse.json({ error: "not_found" }, { status: 404 });

  // Platform admin can delete any; user can only delete their own.
  const canDelete =
    ctx.role === "platform_admin" ||
    (doc.scope === "user" && doc.ownerUserId === ctx.userId);

  if (!canDelete) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  await db.crmDocument.delete({ where: { id } });

  // Best-effort filesystem cleanup.
  try {
    const filename = doc.fileUrl.split("/").pop();
    if (filename) {
      await unlink(path.join(uploadDir(), filename));
    }
  } catch {
    // ignore – file may already be gone
  }

  return NextResponse.json({ ok: true });
}
