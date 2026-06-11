/**
 * GET  /api/crm/team  — list team members (gerente: their team; admin: all comercial+gerente)
 * POST /api/crm/team  — create a new comercial user (gerente or admin)
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { getCrmContext } from "@/lib/crm/access";
import { db } from "@/lib/db";
import { recordAuditEvent } from "@/lib/auditLog";
import { Role } from "@prisma/client";

const createSchema = z.object({
  email: z.string().email().transform((s) => s.toLowerCase().trim()),
  name: z.string().trim().min(1).max(80),
  password: z.string().min(8).max(200),
  countryCode: z.string().length(2).toUpperCase().optional(),
  commissionBps: z.number().int().min(0).max(5000).optional(),
  /** Admin only: assign to a specific manager. Defaults to caller for gerente. */
  managerId: z.string().optional(),
});

// ── GET /api/crm/team ────────────────────────────────────────────────────────

export async function GET() {
  const ctx = await getCrmContext();
  if (!ctx) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  // Only gerente or admin can list the team.
  if (ctx.role !== "gerente_comercial" && ctx.role !== "platform_admin") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  // Build where clause by role.
  const where =
    ctx.role === "gerente_comercial"
      ? { managerId: ctx.userId }
      : { role: { in: ["comercial", "gerente_comercial"] as Role[] } };

  const members = await db.user.findMany({
    where,
    select: {
      id: true,
      name: true,
      email: true,
      countryCode: true,
      commissionBps: true,
      disabledAt: true,
      role: true,
      managerId: true,
      createdAt: true,
    },
    orderBy: { name: "asc" },
  });

  // Attach lead counts per member in one query.
  const leadCounts = await db.crmLead.groupBy({
    by: ["assignedToUserId"],
    where: { assignedToUserId: { in: members.map((m) => m.id) } },
    _count: { id: true },
  });

  const countMap = Object.fromEntries(
    leadCounts.map((r) => [r.assignedToUserId, r._count.id]),
  );

  const result = members.map((m) => ({
    ...m,
    leadCount: countMap[m.id] ?? 0,
    disabled: m.disabledAt !== null,
  }));

  return NextResponse.json({ members: result });
}

// ── POST /api/crm/team ───────────────────────────────────────────────────────

export async function POST(req: Request) {
  const ctx = await getCrmContext();
  if (!ctx) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  // Only gerente or admin can create team members.
  if (ctx.role !== "gerente_comercial" && ctx.role !== "platform_admin") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const body = await req.json().catch(() => null);
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const { email, name, password, countryCode, commissionBps, managerId } =
    parsed.data;

  // Determine managerId: gerente always assigns to self; admin can specify.
  let resolvedManagerId: string;
  if (ctx.role === "gerente_comercial") {
    resolvedManagerId = ctx.userId;
  } else {
    // Admin: use provided managerId or default to none (null = free comercial)
    resolvedManagerId = managerId ?? ctx.userId;
  }

  const passwordHash = await bcrypt.hash(password, 10);

  try {
    const user = await db.user.create({
      data: {
        email,
        name,
        passwordHash,
        role: "comercial",
        managerId: resolvedManagerId,
        countryCode: countryCode ?? null,
        commissionBps: commissionBps ?? null,
      },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        countryCode: true,
        commissionBps: true,
        managerId: true,
        createdAt: true,
      },
    });

    await recordAuditEvent({
      kind: "crm.team.create",
      summary: `Creó comercial ${email} (managerId=${resolvedManagerId})`,
      diff: { after: { email, name, role: "comercial", managerId: resolvedManagerId } },
    });

    return NextResponse.json({ ok: true, user }, { status: 201 });
  } catch (err: unknown) {
    if (
      typeof err === "object" &&
      err !== null &&
      "code" in err &&
      (err as { code: string }).code === "P2002"
    ) {
      return NextResponse.json({ error: "email_taken" }, { status: 409 });
    }
    throw err;
  }
}
