import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { getErpContext, isDenied } from "@/lib/erp/access";
import type { ModuleSlug } from "@/lib/modules";

export const dynamic = "force-dynamic";

const GATE: ModuleSlug[] = ["purchasing"];

const patchSchema = z.object({
  presentationLabel: z.string().trim().min(1).max(80).optional(),
  contentQty: z.number().int().min(1).max(2_000_000_000).optional(),
  lastPriceCents: z.number().int().min(0).max(2_000_000_000).nullable().optional(),
  supplierSku: z.string().trim().max(60).nullable().optional(),
  preferred: z.boolean().optional(),
});

async function loadOwned(id: string, restaurantId: string) {
  const item = await db.supplierIngredient.findUnique({
    where: { id },
    include: { supplier: { select: { restaurantId: true } } },
  });
  if (!item || item.supplier.restaurantId !== restaurantId) return null;
  return item;
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
  const item = await loadOwned(id, ctx.restaurantId);
  if (!item) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const parsed = patchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid" }, { status: 400 });
  }
  const b = parsed.data;

  const updated = await db.$transaction(async (tx) => {
    if (b.preferred === true) {
      // Máx. 1 preferido por insumo.
      await tx.supplierIngredient.updateMany({
        where: { ingredientId: item.ingredientId, preferred: true },
        data: { preferred: false },
      });
    }
    return tx.supplierIngredient.update({
      where: { id },
      data: {
        ...(b.presentationLabel !== undefined
          ? { presentationLabel: b.presentationLabel }
          : {}),
        ...(b.contentQty !== undefined ? { contentQty: b.contentQty } : {}),
        ...(b.lastPriceCents !== undefined
          ? { lastPriceCents: b.lastPriceCents }
          : {}),
        ...(b.supplierSku !== undefined
          ? { supplierSku: b.supplierSku || null }
          : {}),
        ...(b.preferred !== undefined ? { preferred: b.preferred } : {}),
      },
      include: {
        ingredient: {
          select: { id: true, name: true, measureKind: true, active: true },
        },
      },
    });
  });

  return NextResponse.json({ item: updated });
}

/** DELETE físico: una fila de lista de precios no tiene historia propia en
 *  A0 (el historial de precios nace en A2 con las recepciones de OC). */
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const ctx = await getErpContext(GATE);
  if (isDenied(ctx)) {
    return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  }
  const { id } = await params;
  const item = await loadOwned(id, ctx.restaurantId);
  if (!item) return NextResponse.json({ error: "not_found" }, { status: 404 });

  await db.supplierIngredient.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}
