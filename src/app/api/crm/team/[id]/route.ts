/**
 * PATCH /api/crm/team/[id] — edit a comercial in the caller's team
 *
 * Editable: name, countryCode, commissionBps, disabled
 * Gate: target.managerId === caller OR platform_admin
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { getCrmContext } from "@/lib/crm/access";
import { db } from "@/lib/db";
import { recordAuditEvent } from "@/lib/auditLog";

const patchSchema = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    countryCode: z
      .string()
      .length(2)
      .toUpperCase()
      .nullable()
      .optional(),
    commissionBps: z.number().int().min(0).max(5000).nullable().optional(),
    disabled: z.boolean().optional(),
    password: z.string().min(8).max(200).optional(),
  })
  .refine(
    (d) =>
      d.name !== undefined ||
      d.countryCode !== undefined ||
      d.commissionBps !== undefined ||
      d.disabled !== undefined ||
      d.password !== undefined,
    { message: "at_least_one_field" },
  );

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const ctx = await getCrmContext();
  if (!ctx) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  // Only gerente or admin.
  if (ctx.role !== "gerente_comercial" && ctx.role !== "platform_admin") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const { id } = await params;
  const target = await db.user.findUnique({ where: { id } });
  if (!target) return NextResponse.json({ error: "not_found" }, { status: 404 });

  // Gate: gerente can only edit members whose managerId === their own id.
  if (ctx.role === "gerente_comercial" && target.managerId !== ctx.userId) {
    return NextResponse.json({ error: "not_in_team" }, { status: 403 });
  }

  // Only comercial can be edited via this endpoint.
  if (target.role !== "comercial") {
    return NextResponse.json({ error: "only_comercial" }, { status: 403 });
  }

  const body = await req.json().catch(() => null);
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const { name, countryCode, commissionBps, disabled, password } = parsed.data;

  const data: Record<string, unknown> = {};
  if (name !== undefined) data.name = name;
  if (countryCode !== undefined) data.countryCode = countryCode;
  if (commissionBps !== undefined) data.commissionBps = commissionBps;
  if (password !== undefined) data.passwordHash = await bcrypt.hash(password, 10);
  if (disabled !== undefined) {
    data.disabledAt = disabled ? (target.disabledAt ?? new Date()) : null;
  }

  // Build audit diff.
  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};
  if (name !== undefined) { before.name = target.name; after.name = name; }
  if (countryCode !== undefined) { before.countryCode = target.countryCode; after.countryCode = countryCode; }
  if (commissionBps !== undefined) { before.commissionBps = target.commissionBps; after.commissionBps = commissionBps; }
  if (password !== undefined) { after.password = "(changed)"; }
  if (disabled !== undefined) { before.disabledAt = target.disabledAt; after.disabledAt = data.disabledAt; }

  const auditKind =
    disabled === true
      ? "crm.team.disable"
      : disabled === false
        ? "crm.team.enable"
        : "crm.team.update";

  const updated = await db.user.update({
    where: { id },
    data,
    select: {
      id: true,
      email: true,
      name: true,
      countryCode: true,
      commissionBps: true,
      disabledAt: true,
    },
  });

  await recordAuditEvent({
    kind: auditKind,
    target: { type: "user", id },
    summary: `${auditKind} ${target.email}`,
    diff: { before, after },
  });

  return NextResponse.json({ ok: true, user: updated });
}
