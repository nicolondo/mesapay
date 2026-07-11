import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { getErpContext, isDenied } from "@/lib/erp/access";
import { applyStockMovement, StockError } from "@/lib/erp/stock";
import type { ModuleSlug } from "@/lib/modules";

export const dynamic = "force-dynamic";
export const maxDuration = 120; // catálogos grandes → muchas filas en la tx

const GATE: ModuleSlug[] = ["inventory"];

const lineSchema = z.object({
  // null ⇒ insumo nuevo; si trae id, es un insumo existente emparejado.
  matchedIngredientId: z.string().min(1).nullable(),
  name: z.string().trim().min(1).max(120),
  measureKind: z.enum(["mass", "volume", "count"]),
  category: z.string().trim().max(60).nullable().optional(),
  // Ya en unidad base (el cliente convirtió con toBaseQty). 0 = no sembrar.
  qtyBase: z.number().int().min(0).max(2_000_000_000),
  // Valor de la existencia inicial (cantidad × costo), en centavos.
  totalCostCents: z.number().int().min(0).max(2_000_000_000),
});

const bodySchema = z.object({
  rows: z.array(lineSchema).min(1).max(1000),
  // Sembrar existencias también en los insumos que YA existen (emparejados).
  updateExisting: z.boolean().optional().default(false),
});

/**
 * Confirma la importación: crea los insumos nuevos y siembra el
 * inventario inicial VALORADO (adjust_in con costo) — todo en una sola
 * transacción. Los que ya existen no se re-crean; solo se les siembra
 * stock si `updateExisting`.
 */
export async function POST(req: Request) {
  const ctx = await getErpContext(GATE);
  if (isDenied(ctx)) {
    return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  }
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid" }, { status: 400 });
  }
  const { rows, updateExisting } = parsed.data;
  const session = await auth();
  const createdById = session?.user?.id ?? null;

  try {
    const result = await db.$transaction(
      async (tx) => {
        let created = 0;
        let seeded = 0;
        for (const r of rows) {
          const isNew = !r.matchedIngredientId;
          let ingredientId = r.matchedIngredientId;

          if (isNew) {
            // Dedup exacto por (restaurantId, name) — evita chocar con el
            // @@unique si el nombre ya existe o se repite en el archivo.
            const existing = await tx.ingredient.findUnique({
              where: {
                restaurantId_name: { restaurantId: ctx.restaurantId, name: r.name },
              },
              select: { id: true },
            });
            if (existing) {
              ingredientId = existing.id;
            } else {
              const ing = await tx.ingredient.create({
                data: {
                  restaurantId: ctx.restaurantId,
                  name: r.name,
                  measureKind: r.measureKind,
                  category: r.category || null,
                },
                select: { id: true },
              });
              ingredientId = ing.id;
              created++;
            }
          } else {
            // Emparejado: validar pertenencia al comercio.
            const ing = await tx.ingredient.findUnique({
              where: { id: ingredientId! },
              select: { restaurantId: true },
            });
            if (ing?.restaurantId !== ctx.restaurantId) {
              throw new StockError("ingredient_not_found");
            }
          }

          // Sembrar existencia inicial valorada (adjust_in con costo).
          if (r.qtyBase > 0 && (isNew || updateExisting)) {
            await applyStockMovement(
              tx,
              {
                restaurantId: ctx.restaurantId,
                ingredientId: ingredientId!,
                kind: "adjust_in",
                qtyBase: r.qtyBase,
                totalCostCents: r.totalCostCents,
                note: "Importación inicial",
                createdById,
              },
              { allowInactive: true },
            );
            seeded++;
          }
        }
        return { created, seeded };
      },
      { timeout: 60_000 },
    );
    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    if (err instanceof StockError) {
      return NextResponse.json({ error: err.code }, { status: 400 });
    }
    throw err;
  }
}
