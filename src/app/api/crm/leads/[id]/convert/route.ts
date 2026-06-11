import { NextResponse } from "next/server";
import { z } from "zod";
import { randomBytes } from "crypto";
import { db } from "@/lib/db";
import { getCrmContext } from "@/lib/crm/access";
import { recordAuditEvent } from "@/lib/auditLog";
import { normalizeSlug } from "@/lib/registerRestaurant";
import type { Plan } from "@prisma/client";

const convertSchema = z.object({
  name: z.string().min(1).max(300).optional(),
  slug: z.string().min(2).max(40).optional(),
  plan: z.enum(["trial", "basic", "pro"] as [Plan, ...Plan[]]),
  monthlyPriceCents: z.number().int().min(0),
});

const RESERVED = new Set([
  "www", "api", "admin", "app", "signin", "signup",
  "operator", "operador", "t", "mesapay",
]);

/** Find a unique slug: try base, then base-2, base-3, … */
async function uniqueSlug(base: string): Promise<string> {
  const norm = normalizeSlug(base);
  if (norm.length < 2) return `r-${randomBytes(4).toString("hex")}`;
  if (RESERVED.has(norm)) return `${norm}-r`;

  const existing = await db.restaurant.findUnique({ where: { slug: norm }, select: { id: true } });
  if (!existing) return norm;

  for (let i = 2; i <= 99; i++) {
    const candidate = `${norm.slice(0, 37)}-${i}`;
    const found = await db.restaurant.findUnique({ where: { slug: candidate }, select: { id: true } });
    if (!found) return candidate;
  }
  return `${norm.slice(0, 32)}-${randomBytes(4).toString("hex")}`;
}

// ── POST /api/crm/leads/[id]/convert ────────────────────────────────────────
// Gate: lead must be in scope (comercial owner, gerente of team, or admin).
// Creates a Restaurant, links lead.restaurantId, changes stage → ganado.

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const ctx = await getCrmContext();
  if (!ctx) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const { id } = await params;

  // Fetch lead and check scope.
  const lead = await db.crmLead.findUnique({
    where: { id },
    include: { city: { select: { name: true } } },
  });
  if (!lead) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (
    ctx.visibleUserIds !== null &&
    !ctx.visibleUserIds.includes(lead.assignedToUserId)
  ) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  // Already converted?
  if (lead.restaurantId) {
    return NextResponse.json({ error: "already_converted", restaurantId: lead.restaurantId }, { status: 409 });
  }

  const parsed = convertSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const { plan, monthlyPriceCents } = parsed.data;
  const restaurantName = (parsed.data.name ?? lead.name).trim();
  const slugBase = parsed.data.slug ? normalizeSlug(parsed.data.slug) : normalizeSlug(restaurantName);
  const slug = await uniqueSlug(slugBase);

  const now = new Date();

  const { restaurant } = await db.$transaction(async (tx) => {
    // Create minimal restaurant (no owner user — CRM converts don't have
    // credentials yet; an operator can be added later from admin).
    const restaurant = await tx.restaurant.create({
      data: {
        slug,
        name: restaurantName,
        plan: plan as Plan,
        monthlyPriceCents,
        country: lead.countryCode ?? undefined,
        city: lead.city?.name ?? undefined,
        // Wire the commercial rep automatically.
        salesRepUserId: lead.assignedToUserId,
        // salesRepCommissionBps: null → cascades to user's default (correct)
      },
    });

    // Update lead: link restaurant + move to ganado.
    await tx.crmLead.update({
      where: { id },
      data: {
        restaurantId: restaurant.id,
        stage: "ganado",
        lastActivityAt: now,
      },
    });

    // Record stage_change activity.
    await tx.crmActivity.create({
      data: {
        leadId: id,
        userId: ctx.userId,
        type: "stage_change",
        content: "Convertido en cliente ✓",
        meta: { from: lead.stage, to: "ganado", restaurantId: restaurant.id },
      },
    });

    return { restaurant };
  });

  await recordAuditEvent({
    kind: "crm.lead.convert",
    restaurantId: restaurant.id,
    target: { type: "restaurant", id: restaurant.id },
    summary: `Convirtió lead "${lead.name}" (${id}) en restaurante "${restaurant.name}" (${restaurant.id}) · plan ${plan}`,
    diff: {
      before: { stage: lead.stage, restaurantId: null },
      after: { stage: "ganado", restaurantId: restaurant.id },
    },
  });

  return NextResponse.json({
    ok: true,
    restaurantId: restaurant.id,
    restaurantSlug: restaurant.slug,
  });
}
