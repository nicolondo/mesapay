import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { getCrmContext } from "@/lib/crm/access";
import { recordAuditEvent } from "@/lib/auditLog";
import type { CrmStage } from "@prisma/client";

const VALID_STAGES: CrmStage[] = [
  "nuevo",
  "contactado",
  "demo_agendada",
  "demo_realizada",
  "propuesta_enviada",
  "negociacion",
  "ganado",
  "perdido",
];

const patchSchema = z.object({
  name: z.string().min(1).max(300).optional(),
  cityId: z.string().nullable().optional(),
  address: z.string().max(400).nullable().optional(),
  zone: z.string().max(200).nullable().optional(),
  businessType: z.string().max(200).nullable().optional(),
  priority: z.enum(["a", "b", "c"]).optional(),
  source: z.string().max(100).nullable().optional(),
  planProposed: z.string().max(100).nullable().optional(),
  unitsCount: z.number().int().positive().nullable().optional(),
  notes: z.string().max(5000).nullable().optional(),
  stage: z.enum(VALID_STAGES as [CrmStage, ...CrmStage[]]).optional(),
  lostReason: z.string().max(500).optional(),
  nextActionAt: z.string().datetime().nullable().optional(),
  assignedToUserId: z.string().optional(),
});

// ── Helper: scope check ──────────────────────────────────────────────────────

async function getLeadInScope(id: string, visibleUserIds: string[] | null) {
  const lead = await db.crmLead.findUnique({ where: { id } });
  if (!lead) return null;
  if (
    visibleUserIds !== null &&
    !visibleUserIds.includes(lead.assignedToUserId)
  ) {
    return null; // not in scope
  }
  return lead;
}

// ── GET /api/crm/leads/[id] ──────────────────────────────────────────────────

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const ctx = await getCrmContext();
  if (!ctx) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const { id } = await params;
  const lead = await getLeadInScope(id, ctx.visibleUserIds);
  if (!lead) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const [contacts, activities, appointments] = await Promise.all([
    db.crmContact.findMany({ where: { leadId: id } }),
    db.crmActivity.findMany({
      where: { leadId: id },
      orderBy: { createdAt: "desc" },
      take: 30,
      include: { user: { select: { id: true, name: true, email: true } } },
    }),
    db.crmAppointment.findMany({
      where: { leadId: id, startsAt: { gte: new Date() } },
      orderBy: { startsAt: "asc" },
    }),
  ]);

  return NextResponse.json({ lead, contacts, activities, appointments });
}

// ── PATCH /api/crm/leads/[id] ────────────────────────────────────────────────

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const ctx = await getCrmContext();
  if (!ctx) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const { id } = await params;
  const lead = await getLeadInScope(id, ctx.visibleUserIds);
  if (!lead) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const parsed = patchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const body = parsed.data;

  // Stage change validation.
  if (body.stage && body.stage !== lead.stage) {
    if (body.stage === "perdido" && !body.lostReason) {
      return NextResponse.json(
        { error: "lostReason_required" },
        { status: 400 },
      );
    }
  }

  // Reassign check: only gerente (within team) or admin.
  let assignedToUserId = lead.assignedToUserId;
  if (body.assignedToUserId && body.assignedToUserId !== lead.assignedToUserId) {
    if (ctx.role === "platform_admin") {
      assignedToUserId = body.assignedToUserId;
    } else if (ctx.role === "gerente_comercial") {
      if (!ctx.visibleUserIds?.includes(body.assignedToUserId)) {
        return NextResponse.json(
          { error: "assignee_not_in_scope" },
          { status: 403 },
        );
      }
      assignedToUserId = body.assignedToUserId;
    } else {
      return NextResponse.json({ error: "cannot_reassign" }, { status: 403 });
    }
  }

  const now = new Date();

  // Build update data.
  const updateData: Record<string, unknown> = {};
  if (body.name !== undefined) updateData.name = body.name;
  if (body.cityId !== undefined) updateData.cityId = body.cityId;
  if (body.address !== undefined) updateData.address = body.address;
  if (body.zone !== undefined) updateData.zone = body.zone;
  if (body.businessType !== undefined) updateData.businessType = body.businessType;
  if (body.priority !== undefined) updateData.priority = body.priority;
  if (body.source !== undefined) updateData.source = body.source;
  if (body.planProposed !== undefined) updateData.planProposed = body.planProposed;
  if (body.unitsCount !== undefined) updateData.unitsCount = body.unitsCount;
  if (body.notes !== undefined) updateData.notes = body.notes;
  if (body.stage !== undefined) updateData.stage = body.stage;
  if (body.lostReason !== undefined) updateData.lostReason = body.lostReason;
  if (body.nextActionAt !== undefined)
    updateData.nextActionAt = body.nextActionAt ? new Date(body.nextActionAt) : null;
  if (assignedToUserId !== lead.assignedToUserId)
    updateData.assignedToUserId = assignedToUserId;

  // If stage changed, record a stage_change activity and bump lastActivityAt.
  const stageChanged = body.stage && body.stage !== lead.stage;
  if (stageChanged) {
    updateData.lastActivityAt = now;
  }

  await db.$transaction(async (tx) => {
    await tx.crmLead.update({ where: { id }, data: updateData });

    if (stageChanged) {
      await tx.crmActivity.create({
        data: {
          leadId: id,
          userId: ctx.userId,
          type: "stage_change",
          content: `etapa: ${lead.stage} → ${body.stage!}`,
          meta: { from: lead.stage, to: body.stage },
        },
      });
    }
  });

  // Audit reassign.
  if (assignedToUserId !== lead.assignedToUserId) {
    await recordAuditEvent({
      kind: "crm.lead.reassign",
      summary: `Reasignó lead "${lead.name}" (${id}) → usuario ${assignedToUserId}`,
      diff: {
        before: { assignedToUserId: lead.assignedToUserId },
        after: { assignedToUserId },
      },
    });
  }

  return NextResponse.json({ ok: true });
}
