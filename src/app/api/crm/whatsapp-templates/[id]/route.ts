import { NextResponse } from "next/server";
import { z } from "zod";
import { getCrmContext } from "@/lib/crm/access";
import { db } from "@/lib/db";

const PatchSchema = z.object({
  name: z.string().min(1).optional(),
  body: z.string().min(1).optional(),
  scope: z.enum(["global", "user"]).optional(),
});

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const ctx = await getCrmContext();
  if (!ctx) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const { id } = await params;

  const template = await db.crmWhatsappTemplate.findUnique({ where: { id } });
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

  const reqBody = await req.json().catch(() => null);
  const parsed = PatchSchema.safeParse(reqBody);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "validation_error", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const { name, body, scope } = parsed.data;
  const effectiveScope =
    scope === "global" && ctx.role === "platform_admin" ? "global" : undefined;

  const updated = await db.crmWhatsappTemplate.update({
    where: { id },
    data: {
      ...(name !== undefined ? { name } : {}),
      ...(body !== undefined ? { body } : {}),
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

  const template = await db.crmWhatsappTemplate.findUnique({ where: { id } });
  if (!template) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const canDelete =
    ctx.role === "platform_admin" ||
    (template.scope === "user" && template.ownerUserId === ctx.userId);
  if (!canDelete) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  await db.crmWhatsappTemplate.delete({ where: { id } });

  return NextResponse.json({ ok: true });
}
