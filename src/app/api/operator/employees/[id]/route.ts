import { NextResponse } from "next/server";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { getErpContext, isDenied } from "@/lib/erp/access";
import { validShiftRange } from "@/lib/erp/staff";
import type { ModuleSlug } from "@/lib/modules";

export const dynamic = "force-dynamic";

const GATE: ModuleSlug[] = ["staff"];

const rangeSchema = z.object({
  startMinutes: z.number().int(),
  endMinutes: z.number().int(),
});
const templateSchema = z
  .array(
    z.object({
      weekday: z.number().int().min(0).max(6),
      ranges: z.array(rangeSchema).max(2),
    }),
  )
  .max(7);
// Descriptores face-api: 1-3 vectores de 128 floats (dato sensible — solo
// con consentimiento; ver validación cruzada abajo).
const descriptorsSchema = z
  .array(z.array(z.number()).length(128))
  .min(1)
  .max(3);

const patchSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  position: z.string().trim().min(1).max(60).optional(),
  hourlyRateCents: z.number().int().min(1).max(2_000_000_000).nullable().optional(),
  userId: z.string().min(1).nullable().optional(),
  active: z.boolean().optional(),
  // C2 — plantilla semanal y registro facial.
  weeklyTemplate: templateSchema.nullable().optional(),
  faceDescriptors: descriptorsSchema.nullable().optional(),
  facePhotoUrls: z.array(z.string().max(500)).max(3).nullable().optional(),
  faceConsentAt: z.string().datetime().nullable().optional(),
});

async function loadOwned(id: string, restaurantId: string) {
  const e = await db.employee.findUnique({ where: { id } });
  if (!e || e.restaurantId !== restaurantId) return null;
  return e;
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const ctx = await getErpContext(GATE);
  if (isDenied(ctx)) {
    return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  }
  const { id } = await params;
  if (!(await loadOwned(id, ctx.restaurantId))) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  const parsed = patchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid" }, { status: 400 });
  }
  const b = parsed.data;
  // Plantilla: cada rango con las reglas de turno (15 min – 16 h).
  if (b.weeklyTemplate) {
    const badRange = b.weeklyTemplate.some((d) =>
      d.ranges.some((r) => !validShiftRange(r.startMinutes, r.endMinutes)),
    );
    if (badRange) {
      return NextResponse.json({ error: "invalid" }, { status: 400 });
    }
  }
  // Registro facial: descriptores solo CON consentimiento en el mismo
  // request (dato sensible); limpiar descriptores limpia todo.
  if (b.faceDescriptors && !b.faceConsentAt) {
    return NextResponse.json({ error: "consent_required" }, { status: 400 });
  }
  if (b.userId) {
    const u = await db.user.findUnique({
      where: { id: b.userId },
      select: { restaurantId: true },
    });
    if (u?.restaurantId !== ctx.restaurantId) {
      return NextResponse.json({ error: "user_not_found" }, { status: 400 });
    }
  }
  try {
    const employee = await db.employee.update({
      where: { id },
      data: {
        ...(b.name !== undefined ? { name: b.name } : {}),
        ...(b.position !== undefined ? { position: b.position } : {}),
        ...(b.hourlyRateCents !== undefined
          ? { hourlyRateCents: b.hourlyRateCents }
          : {}),
        ...(b.userId !== undefined ? { userId: b.userId } : {}),
        ...(b.active !== undefined ? { active: b.active } : {}),
        ...(b.weeklyTemplate !== undefined
          ? { weeklyTemplate: b.weeklyTemplate ?? undefined,
              ...(b.weeklyTemplate === null ? { weeklyTemplate: [] } : {}) }
          : {}),
        ...(b.faceDescriptors !== undefined
          ? b.faceDescriptors === null
            ? { faceDescriptors: [], facePhotoUrls: [], faceConsentAt: null }
            : { faceDescriptors: b.faceDescriptors }
          : {}),
        ...(b.facePhotoUrls !== undefined && b.faceDescriptors !== null
          ? { facePhotoUrls: b.facePhotoUrls ?? [] }
          : {}),
        ...(b.faceConsentAt !== undefined && b.faceDescriptors !== null
          ? { faceConsentAt: b.faceConsentAt ? new Date(b.faceConsentAt) : null }
          : {}),
      },
      include: { user: { select: { id: true, name: true, email: true } } },
    });
    return NextResponse.json({ employee });
  } catch (err) {
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2002"
    ) {
      return NextResponse.json({ error: "name_taken" }, { status: 409 });
    }
    throw err;
  }
}

/** DELETE = soft-delete (active:false) — los turnos históricos quedan. */
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const ctx = await getErpContext(GATE);
  if (isDenied(ctx)) {
    return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  }
  const { id } = await params;
  if (!(await loadOwned(id, ctx.restaurantId))) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  await db.employee.update({ where: { id }, data: { active: false } });
  return NextResponse.json({ ok: true });
}
