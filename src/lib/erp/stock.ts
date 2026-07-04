import type { Prisma, StockMovementKind, WasteReason } from "@prisma/client";

// Lógica central de inventario (ERP Fase A1).
//
// applyStockMovement es el ÚNICO camino para tocar inventario — A2
// (recepción de OC), A4 (consumo por venta) y A5 (traslados/producción) lo
// reutilizan. Siempre dentro de una transacción: actualiza StockLevel y
// APPENDEA el movimiento (el libro nunca se edita; una equivocación se
// corrige con un movimiento contrario).
//
// Valorización (spec D3): costo promedio ponderado con enteros exactos.
// StockLevel guarda qtyBase + totalValueCents; el promedio es derivado.

/** Kinds de ENTRADA (suman). count_adjust maneja su signo aparte. */
const IN_KINDS: StockMovementKind[] = [
  "purchase_in",
  "adjust_in",
  "transfer_in",
  "production_in",
];
/** Kinds de SALIDA (restan). */
const OUT_KINDS: StockMovementKind[] = [
  "adjust_out",
  "waste",
  "sale_consumption",
  "transfer_out",
  "production_out",
];

/** Costo promedio actual en centavos por unidad base (0 si no hay stock positivo). */
export function avgCostCents(level: {
  qtyBase: number;
  totalValueCents: number;
}): number {
  return level.qtyBase > 0 ? level.totalValueCents / level.qtyBase : 0;
}

export type MovementComputation = {
  /** Cantidad con signo que se suma al saldo. */
  signedQty: number;
  /** Valor con signo que se suma al valor total del saldo. */
  signedValueCents: number;
};

/**
 * Matemática pura del movimiento (testeable sin DB).
 *
 * - Entrada CON costo (purchase_in con totalCostCents): vale su costo.
 * - Entrada SIN costo: se valora al promedio actual (promedio no cambia).
 * - Salida: se valora al promedio actual (eso es el costo de la merma /
 *   consumo que verá el P&L).
 * - count_adjust: el caller pasa signedQty directamente (± según la
 *   diferencia contado − teórico); se valora al promedio actual.
 */
export function computeMovement(args: {
  level: { qtyBase: number; totalValueCents: number };
  kind: StockMovementKind;
  /** Magnitud > 0 para in/out; con signo (≠0) para count_adjust. */
  qtyBase: number;
  /** Solo entradas: costo total de la mercancía que entra. */
  totalCostCents?: number | null;
}): MovementComputation {
  const { level, kind, qtyBase, totalCostCents } = args;
  const avg = avgCostCents(level);

  if (kind === "count_adjust") {
    return {
      signedQty: qtyBase,
      signedValueCents: Math.round(qtyBase * avg),
    };
  }
  if (IN_KINDS.includes(kind)) {
    const value =
      totalCostCents != null && totalCostCents >= 0
        ? totalCostCents
        : Math.round(qtyBase * avg);
    return { signedQty: qtyBase, signedValueCents: value };
  }
  if (OUT_KINDS.includes(kind)) {
    return {
      signedQty: -qtyBase,
      signedValueCents: -Math.round(qtyBase * avg),
    };
  }
  throw new Error(`kind de movimiento desconocido: ${kind}`);
}

export type ApplyStockMovementArgs = {
  restaurantId: string;
  ingredientId: string;
  kind: StockMovementKind;
  /** Magnitud > 0 (in/out) o con signo ≠ 0 (count_adjust). */
  qtyBase: number;
  totalCostCents?: number | null;
  wasteReason?: WasteReason | null;
  note?: string | null;
  stockCountId?: string | null;
  createdById?: string | null;
};

export class StockError extends Error {
  constructor(
    public code:
      | "ingredient_not_found"
      | "ingredient_inactive"
      | "qty_invalid"
      | "cost_invalid",
  ) {
    super(code);
  }
}

/**
 * Aplica un movimiento de inventario DENTRO de una transacción Prisma:
 * valida el insumo, calcula la valorización, actualiza el saldo
 * materializado y appendea el movimiento. Devuelve el movimiento creado y
 * el saldo resultante. El stock PUEDE quedar negativo (spec D4) — nunca
 * rechazamos por falta de existencias.
 *
 * `allowInactive`: los cierres de conteo pueden ajustar insumos que se
 * desactivaron mientras la sesión estaba abierta.
 */
export async function applyStockMovement(
  tx: Prisma.TransactionClient,
  args: ApplyStockMovementArgs,
  opts: { allowInactive?: boolean } = {},
) {
  const {
    restaurantId,
    ingredientId,
    kind,
    qtyBase,
    totalCostCents,
    wasteReason,
    note,
    stockCountId,
    createdById,
  } = args;

  if (
    !Number.isInteger(qtyBase) ||
    qtyBase === 0 ||
    (kind !== "count_adjust" && qtyBase < 0) ||
    Math.abs(qtyBase) > 2_000_000_000
  ) {
    throw new StockError("qty_invalid");
  }
  if (
    totalCostCents != null &&
    (!Number.isInteger(totalCostCents) ||
      totalCostCents < 0 ||
      totalCostCents > 2_000_000_000)
  ) {
    throw new StockError("cost_invalid");
  }

  const ingredient = await tx.ingredient.findUnique({
    where: { id: ingredientId },
    select: { restaurantId: true, active: true },
  });
  if (!ingredient || ingredient.restaurantId !== restaurantId) {
    throw new StockError("ingredient_not_found");
  }
  if (!ingredient.active && !opts.allowInactive) {
    throw new StockError("ingredient_inactive");
  }

  const level =
    (await tx.stockLevel.findUnique({ where: { ingredientId } })) ??
    (await tx.stockLevel.create({
      data: { restaurantId, ingredientId },
    }));

  const { signedQty, signedValueCents } = computeMovement({
    level,
    kind,
    qtyBase,
    totalCostCents,
  });

  const updatedLevel = await tx.stockLevel.update({
    where: { ingredientId },
    data: {
      qtyBase: level.qtyBase + signedQty,
      totalValueCents: level.totalValueCents + signedValueCents,
    },
  });

  const movement = await tx.stockMovement.create({
    data: {
      restaurantId,
      ingredientId,
      kind,
      qtyBase: signedQty,
      valueCents: signedValueCents,
      wasteReason: wasteReason ?? null,
      note: note || null,
      stockCountId: stockCountId ?? null,
      createdById: createdById ?? null,
    },
  });

  return { movement, level: updatedLevel };
}
