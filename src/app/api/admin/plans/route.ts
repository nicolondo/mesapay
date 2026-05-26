import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { getPlanCatalog, updatePlan } from "@/lib/planCatalog";

/**
 * Catálogo de planes (trial/basic/pro). GET devuelve todos los
 * tiers + sus campos editables; PATCH actualiza UN tier.
 *
 * El admin no puede crear ni borrar tiers — están atados al enum
 * `Plan` de Prisma. Para cambiar eso habría que migrar el enum.
 *
 * Sólo `platform_admin`. Cualquier otro rol → 403.
 */

const patchSchema = z.object({
  tier: z.enum(["trial", "basic", "pro"]),
  name: z.string().trim().min(1).max(60).optional(),
  description: z
    .string()
    .trim()
    .max(240)
    .nullable()
    .optional()
    .transform((v) => (v === "" ? null : v)),
  defaultPriceCents: z.number().int().min(0).max(100_000_000).optional(),
  // Lista de bullets cortos. Filtramos vacíos y cap a 12 para no
  // dejar que se infle el catálogo con basura.
  features: z
    .array(z.string().trim().max(120))
    .max(12)
    .transform((arr) => arr.filter((s) => s.length > 0))
    .optional(),
  visible: z.boolean().optional(),
  sortOrder: z.number().int().min(0).max(99).optional(),
});

async function requireAdmin() {
  const session = await auth();
  if (!session?.user || session.user.role !== "platform_admin") {
    return null;
  }
  return session;
}

export async function GET() {
  const session = await requireAdmin();
  if (!session) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const plans = await getPlanCatalog();
  return NextResponse.json({ plans });
}

export async function PATCH(req: Request) {
  const session = await requireAdmin();
  if (!session) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const body = await req.json().catch(() => null);
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return NextResponse.json(
      { error: "invalid", message: first?.message ?? "Datos inválidos" },
      { status: 400 },
    );
  }
  const { tier, ...patch } = parsed.data;
  const updated = await updatePlan(tier, patch);
  return NextResponse.json({ ok: true, plan: updated });
}
