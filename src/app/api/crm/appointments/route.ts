import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { getCrmContext } from "@/lib/crm/access";

export const dynamic = "force-dynamic";

const createSchema = z.object({
  leadId: z.string().min(1),
  title: z.string().min(1).max(200),
  startsAt: z.string().datetime(),
  endsAt: z.string().datetime().optional(),
  notes: z.string().optional(),
});

// ── GET /api/crm/appointments?from=ISO&to=ISO ─────────────────────────────
export async function GET(req: Request) {
  const ctx = await getCrmContext();
  if (!ctx) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const url = new URL(req.url);
  const fromParam = url.searchParams.get("from");
  const toParam = url.searchParams.get("to");

  const from = fromParam ? new Date(fromParam) : undefined;
  const to = toParam ? new Date(toParam) : undefined;

  // Build userId filter based on scope.
  const userFilter =
    ctx.visibleUserIds !== null
      ? { userId: { in: ctx.visibleUserIds } }
      : {};

  const startsAtFilter: Record<string, Date> = {};
  if (from) startsAtFilter.gte = from;
  if (to) startsAtFilter.lte = to;

  const appointments = await db.crmAppointment.findMany({
    where: {
      ...userFilter,
      ...(Object.keys(startsAtFilter).length > 0
        ? { startsAt: startsAtFilter }
        : {}),
    },
    orderBy: { startsAt: "asc" },
    select: {
      id: true,
      title: true,
      startsAt: true,
      endsAt: true,
      notes: true,
      status: true,
      remindedAt: true,
      leadId: true,
      userId: true,
      lead: { select: { id: true, name: true } },
      user: { select: { id: true, name: true, email: true } },
    },
  });

  return NextResponse.json({ appointments });
}

// ── POST /api/crm/appointments ────────────────────────────────────────────
export async function POST(req: Request) {
  const ctx = await getCrmContext();
  if (!ctx) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const body = await req.json().catch(() => null);
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "validation", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const { leadId, title, startsAt, endsAt, notes } = parsed.data;

  // Verify lead is within scope.
  const lead = await db.crmLead.findFirst({
    where: {
      id: leadId,
      ...(ctx.visibleUserIds !== null
        ? { assignedToUserId: { in: ctx.visibleUserIds } }
        : {}),
    },
    select: { id: true, name: true },
  });
  if (!lead) {
    return NextResponse.json({ error: "lead_not_found" }, { status: 404 });
  }

  // Compute endsAt (default: startsAt + 60min).
  const starts = new Date(startsAt);
  const ends = endsAt
    ? new Date(endsAt)
    : new Date(starts.getTime() + 60 * 60 * 1000);

  // Create appointment + activity in a transaction.
  const [appointment] = await db.$transaction([
    db.crmAppointment.create({
      data: {
        leadId,
        userId: ctx.userId,
        title,
        startsAt: starts,
        endsAt: ends,
        notes,
        status: "scheduled",
      },
    }),
    db.crmActivity.create({
      data: {
        leadId,
        userId: ctx.userId,
        type: "appointment",
        content: `Cita: ${title} ${starts.toISOString().slice(0, 10)}`,
      },
    }),
    db.crmLead.update({
      where: { id: leadId },
      data: { lastActivityAt: new Date() },
    }),
  ]);

  return NextResponse.json({ appointment }, { status: 201 });
}
