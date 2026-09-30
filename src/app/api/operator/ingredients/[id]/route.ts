import { lockStock } from "@/lib/orderLock";
import { secureApi } from "@/lib/secureApi";
import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { getErpContext, isDenied } from "@/lib/erp/access";
import { BARCODE_MAX_LENGTH, normalizeBarcode } from "@/lib/erp/barcode";
import { disableInventoryTracking } from "@/lib/erp/stockTracking";
import type { ModuleSlug } from "@/lib/modules";

export const dynamic = "force-dynamic";

const GATE: ModuleSlug[] = ["inventory", "purchasing", "recipes"];

const resetStockSchema = z.object({
  qtyBase: z.number().int().min(-2_147_483_648).max(2_147_483_647),
  totalValueCents: z.number().int().min(-2_147_483_648).max(2_147_483_647),
  updatedAt: z.string().datetime().nullable(),
  ingredientUpdatedAt: z.string().datetime(),
  movementCount: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  measureKind: z.enum(["mass", "volume", "count"]),
}).strict();

const patchSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  category: z.string().trim().max(60).nullable().optional(),
  // measureKind solo se acepta si el insumo no tiene referencias —
  // cambiar la dimensión con datos históricos corrompería cantidades.
  measureKind: z.enum(["mass", "volume", "count"]).optional(),
  sku: z.string().trim().max(60).nullable().optional(),
  // Crudo del lector; se normaliza abajo (ver POST /ingredients).
  barcode: z.string().max(BARCODE_MAX_LENGTH).nullable().optional(),
  notes: z.string().trim().max(1000).nullable().optional(),
  active: z.boolean().optional(),
  trackInventory: z.boolean().optional(),
  resetStock: resetStockSchema.optional(),
  // A4 — punto de reorden y cantidad sugerida, en unidad base (null = sin
  // aviso / pedir hasta cubrir el punto).
  reorderPointBase: z.number().int().min(1).max(2_000_000_000).nullable().optional(),
  reorderQtyBase: z.number().int().min(1).max(2_000_000_000).nullable().optional(),
}).refine((body) => body.resetStock === undefined || body.trackInventory === false, {
  path: ["resetStock"], message: "reset_requires_inventory_disable",
});

async function loadOwned(id: string, restaurantId: string) {
  const ing = await db.ingredient.findUnique({
    where: { id },
    include: { _count: { select: { supplierItems: true } } },
  });
  if (!ing || ing.restaurantId !== restaurantId) return null;
  return ing;
}

async function PATCHHandler(
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

  // El código de barras es único por comercio (si no, el escaneo en el
  // conteo sería ambiguo): se avisa con un error legible antes del índice.
  const barcode =
    b.barcode !== undefined ? normalizeBarcode(b.barcode) : undefined;
  if (barcode != null && barcode !== ing.barcode) {
    const dupCode = await db.ingredient.findUnique({
      where: {
        restaurantId_barcode: { restaurantId: ctx.restaurantId, barcode },
      },
      select: { id: true },
    });
    if (dupCode) {
      return NextResponse.json({ error: "barcode_taken" }, { status: 409 });
    }
  }

  const updated = await db.$transaction(async (tx) => {
    await lockStock(tx, ctx.restaurantId);
    const latest = await tx.ingredient.findUnique({ where: { id }, include: { _count: { select: { supplierItems: true } } } });
    if (!latest || latest.restaurantId !== ctx.restaurantId) return { error: "not_found" as const };
    // Check dimensions again under the stock lock: a purchase/adjustment may
    // have arrived after loadOwned, and historical quantities cannot change units.
    if (b.measureKind !== undefined && b.measureKind !== latest.measureKind) {
      const [level, movementCount] = await Promise.all([
        tx.stockLevel.findUnique({ where: { ingredientId: id } }),
        tx.stockMovement.count({ where: { restaurantId: ctx.restaurantId, ingredientId: id } }),
      ]);
      if (b.resetStock || latest._count.supplierItems > 0 || movementCount > 0 ||
          (level && (level.qtyBase !== 0 || level.totalValueCents !== 0))) {
        return { error: "measure_locked" as const };
      }
    }
    const tracked = b.trackInventory ?? latest.trackInventory;
    if (!tracked) {
      const result = await disableInventoryTracking(tx, {
        restaurantId: ctx.restaurantId, ingredientId: id,
        createdById: ctx.userId, resetStock: b.resetStock,
      });
      if ("error" in result) return result;
    }
    return tx.ingredient.update({
      where: { id, restaurantId: ctx.restaurantId },
      data: {
        ...(b.name !== undefined ? { name: b.name } : {}),
        ...(b.category !== undefined ? { category: b.category || null } : {}),
        ...(b.measureKind !== undefined ? { measureKind: b.measureKind } : {}),
        ...(b.sku !== undefined ? { sku: b.sku || null } : {}),
        ...(barcode !== undefined ? { barcode } : {}),
        ...(b.notes !== undefined ? { notes: b.notes || null } : {}),
        ...(b.active !== undefined ? { active: b.active } : {}),
        ...(b.trackInventory !== undefined ? { trackInventory: b.trackInventory } : {}),
        ...(b.reorderPointBase !== undefined
          ? { reorderPointBase: b.reorderPointBase }
          : {}),
        ...(b.reorderQtyBase !== undefined
          ? { reorderQtyBase: b.reorderQtyBase }
          : {}),
        ...(!tracked ? { reorderPointBase: null, reorderQtyBase: null } : {}),
      },
    });
  });
  if ("error" in updated) {
    return NextResponse.json(updated, { status: updated.error === "not_found" ? 404 : 409 });
  }
  return NextResponse.json({ ingredient: updated });
}

/** DELETE = soft-delete (active:false). Las fases A1-A4 referencian
 *  estas filas; borrar físicamente rompería trazabilidad. */
async function DELETEHandler(
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

export const PATCH = secureApi(PATCHHandler);

export const DELETE = secureApi(DELETEHandler);
