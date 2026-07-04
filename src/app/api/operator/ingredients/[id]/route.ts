import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { getErpContext, isDenied } from "@/lib/erp/access";
import type { ModuleSlug } from "@/lib/modules";

export const dynamic = "force-dynamic";

const GATE: ModuleSlug[] = ["inventory", "purchasing", "recipes"];

const patchSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  category: z.string().trim().max(60).nullable().optional(),
  // measureKind solo se acepta si el insumo no tiene referencias —
  // cambiar la dimensión con datos históricos corrompería cantidades.
  measureKind: z.enum(["mass", "volume", "count"]).optional(),
  sku: z.string().trim().max(60).nullable().optional(),
  notes: z.string().trim().max(1000).nullable().optional(),
  active: z.boolean().optional(),
});

async function loadOwned(id: string, restaurantId: string) {
  const ing = await db.ingredient.findUnique({
    where: { id },
    include: { _count: { select: { supplierItems: true } } },
  });
  if (!ing || ing.restaurantId !== restaurantId) return null;
  return ing;
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
  const ing = await loadOwned(id, ctx.restaurantId);
  if (!ing) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const parsed = patchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid" }, { status: 400 });
  }
  const b = parsed.data;

  // Dimensión bloqueada cuando ya hay referencias (hoy: lista de precios;
  // mañana: movimientos de stock y recetas).
  const hasRefs = ing._count.supplierItems > 0;
  if (
    b.measureKind !== undefined &&
    b.measureKind !== ing.measureKind &&
    hasRefs
  ) {
    return NextResponse.json({ error: "measure_locked" }, { status: 409 });
  }

  if (b.name !== undefined && b.name !== ing.name) {
    const dup = await db.ingredient.findUnique({
      where: {
        restaurantId_name: { restaurantId: ctx.restaurantId, name: b.name },
      },
      select: { id: true },
    });
    if (dup) return NextResponse.json({ error: "name_taken" }, { status: 409 });
  }

  const updated = await db.ingredient.update({
    where: { id },
    data: {
      ...(b.name !== undefined ? { name: b.name } : {}),
      ...(b.category !== undefined ? { category: b.category || null } : {}),
      ...(b.measureKind !== undefined ? { measureKind: b.measureKind } : {}),
      ...(b.sku !== undefined ? { sku: b.sku || null } : {}),
      ...(b.notes !== undefined ? { notes: b.notes || null } : {}),
      ...(b.active !== undefined ? { active: b.active } : {}),
    },
  });
  return NextResponse.json({ ingredient: updated });
}

/** DELETE = soft-delete (active:false). Las fases A1-A4 referencian
 *  estas filas; borrar físicamente rompería trazabilidad. */
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const ctx = await getErpContext(GATE);
  if (isDenied(ctx)) {
    return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  }
  const { id } = await params;
  const ing = await loadOwned(id, ctx.restaurantId);
  if (!ing) return NextResponse.json({ error: "not_found" }, { status: 404 });

  await db.ingredient.update({ where: { id }, data: { active: false } });
  return NextResponse.json({ ok: true });
}
