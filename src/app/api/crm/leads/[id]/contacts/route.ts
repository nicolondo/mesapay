import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { getCrmContext } from "@/lib/crm/access";
import { normalizePhone } from "@/lib/crm/phone";

const createSchema = z.object({
  name: z.string().min(1).max(200),
  phone: z.string().max(40).optional(),
  email: z.string().email().optional().or(z.literal("")),
  role: z.string().max(100).optional(),
  isPrimary: z.boolean().optional(),
  notes: z.string().max(1000).optional(),
});

// ── Helper: check lead scope ─────────────────────────────────────────────────

async function getLeadInScope(id: string, visibleUserIds: string[] | null) {
  const lead = await db.crmLead.findUnique({
    where: { id },
    select: { id: true, assignedToUserId: true, countryCode: true },
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

// ── POST /api/crm/leads/[id]/contacts ────────────────────────────────────────

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

  const body = parsed.data;
  const countryCode = ctx.countryCode ?? lead.countryCode;
  const phone = body.phone
    ? normalizePhone(body.phone, countryCode)
    : null;

  const isPrimary = body.isPrimary ?? false;

  const contact = await db.$transaction(async (tx) => {
    // If this is primary, unset all other primaries.
    if (isPrimary) {
      await tx.crmContact.updateMany({
        where: { leadId: id },
        data: { isPrimary: false },
      });
    }
    return tx.crmContact.create({
      data: {
        leadId: id,
        name: body.name,
        phone,
        email: body.email || null,
        role: body.role ?? null,
        isPrimary,
        notes: body.notes ?? null,
      },
    });
  });

  return NextResponse.json({ contact }, { status: 201 });
}
