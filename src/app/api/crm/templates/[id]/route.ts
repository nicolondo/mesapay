import { NextResponse } from "next/server";
import { z } from "zod";
import { getCrmContext } from "@/lib/crm/access";
import { db } from "@/lib/db";

const PatchSchema = z.object({
  name: z.string().min(1).optional(),
  subject: z.string().min(1).optional(),
  bodyHtml: z.string().min(1).optional(),
  attachmentIds: z.array(z.string()).optional(),
  scope: z.enum(["global", "user"]).optional(),
});

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const ctx = await getCrmContext();
  if (!ctx) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const { id } = await params;

  const template = await db.crmEmailTemplate.findUnique({ where: { id } });
  if (!template) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  // Can only edit own templates or global ones if admin
  const canEdit =
    ctx.role === "platform_admin" ||
    (template.scope === "user" && template.ownerUserId === ctx.userId);
  if (!canEdit) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const body = await req.json().catch(() => null);
  const parsed = PatchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "validation_error", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const { name, subject, bodyHtml, attachmentIds, scope } = parsed.data;

  // Validate attachmentIds visibility
  if (attachmentIds && attachmentIds.length > 0) {
    const docs = await db.crmDocument.findMany({
      where: {
        id: { in: attachmentIds },
        OR: [
          { scope: "global" },
          { scope: "user", ownerUserId: ctx.userId },
        ],
      },
      select: { id: true },
    });
    if (docs.length !== attachmentIds.length) {
      return NextResponse.json(
        { error: "invalid_attachment_ids" },
        { status: 400 },
      );
    }
  }

  const effectiveScope =
    scope === "global" && ctx.role === "platform_admin" ? "global" : undefined;

  const updated = await db.crmEmailTemplate.update({
    where: { id },
    data: {
      ...(name !== undefined ? { name } : {}),
      ...(subject !== undefined ? { subject } : {}),
      ...(bodyHtml !== undefined ? { bodyHtml } : {}),
      ...(attachmentIds !== undefined ? { attachmentIds } : {}),
      ...(effectiveScope !== undefined ? { scope: effectiveScope } : {}),
    },
  });

  return NextResponse.json({ template: updated });
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const ctx = await getCrmContext();
  if (!ctx) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const { id } = await params;

  const template = await db.crmEmailTemplate.findUnique({ where: { id } });
  if (!template) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const canDelete =
    ctx.role === "platform_admin" ||
    (template.scope === "user" && template.ownerUserId === ctx.userId);
  if (!canDelete) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  await db.crmEmailTemplate.delete({ where: { id } });

  return NextResponse.json({ ok: true });
}
