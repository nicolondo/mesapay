import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { getErpContext, isDenied } from "@/lib/erp/access";
import { ProductionError, runProduction } from "@/lib/erp/production";
import type { ModuleSlug } from "@/lib/modules";

export const dynamic = "force-dynamic";

const GATE: ModuleSlug[] = ["production"];

/** Historial de batches (paginado 20, cursor — patrón purchase-orders). */
export async function GET(req: Request) {
  const ctx = await getErpContext(GATE);
  if (isDenied(ctx)) {
    return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  }
  const { searchParams } = new URL(req.url);
  const cursor = searchParams.get("cursor") ?? undefined;

  const batches = await db.productionBatch.findMany({
    where: { restaurantId: ctx.restaurantId },
    take: 20,
    ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    orderBy: { createdAt: "desc" },
    include: {
      outputIngredient: { select: { id: true, name: true, measureKind: true } },
      createdBy: { select: { id: true, name: true } },
      // Salidas del batch — la UI muestra qué se consumió; el flag de
      // costo parcial se deriva de las salidas con valor 0.
      movements: {
        where: { kind: "production_out" },
        select: {
          ingredientId: true,
          qtyBase: true,
          valueCents: true,
          ingredient: { select: { name: true, measureKind: true } },
        },
      },
    },
  });
  const rows = batches.map((b) => ({
    ...b,
    partialCost: b.movements.some((m) => m.valueCents === 0),
  }));
  const nextCursor = batches.length === 20 ? batches[batches.length - 1].id : undefined;
  return NextResponse.json({ batches: rows, nextCursor });
}

const createSchema = z.object({
  outputIngredientId: z.string().min(1),
  // Cantidad producida en unidad base del elaborado.
  outputQtyBase: z.number().int().min(1).max(2_000_000_000),
  note: z.string().trim().max(500).nullable().optional(),
});

export async function POST(req: Request) {
  const ctx = await getErpContext(GATE);
  if (isDenied(ctx)) {
    return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  }
  const parsed = createSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid" }, { status: 400 });
  }
  const b = parsed.data;

  const output = await db.ingredient.findUnique({
    where: { id: b.outputIngredientId },
    select: { restaurantId: true },
  });
  if (!output || output.restaurantId !== ctx.restaurantId) {
    return NextResponse.json({ error: "ingredient_not_found" }, { status: 404 });
  }

  const session = await auth();
  try {
    const result = await db.$transaction((tx) =>
      runProduction(tx, {
        restaurantId: ctx.restaurantId,
        outputIngredientId: b.outputIngredientId,
        outputQtyBase: b.outputQtyBase,
        note: b.note ?? null,
        createdById: session?.user?.id ?? null,
      }),
    );
    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    if (err instanceof ProductionError) {
      return NextResponse.json({ error: err.code }, { status: 400 });
    }
    throw err;
  }
}
