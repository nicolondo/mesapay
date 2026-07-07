// Producción de batches (ERP Fase A5).
//
// Un batch registra producción YA HECHA de una sub-receta (A3): salen
// los ingredientes con production_out valorados al promedio actual y
// entra el elaborado con production_in por el costo EXACTO de lo que
// salió (enteros exactos — el promedio del elaborado queda real).
// Producir nunca se bloquea: stock negativo permitido (regla A1) y una
// línea sin costo deja el batch con costo parcial (flag derivado, nunca
// se inventa un costo).
import type { Prisma } from "@prisma/client";
import { applyStockMovement } from "@/lib/erp/stock";
import { grossQty } from "@/lib/erp/recipes";

export class ProductionError extends Error {
  constructor(public code: "no_subrecipe" | "qty_invalid") {
    super(code);
  }
}

export type BatchLine = { ingredientId: string; qtyBase: number };

/**
 * Escala las líneas de la sub-receta a la cantidad producida (pura):
 * consumo = round(bruto_por_rendimiento × producido / rendimiento).
 * Bruto aplica la merma de la línea (mismo grossQty del costeo A3);
 * UN redondeo al final por línea. Líneas que escalan a 0 se filtran.
 */
export function scaleBatchLines(
  recipeItems: Array<{ ingredientId: string; qtyBase: number; wastePct: number }>,
  outputQtyBase: number,
  producedQtyBase: number,
): BatchLine[] {
  if (outputQtyBase <= 0 || producedQtyBase <= 0) return [];
  const factor = producedQtyBase / outputQtyBase;
  return recipeItems
    .map((it) => ({
      ingredientId: it.ingredientId,
      qtyBase: Math.round(grossQty(it.qtyBase, it.wastePct) * factor),
    }))
    .filter((l) => l.qtyBase > 0);
}

export type RunProductionArgs = {
  restaurantId: string;
  outputIngredientId: string;
  /** Cantidad producida, en unidad base del elaborado. */
  outputQtyBase: number;
  note?: string | null;
  createdById?: string | null;
};

/**
 * Ejecuta un batch DENTRO de una transacción: valida la sub-receta,
 * aplica los production_out (capturando el valor real de cada salida),
 * el production_in con el costo acumulado y crea el ProductionBatch.
 */
export async function runProduction(
  tx: Prisma.TransactionClient,
  args: RunProductionArgs,
) {
  if (
    !Number.isInteger(args.outputQtyBase) ||
    args.outputQtyBase <= 0 ||
    args.outputQtyBase > 2_000_000_000
  ) {
    throw new ProductionError("qty_invalid");
  }

  const recipe = await tx.recipe.findFirst({
    where: {
      restaurantId: args.restaurantId,
      outputIngredientId: args.outputIngredientId,
    },
    select: {
      outputQtyBase: true,
      items: { select: { ingredientId: true, qtyBase: true, wastePct: true } },
    },
  });
  if (!recipe || !recipe.outputQtyBase || recipe.outputQtyBase <= 0) {
    throw new ProductionError("no_subrecipe");
  }
  const lines = scaleBatchLines(
    recipe.items,
    recipe.outputQtyBase,
    args.outputQtyBase,
  );
  if (lines.length === 0) throw new ProductionError("no_subrecipe");

  // El batch nace con costo 0 (los movimientos necesitan su id) y se
  // sella al final con la suma real de las salidas.
  const batch = await tx.productionBatch.create({
    data: {
      restaurantId: args.restaurantId,
      outputIngredientId: args.outputIngredientId,
      outputQtyBase: args.outputQtyBase,
      costCents: 0,
      note: args.note || null,
      createdById: args.createdById ?? null,
    },
  });

  let costCents = 0;
  let partialCost = false;
  for (const line of lines) {
    const { movement } = await applyStockMovement(
      tx,
      {
        restaurantId: args.restaurantId,
        ingredientId: line.ingredientId,
        kind: "production_out",
        qtyBase: line.qtyBase,
        productionBatchId: batch.id,
        createdById: args.createdById ?? null,
      },
      // Un insumo descatalogado en una receta viva sigue consumiendo —
      // mismo criterio que conteos y consumo por venta.
      { allowInactive: true },
    );
    const value = Math.abs(movement.valueCents);
    costCents += value;
    if (value === 0) partialCost = true;
  }

  await applyStockMovement(
    tx,
    {
      restaurantId: args.restaurantId,
      ingredientId: args.outputIngredientId,
      kind: "production_in",
      qtyBase: args.outputQtyBase,
      totalCostCents: costCents,
      productionBatchId: batch.id,
      createdById: args.createdById ?? null,
    },
    { allowInactive: true },
  );

  const sealed = await tx.productionBatch.update({
    where: { id: batch.id },
    data: { costCents },
    include: {
      outputIngredient: { select: { id: true, name: true, measureKind: true } },
      createdBy: { select: { id: true, name: true } },
    },
  });
  return { batch: sealed, partialCost };
}
