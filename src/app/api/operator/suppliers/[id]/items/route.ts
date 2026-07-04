import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { getErpContext, isDenied } from "@/lib/erp/access";
import type { ModuleSlug } from "@/lib/modules";

export const dynamic = "force-dynamic";

const GATE: ModuleSlug[] = ["purchasing"];

const createSchema = z.object({
  ingredientId: z.string().min(1),
  presentationLabel: z.string().trim().min(1).max(80),
  // Contenido de UNA presentación en unidad base del insumo (g/ml/un).
  contentQty: z.number().int().min(1).max(2_000_000_000),
  lastPriceCents: z.number().int().min(0).max(2_000_000_000).nullable().optional(),
  supplierSku: z.string().trim().max(60).nullable().optional(),
  preferred: z.boolean().optional(),
});

/** POST /api/operator/suppliers/[id]/items — agrega un insumo a la lista
 *  de precios del proveedor. */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const ctx = await getErpContext(GATE);
  if (isDenied(ctx)) {
    return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  }
  const { id: supplierId } = await params;

  const supplier = await db.supplier.findUnique({
    where: { id: supplierId },
    select: { restaurantId: true },
  });
  if (!supplier || supplier.restaurantId !== ctx.restaurantId) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const parsed = createSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid" }, { status: 400 });
  }
  const b = parsed.data;

  // El insumo debe ser del mismo comercio.
  const ingredient = await db.ingredient.findUnique({
    where: { id: b.ingredientId },
    select: { restaurantId: true },
  });
  if (!ingredient || ingredient.restaurantId !== ctx.restaurantId) {
    return NextResponse.json({ error: "ingredient_not_found" }, { status: 400 });
  }

  const dup = await db.supplierIngredient.findUnique({
    where: {
      supplierId_ingredientId: { supplierId, ingredientId: b.ingredientId },
    },
    select: { id: true },
  });
  if (dup) {
    return NextResponse.json({ error: "already_listed" }, { status: 409 });
  }

  const item = await db.$transaction(async (tx) => {
    // Máx. 1 proveedor preferido por insumo: marcar este desmarca el resto.
    if (b.preferred) {
      await tx.supplierIngredient.updateMany({
        where: { ingredientId: b.ingredientId, preferred: true },
        data: { preferred: false },
      });
    }
    return tx.supplierIngredient.create({
      data: {
        supplierId,
        ingredientId: b.ingredientId,
        presentationLabel: b.presentationLabel,
        contentQty: b.contentQty,
        lastPriceCents: b.lastPriceCents ?? null,
        supplierSku: b.supplierSku || null,
        preferred: b.preferred ?? false,
      },
      include: {
        ingredient: {
          select: { id: true, name: true, measureKind: true, active: true },
        },
      },
    });
  });

  return NextResponse.json({ item }, { status: 201 });
}
