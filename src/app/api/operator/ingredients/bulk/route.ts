import { secureApi } from "@/lib/secureApi";
import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { getErpContext, isDenied } from "@/lib/erp/access";
import { lockStock } from "@/lib/orderLock";
import { recordAuditEvent } from "@/lib/auditLog";
import type { ModuleSlug } from "@/lib/modules";

export const dynamic = "force-dynamic";

const GATE: ModuleSlug[] = ["inventory", "purchasing", "recipes"];

const bodySchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("category"),
    ids: z.array(z.string().min(1)).min(1).max(1000),
    // null / "" = quitar categoría.
    category: z.string().trim().max(60).nullable(),
  }),
  z.object({
    action: z.literal("measureKind"),
    ids: z.array(z.string().min(1)).min(1).max(1000),
    measureKind: z.enum(["mass", "volume", "count"]),
  }),
  // Renombrar una categoría: afecta a TODOS los insumos de `from` (no depende
  // de la selección). Es gestión de categorías, no acción por-fila.
  z.object({
    action: z.literal("renameCategory"),
    from: z.string().trim().min(1).max(60),
    to: z.string().trim().min(1).max(60),
  }),
]);

/**
 * Acciones masivas sobre insumos (misma sección Insumos): cambiar categoría
 * o cambiar la dimensión de medida de varios a la vez.
 *
 * La dimensión NO se cambia en insumos con referencias que reinterpretarían
 * cantidades (proveedores, movimientos o saldo) — mismo criterio que el PATCH
 * individual (measure_locked). Esos se OMITEN y se reportan (skipped).
 */
async function POSTHandler(req: Request) {
  const ctx = await getErpContext(GATE);
  if (isDenied(ctx)) {
    return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  }
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid" }, { status: 400 });
  }
  const b = parsed.data;

  // Renombrar categoría: opera sobre TODOS los insumos de `from` del comercio,
  // no sobre una selección. Si `to` == `from`, no hay nada que hacer.
  if (b.action === "renameCategory") {
    const from = b.from.trim();
    const to = b.to.trim();
    const affected = await db.ingredient.findMany({
      where: { restaurantId: ctx.restaurantId, category: from },
      select: { id: true },
    });
    const changedIds = affected.map((a) => a.id);
    if (changedIds.length > 0 && to !== from) {
      await db.ingredient.updateMany({
        where: { restaurantId: ctx.restaurantId, category: from },
        data: { category: to },
      });
    }
    return NextResponse.json({
      updated: to !== from ? changedIds.length : 0,
      skipped: 0,
      changedIds,
      to,
    });
  }

  // Solo insumos del comercio (evita tocar filas de otro restaurante si el
  // cliente manda ids ajenos).
  const owned = await db.ingredient.findMany({
    where: { id: { in: b.ids }, restaurantId: ctx.restaurantId },
    select: { id: true, _count: { select: { supplierItems: true } } },
  });
  if (owned.length === 0) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  if (b.action === "category") {
    const category = b.category?.trim() || null;
    const changedIds = owned.map((o) => o.id);
    await db.ingredient.updateMany({
      where: { id: { in: changedIds }, restaurantId: ctx.restaurantId },
      data: { category },
    });
    return NextResponse.json({ updated: changedIds.length, skipped: 0, changedIds });
  }

  // Changing units cannot reinterpret supplier presentations, stock or its
  // historical movements. A request for the existing dimension is a safe no-op.
  const result = await db.$transaction(async (tx) => {
    // Price and dimension edits must see the same current units. An individual
    // PATCH can otherwise save a kg price after a bulk edit changed the item to L.
    await lockStock(tx, ctx.restaurantId);
    const latest = await tx.ingredient.findMany({
      where: { id: { in: b.ids }, restaurantId: ctx.restaurantId },
      select: {
        id: true, name: true, measureKind: true, referencePriceCents: true,
        stockLevel: { select: { qtyBase: true, totalValueCents: true } },
        _count: { select: { supplierItems: true, stockMovements: true } },
      },
    });
    const eligible = latest.filter((item) => item.measureKind === b.measureKind || (
      item._count.supplierItems === 0 && item._count.stockMovements === 0 &&
      (!item.stockLevel || (item.stockLevel.qtyBase === 0 && item.stockLevel.totalValueCents === 0))
    ));
    const dimensionChanged = eligible.filter((item) => item.measureKind !== b.measureKind);
    if (dimensionChanged.length > 0) {
      await tx.ingredient.updateMany({
        where: { id: { in: dimensionChanged.map((item) => item.id) }, restaurantId: ctx.restaurantId },
        data: { measureKind: b.measureKind, referencePriceCents: null },
      });
    }
    return { changedIds: eligible.map((item) => item.id), skipped: latest.length - eligible.length, dimensionChanged };
  });
  await Promise.all(result.dimensionChanged.filter((item) => item.referencePriceCents != null).map((item) => recordAuditEvent({
    kind: "ingredient.reference_price.update",
    restaurantId: ctx.restaurantId,
    target: { type: "ingredient", id: item.id },
    summary: item.name,
    diff: {
      before: { referencePriceCents: item.referencePriceCents, measureKind: item.measureKind },
      after: { referencePriceCents: null, measureKind: b.measureKind },
    },
  })));
  return NextResponse.json({ updated: result.changedIds.length, skipped: result.skipped, changedIds: result.changedIds });
}

export const POST = secureApi(POSTHandler);
