import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { getCrmContext } from "@/lib/crm/access";

export const dynamic = "force-dynamic";

const patchSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  startsAt: z.string().datetime().optional(),
  endsAt: z.string().datetime().optional(),
  notes: z.string().optional(),
  status: z.enum(["scheduled", "done", "cancelled"]).optional(),
});

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const ctx = await getCrmContext();
  if (!ctx) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const { id } = await params;

  // Verify appointment belongs to a user in scope.
  const existing = await db.crmAppointment.findFirst({
    where: {
      id,
      ...(ctx.visibleUserIds !== null
        ? { userId: { in: ctx.visibleUserIds } }
        : {}),
    },
    select: { id: true },
  });
  if (!existing) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const body = await req.json().catch(() => null);
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "validation", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const data = parsed.data;

  const updated = await db.crmAppointment.update({
    where: { id },
    data: {
      ...(data.title !== undefined ? { title: data.title } : {}),
      ...(data.startsAt !== undefined
        ? { startsAt: new Date(data.startsAt) }
        : {}),
      ...(data.endsAt !== undefined ? { endsAt: new Date(data.endsAt) } : {}),
      ...(data.notes !== undefined ? { notes: data.notes } : {}),
      ...(data.status !== undefined ? { status: data.status } : {}),
    },
  });

  return NextResponse.json({ appointment: updated });
}
