import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { db } from "@/lib/db";

const schema = z.object({
  aiInsightsEnabled: z.boolean().nullable(),       // null = según plan
  aiDailyMessageLimit: z.number().int().min(1).max(1000).nullable(),
});

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (session?.user?.role !== "platform_admin") return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const { id } = await params;
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid" }, { status: 400 });
  await db.restaurant.update({ where: { id }, data: parsed.data });
  return NextResponse.json({ ok: true });
}
