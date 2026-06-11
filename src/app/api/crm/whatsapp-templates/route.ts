import { NextResponse } from "next/server";
import { z } from "zod";
import { getCrmContext } from "@/lib/crm/access";
import { db } from "@/lib/db";

const CreateSchema = z.object({
  name: z.string().min(1),
  body: z.string().min(1),
  scope: z.enum(["global", "user"]).default("user"),
});

export async function GET() {
  const ctx = await getCrmContext();
  if (!ctx) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const templates = await db.crmWhatsappTemplate.findMany({
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

  // Only platform_admin can create global templates
  const effectiveScope =
    parsed.data.scope === "global" && ctx.role === "platform_admin"
      ? "global"
      : "user";

  const template = await db.crmWhatsappTemplate.create({
    data: {
      name: parsed.data.name,
      body: parsed.data.body,
      scope: effectiveScope,
      ownerUserId: effectiveScope === "user" ? ctx.userId : null,
    },
  });

  return NextResponse.json({ template }, { status: 201 });
}
