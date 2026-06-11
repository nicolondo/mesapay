import { NextResponse } from "next/server";
import { z } from "zod";
import { getCrmContext } from "@/lib/crm/access";
import { db } from "@/lib/db";

const PatchSchema = z.object({
  name: z.string().trim().min(1).max(80),
});

export async function GET() {
  const ctx = await getCrmContext();
  if (!ctx) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const user = await db.user.findUnique({
    where: { id: ctx.userId },
    select: { name: true, email: true, role: true },
  });
  if (!user) return NextResponse.json({ error: "not_found" }, { status: 404 });

  return NextResponse.json({ user });
}

export async function PATCH(req: Request) {
  const ctx = await getCrmContext();
  if (!ctx) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const body = await req.json().catch(() => null);
  const parsed = PatchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "validation_error", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const user = await db.user.update({
    where: { id: ctx.userId },
    data: { name: parsed.data.name },
    select: { name: true, email: true },
  });

  return NextResponse.json({ user });
}
