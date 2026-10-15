import { secureApi } from "@/lib/secureApi";
import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { lockStock } from "@/lib/orderLock";
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
async function POSTHandler(
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

  const result = await db.$transaction(async (tx) => {
    // Check the current archive state under the same lock as ingredient PATCH.
    // Existing supplier presentations remain available for historical records.
    await lockStock(tx, ctx.restaurantId);
    const ingredient = await tx.ingredient.findUnique({
      where: { id: b.ingredientId },
      select: { restaurantId: true, active: true },
    });
    if (!ingredient || ingredient.restaurantId !== ctx.restaurantId) {
      return { error: "ingredient_not_found" as const, status: 400 };
    }
    if (!ingredient.active) {
      return { error: "ingredient_inactive" as const, status: 400 };
    }

    const dup = await tx.supplierIngredient.findUnique({
      where: {
        supplierId_ingredientId: { supplierId, ingredientId: b.ingredientId },
      },
      select: { id: true },
    });
    if (dup) return { error: "already_listed" as const, status: 409 };

    // Máx. 1 proveedor preferido por insumo: marcar este desmarca el resto.
    if (b.preferred) {
      await tx.supplierIngredient.updateMany({
        where: { ingredientId: b.ingredientId, preferred: true },
        data: { preferred: false },
      });
    }
    const item = await tx.supplierIngredient.create({
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
    return { item };
  });

  if ("error" in result) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }
  return NextResponse.json(result, { status: 201 });
}

export const POST = secureApi(POSTHandler);
