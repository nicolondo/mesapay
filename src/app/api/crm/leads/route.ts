import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { getCrmContext } from "@/lib/crm/access";
import { normalizePhone } from "@/lib/crm/phone";
import { normalizeLeadName } from "@/lib/crm/dupes";
import type { Prisma, CrmStage } from "@prisma/client";

// ── Schema ──────────────────────────────────────────────────────────────────

const contactSchema = z.object({
  name: z.string().min(1).max(200),
  phone: z.string().max(40).optional(),
  email: z.string().email().optional().or(z.literal("")),
  role: z.string().max(100).optional(),
});

const unitNamesSchema = z
  .array(z.string().trim().min(1).max(80))
  .max(100)
  .optional()
  .transform((arr) => {
    if (!arr) return arr;
    // dedupe case-insensitive while preserving original casing of first occurrence
    const seen = new Set<string>();
    return arr.filter((n) => {
      const key = n.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  });

const createSchema = z.object({
  name: z.string().min(1).max(300),
  countryCode: z.string().length(2).toUpperCase().optional(),
  cityId: z.string().optional(),
  address: z.string().max(400).optional(),
  zone: z.string().max(200).optional(),
  businessType: z.string().max(200).optional(),
  priority: z.enum(["a", "b", "c"]).optional(),
  source: z.string().max(100).optional(),
  planProposed: z.string().max(100).optional(),
  unitsCount: z.number().int().positive().optional(),
  unitNames: unitNamesSchema,
  notes: z.string().max(5000).optional(),
  contact: contactSchema.optional(),
  assignedToUserId: z.string().optional(),
});

// ── GET /api/crm/leads ──────────────────────────────────────────────────────

const ALL_STAGES: CrmStage[] = [
  "nuevo",
  "contactado",
  "demo_agendada",
  "demo_realizada",
  "propuesta_enviada",
  "negociacion",
  "ganado",
  "perdido",
];

export async function GET(req: Request) {
  const ctx = await getCrmContext();
  if (!ctx) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const { searchParams } = new URL(req.url);
  const stage = searchParams.get("stage") as CrmStage | null;
  const q = searchParams.get("q") ?? "";
  const assignedTo = searchParams.get("assignedTo") ?? "";
  const cursor = searchParams.get("cursor") ?? undefined;
  const includeCounts = searchParams.get("counts") === "1";

  // Build the where clause.
  const where: Prisma.CrmLeadWhereInput = {};

  // Scope: admin sees all, others see their scope.
  if (ctx.visibleUserIds !== null) {
    where.assignedToUserId = { in: ctx.visibleUserIds };
  }

  if (stage) where.stage = stage;

  if (q.trim()) {
    const term = q.trim();
    // Busca por nombre del lead O por el nombre de cualquiera de sus
    // contactos (some = matchea si al menos un contacto coincide).
    where.OR = [
      { name: { contains: term, mode: "insensitive" } },
      { contacts: { some: { name: { contains: term, mode: "insensitive" } } } },
    ];
  }

  // assignedTo filter: must be within visible scope.
  if (assignedTo) {
    if (
      ctx.visibleUserIds !== null &&
      !ctx.visibleUserIds.includes(assignedTo)
    ) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }
    where.assignedToUserId = assignedTo;
  }

  const leads = await db.crmLead.findMany({
    where,
    take: 30,
    ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    orderBy: [
      { lastActivityAt: { sort: "desc", nulls: "last" } },
      { createdAt: "desc" },
    ],
    select: {
      id: true,
      name: true,
      countryCode: true,
      stage: true,
      priority: true,
      lastActivityAt: true,
      nextActionAt: true,
      createdAt: true,
      unitsCount: true,
      unitNames: true,
      city: { select: { id: true, name: true } },
      assignedTo: { select: { id: true, name: true, email: true } },
      contacts: {
        where: { isPrimary: true },
        select: { id: true, name: true, phone: true, email: true },
        take: 1,
      },
    },
  });

  const nextCursor =
    leads.length === 30 ? leads[leads.length - 1].id : undefined;

  if (!includeCounts) {
    return NextResponse.json({ leads, nextCursor });
  }

  // counts=1: compute stage counts for the current scope+assignedTo (ignoring
  // the stage filter so counts reflect all stages for the current view).
  const countsWhere: Prisma.CrmLeadWhereInput = {};
  if (ctx.visibleUserIds !== null) {
    countsWhere.assignedToUserId = { in: ctx.visibleUserIds };
  }
  if (assignedTo) {
    countsWhere.assignedToUserId = assignedTo;
  }
  if (q.trim()) {
    const term = q.trim();
    countsWhere.OR = [
      { name: { contains: term, mode: "insensitive" } },
      { contacts: { some: { name: { contains: term, mode: "insensitive" } } } },
    ];
  }

  const stageGroups = await db.crmLead.groupBy({
    by: ["stage"],
    where: countsWhere,
    _count: { stage: true },
  });

  const stageCounts: Record<string, number> = {};
  for (const row of stageGroups) {
    stageCounts[row.stage] = row._count.stage;
  }
  for (const s of ALL_STAGES) {
    stageCounts[s] ??= 0;
  }
  const total = Object.values(stageCounts).reduce((a, b) => a + b, 0);

  return NextResponse.json({ leads, nextCursor, stageCounts: { total, ...stageCounts } });
}

// ── POST /api/crm/leads ─────────────────────────────────────────────────────

export async function POST(req: Request) {
  const ctx = await getCrmContext();
  if (!ctx) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const { searchParams } = new URL(req.url);
  const checkDupes = searchParams.get("checkDupes") === "1";

  const parsed = createSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const body = parsed.data;

  // Determine country.
  let countryCode: string;
  if (ctx.countryCode) {
    // comercial/gerente with a country: forced server-side.
    countryCode = ctx.countryCode;
  } else if (body.countryCode) {
    countryCode = body.countryCode;
  } else {
    return NextResponse.json({ error: "missing_country" }, { status: 400 });
  }

  // Determine assignedTo.
  let assignedToUserId = ctx.userId;
  if (body.assignedToUserId && body.assignedToUserId !== ctx.userId) {
    // Only gerente (within team) or admin can reassign.
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

  // Normalize contact phone.
  let normalizedPhone: string | null = null;
  if (body.contact?.phone) {
    normalizedPhone = normalizePhone(body.contact.phone, countryCode);
  }

  // Duplicate check mode: return potential dupes without creating.
  if (checkDupes) {
    const normalized = normalizeLeadName(body.name);
    const scopeFilter: Prisma.CrmLeadWhereInput =
      ctx.visibleUserIds !== null
        ? { assignedToUserId: { in: ctx.visibleUserIds } }
        : {};

    // Name-based dupes: fetch and filter by normalized name.
    const nameCandidates = await db.crmLead.findMany({
      where: {
        ...scopeFilter,
        name: { contains: normalized.split(" ")[0] ?? body.name, mode: "insensitive" },
      },
      take: 20,
      select: { id: true, name: true, countryCode: true, stage: true },
    });
    const nameDupes = nameCandidates.filter(
      (l) => normalizeLeadName(l.name) === normalized,
    );

    // Phone-based dupes.
    const phoneDupes =
      normalizedPhone
        ? await db.crmLead.findMany({
            where: {
              ...scopeFilter,
              contacts: { some: { phone: normalizedPhone } },
            },
            take: 5,
            select: { id: true, name: true, countryCode: true, stage: true },
          })
        : [];

    const seen = new Set<string>();
    const dupes = [...nameDupes, ...phoneDupes].filter((l) => {
      if (seen.has(l.id)) return false;
      seen.add(l.id);
      return true;
    });

    return NextResponse.json({ dupes: dupes.slice(0, 5) });
  }

  // Auto-count rule: when unitNames provided and non-empty, override unitsCount.
  const resolvedUnitNames = body.unitNames ?? [];
  const resolvedUnitsCount =
    resolvedUnitNames.length > 0
      ? resolvedUnitNames.length
      : (body.unitsCount ?? null);

  // Create the lead (+ optional contact) in a transaction.
  const lead = await db.$transaction(async (tx) => {
    const newLead = await tx.crmLead.create({
      data: {
        name: body.name,
        countryCode,
        cityId: body.cityId ?? null,
        address: body.address ?? null,
        zone: body.zone ?? null,
        businessType: body.businessType ?? null,
        priority: body.priority ?? "b",
        source: body.source ?? null,
        planProposed: body.planProposed ?? null,
        unitsCount: resolvedUnitsCount,
        unitNames: resolvedUnitNames,
        notes: body.notes ?? null,
        assignedToUserId,
        createdByUserId: ctx.userId,
      },
    });

    if (body.contact) {
      await tx.crmContact.create({
        data: {
          leadId: newLead.id,
          name: body.contact.name,
          phone: normalizedPhone,
          email: body.contact.email || null,
          role: body.contact.role ?? null,
          isPrimary: true,
        },
      });
    }

    return newLead;
  });

  return NextResponse.json({ lead }, { status: 201 });
}
