import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { getErpContext, isDenied } from "@/lib/erp/access";
import { applyStockMovement, StockError } from "@/lib/erp/stock";
import type { ModuleSlug } from "@/lib/modules";

export const dynamic = "force-dynamic";

const GATE: ModuleSlug[] = ["inventory"];

// Kinds que la API acepta en A1 (sale_consumption/transfer/production
// llegan con A4/A5 desde sus propios flujos; count_adjust solo lo genera
// el cierre de conteo).
const MANUAL_KINDS = ["purchase_in", "adjust_in", "adjust_out", "waste"] as const;

const createSchema = z
  .object({
    ingredientId: z.string().min(1),
    kind: z.enum(MANUAL_KINDS),
    qtyBase: z.number().int().min(1).max(2_000_000_000),
    // Solo entradas de mercancía: costo total de lo que entra.
    totalCostCents: z.number().int().min(0).max(2_000_000_000).nullable().optional(),
    wasteReason: z
      .enum(["expired", "damaged", "kitchen_error", "spill", "other"])
      .nullable()
      .optional(),
    note: z.string().trim().max(500).nullable().optional(),
  })
  .refine((b) => b.kind !== "waste" || !!b.wasteReason, {
    message: "waste_reason_required",
  });

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

  try {
    const result = await db.$transaction((tx) =>
      applyStockMovement(tx, {
        restaurantId: ctx.restaurantId,
        ingredientId: b.ingredientId,
        kind: b.kind,
        qtyBase: b.qtyBase,
        totalCostCents: b.kind === "purchase_in" ? (b.totalCostCents ?? null) : null,
        wasteReason: b.kind === "waste" ? b.wasteReason : null,
        note: b.note ?? null,
        createdById: session?.user?.id ?? null,
      }),
    );
    return NextResponse.json(
      { movement: result.movement, level: result.level },
      { status: 201 },
    );
  } catch (err) {
    if (err instanceof StockError) {
      const status = err.code === "ingredient_not_found" ? 404 : 400;
      return NextResponse.json({ error: err.code }, { status });
    }
    throw err;
  }
}

export async function GET(req: Request) {
  const ctx = await getErpContext(GATE);
  if (isDenied(ctx)) {
    return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  }
  const { searchParams } = new URL(req.url);
  const ingredientId = searchParams.get("ingredientId") ?? undefined;
  const cursor = searchParams.get("cursor") ?? undefined;

  const movements = await db.stockMovement.findMany({
    where: {
      restaurantId: ctx.restaurantId,
      ...(ingredientId ? { ingredientId } : {}),
    },
    take: 30,
    ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    orderBy: { createdAt: "desc" },
    include: {
      ingredient: { select: { id: true, name: true, measureKind: true } },
      createdBy: { select: { id: true, name: true } },
    },
  });
  const nextCursor =
    movements.length === 30 ? movements[movements.length - 1].id : undefined;
  return NextResponse.json({ movements, nextCursor });
}
