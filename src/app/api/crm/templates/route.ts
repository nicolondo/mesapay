import { NextResponse } from "next/server";
import { z } from "zod";
import { getCrmContext } from "@/lib/crm/access";
import { db } from "@/lib/db";

const CreateSchema = z.object({
  name: z.string().min(1),
  subject: z.string().min(1),
  bodyHtml: z.string().min(1),
  attachmentIds: z.array(z.string()).default([]),
  scope: z.enum(["global", "user"]).default("user"),
});

export async function GET() {
  const ctx = await getCrmContext();
  if (!ctx) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const templates = await db.crmEmailTemplate.findMany({
    where: {
      OR: [
        { scope: "global" },
        { scope: "user", ownerUserId: ctx.userId },
      ],
    },
    orderBy: { createdAt: "desc" },
  });

  return NextResponse.json({ templates });
}

export async function POST(req: Request) {
  const ctx = await getCrmContext();
  if (!ctx) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const body = await req.json().catch(() => null);
  const parsed = CreateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "validation_error", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const { name, subject, bodyHtml, attachmentIds, scope } = parsed.data;

  // Only platform_admin can create global templates
  const effectiveScope =
    scope === "global" && ctx.role === "platform_admin" ? "global" : "user";

  // Validate that attachmentIds exist and are visible to this user
  if (attachmentIds.length > 0) {
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

  const template = await db.crmEmailTemplate.create({
    data: {
      name,
      subject,
      bodyHtml,
      attachmentIds,
      scope: effectiveScope,
      ownerUserId: effectiveScope === "user" ? ctx.userId : null,
    },
  });

  return NextResponse.json({ template }, { status: 201 });
}
