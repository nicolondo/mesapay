import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { getCrmContext } from "@/lib/crm/access";

const createSchema = z.object({
  type: z.enum(["note", "call", "whatsapp", "visit"]),
  content: z.string().max(5000).optional(),
  nextActionAt: z.string().datetime().optional(),
});

// ── Helper: check lead scope ─────────────────────────────────────────────────

async function getLeadInScope(id: string, visibleUserIds: string[] | null) {
  const lead = await db.crmLead.findUnique({
    where: { id },
    select: { id: true, assignedToUserId: true },
  });
  if (!lead) return null;
  if (
    visibleUserIds !== null &&
    !visibleUserIds.includes(lead.assignedToUserId)
  ) {
    return null;
  }
  return lead;
}

// ── POST /api/crm/leads/[id]/activities ─────────────────────────────────────

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const ctx = await getCrmContext();
  if (!ctx) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const { id } = await params;
  const lead = await getLeadInScope(id, ctx.visibleUserIds);
  if (!lead) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const parsed = createSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const { type, content, nextActionAt } = parsed.data;
  const now = new Date();

  const activity = await db.$transaction(async (tx) => {
    const act = await tx.crmActivity.create({
      data: {
        leadId: id,
        userId: ctx.userId,
        type,
        content: content ?? "",
      },
    });

    // Update lead.lastActivityAt (and optionally nextActionAt).
    await tx.crmLead.update({
      where: { id },
      data: {
        lastActivityAt: now,
        ...(nextActionAt !== undefined
          ? { nextActionAt: new Date(nextActionAt) }
          : {}),
      },
    });

    return act;
  });

  return NextResponse.json({ activity }, { status: 201 });
}
