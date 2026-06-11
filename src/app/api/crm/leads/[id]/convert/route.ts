import { NextResponse } from "next/server";
import { z } from "zod";
import { randomBytes } from "crypto";
import { db } from "@/lib/db";
import { getCrmContext } from "@/lib/crm/access";
import { recordAuditEvent } from "@/lib/auditLog";
import { normalizeSlug } from "@/lib/registerRestaurant";
import { getPlanByTier } from "@/lib/planCatalog";
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

  const { plan } = parsed.data;
  let { monthlyPriceCents } = parsed.data;
  const restaurantName = (parsed.data.name ?? lead.name).trim();
  const slugBase = parsed.data.slug ? normalizeSlug(parsed.data.slug) : normalizeSlug(restaurantName);
  const slug = await uniqueSlug(slugBase);

  // C1: Enforce catalog floor price. trial is always 0; others must be ≥ catalog default.
  const catalogEntry = await getPlanByTier(plan as Plan);
  if (plan === "trial") {
    monthlyPriceCents = 0;
  } else if (monthlyPriceCents < catalogEntry.defaultPriceCents) {
    monthlyPriceCents = catalogEntry.defaultPriceCents;
  }

  const now = new Date();

  // Capture non-null lead fields for use inside inner functions (TS closure narrowing).
  const leadCountryCode = lead.countryCode;
  const leadCityName = lead.city?.name;
  const leadAssignedToUserId = lead.assignedToUserId;
  const leadStage = lead.stage;

  // C2: Wrap restaurant.create in try/catch; retry once on P2002 slug conflict.
  async function createRestaurant(tx: Parameters<Parameters<typeof db.$transaction>[0]>[0], finalSlug: string) {
    return tx.restaurant.create({
      data: {
        slug: finalSlug,
        name: restaurantName,
        plan: plan as Plan,
        monthlyPriceCents,
        country: leadCountryCode ?? undefined,
        city: leadCityName ?? undefined,
        // Wire the commercial rep automatically.
        salesRepUserId: leadAssignedToUserId,
        // salesRepCommissionBps: null → cascades to user's default (correct)
      },
    });
  }

  function isP2002(err: unknown): boolean {
    return (
      typeof err === "object" &&
      err !== null &&
      "code" in err &&
      (err as { code: string }).code === "P2002"
    );
  }

  let restaurant: Awaited<ReturnType<typeof createRestaurant>>;
  try {
    const result = await db.$transaction(async (tx) => {
      let rest: Awaited<ReturnType<typeof createRestaurant>>;
      try {
        rest = await createRestaurant(tx, slug);
      } catch (err) {
        if (isP2002(err)) {
          // Retry once with a random suffix.
          const retrySlug = `${slug.slice(0, 32)}-${randomBytes(2).toString("hex")}`;
          try {
            rest = await createRestaurant(tx, retrySlug);
          } catch (err2) {
            if (isP2002(err2)) {
              throw Object.assign(new Error("slug_conflict"), { _slugConflict: true });
            }
            throw err2;
          }
        } else {
          throw err;
        }
      }

      // Update lead: link restaurant + move to ganado.
      await tx.crmLead.update({
        where: { id },
        data: {
          restaurantId: rest.id,
          stage: "ganado",
          lastActivityAt: now,
        },
      });

      // R1: activity content includes "ganado" so metrics.includes("ganado") matches.
      await tx.crmActivity.create({
        data: {
          leadId: id,
          userId: ctx.userId,
          type: "stage_change",
          content: `etapa: ${leadStage} → ganado (convertido en cliente)`,
          meta: { from: leadStage, to: "ganado", restaurantId: rest.id },
        },
      });

      return { restaurant: rest };
    });
    restaurant = result.restaurant;
  } catch (err) {
    if (
      typeof err === "object" &&
      err !== null &&
      "_slugConflict" in err
    ) {
      return NextResponse.json({ error: "slug_conflict" }, { status: 409 });
    }
    throw err;
  }

  await recordAuditEvent({
    kind: "crm.lead.convert",
    restaurantId: restaurant.id,
    target: { type: "restaurant", id: restaurant.id },
    summary: `Convirtió lead "${restaurantName}" (${id}) en restaurante "${restaurant.name}" (${restaurant.id}) · plan ${plan} · ${monthlyPriceCents} cents/mes`,
    diff: {
      before: { stage: leadStage, restaurantId: null },
      after: { stage: "ganado", restaurantId: restaurant.id },
    },
  });

  return NextResponse.json({
    ok: true,
    restaurantId: restaurant.id,
    restaurantSlug: restaurant.slug,
  });
}
