import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { getErpContext, isDenied } from "@/lib/erp/access";
import type { ModuleSlug } from "@/lib/modules";

export const dynamic = "force-dynamic";

const GATE: ModuleSlug[] = ["inventory"];

// Campos que el cliente muestra por item de conteo.
const ITEM_INCLUDE = {
  ingredient: {
    select: {
      id: true,
      name: true,
      measureKind: true,
      category: true,
      active: true,
    },
  },
} as const;

/** Sesiones de conteo (recientes primero). Livianas: los items completos
 * se piden por sesión en GET /counts/[id]. */
export async function GET() {
  const ctx = await getErpContext(GATE);
  if (isDenied(ctx)) {
    return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  }
  const counts = await db.stockCount.findMany({
    where: { restaurantId: ctx.restaurantId },
    orderBy: { createdAt: "desc" },
    take: 20,
    select: {
      id: true,
      status: true,
      notes: true,
      createdAt: true,
      closedAt: true,
      createdBy: { select: { name: true } },
      _count: { select: { items: true } },
    },
  });
  return NextResponse.json({ counts });
}

const createSchema = z.object({
  // Filtro exacto por categoría del insumo; null/ausente = todos los activos.
  category: z.string().trim().min(1).max(120).nullable().optional(),
  notes: z.string().trim().max(500).nullable().optional(),
});

/**
 * Crea una sesión de conteo en borrador (spec D5): congela el teórico
 * (expectedQty = StockLevel.qtyBase actual, 0 sin nivel) de TODOS los
 * insumos activos (o del subconjunto de una categoría). Máx. 1 borrador
 * abierto por comercio.
 */
export async function POST(req: Request) {
  const ctx = await getErpContext(GATE);
  if (isDenied(ctx)) {
    return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  }
  const session = await auth();
  const parsed = createSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid" }, { status: 400 });
  }
  const b = parsed.data;

  // Chequeo de draft abierto + snapshot del teórico + creación en la MISMA
  // transacción: minimiza la carrera de dos POST simultáneos y garantiza
  // que expectedQty sea consistente con el instante de creación.
  const result = await db.$transaction(async (tx) => {
    const open = await tx.stockCount.findFirst({
      where: { restaurantId: ctx.restaurantId, status: "draft" },
      select: { id: true },
    });
    if (open) return { error: "count_open_exists" as const };

    const ingredients = await tx.ingredient.findMany({
      where: {
        restaurantId: ctx.restaurantId,
        active: true,
        ...(b.category ? { category: b.category } : {}),
      },
      select: { id: true, stockLevel: { select: { qtyBase: true } } },
    });
    if (ingredients.length === 0) return { error: "no_ingredients" as const };

    const created = await tx.stockCount.create({
      data: {
        restaurantId: ctx.restaurantId,
        notes: b.notes || null,
        createdById: session?.user?.id ?? null,
      },
    });
    await tx.stockCountItem.createMany({
      data: ingredients.map((i) => ({
        countId: created.id,
        ingredientId: i.id,
        expectedQty: i.stockLevel?.qtyBase ?? 0,
      })),
    });
    const count = await tx.stockCount.findUniqueOrThrow({
      where: { id: created.id },
      include: {
        createdBy: { select: { name: true } },
        items: {
          include: ITEM_INCLUDE,
          orderBy: { ingredient: { name: "asc" } },
        },
      },
    });
    return { count };
  });

  if ("error" in result) {
    return NextResponse.json(
      { error: result.error },
      { status: result.error === "count_open_exists" ? 409 : 400 },
    );
  }
  return NextResponse.json({ count: result.count }, { status: 201 });
}
