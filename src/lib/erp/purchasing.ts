import type { Prisma, PurchaseOrderStatus } from "@prisma/client";
import { applyStockMovement } from "@/lib/erp/stock";
import { inventoryCostCents, normalizeTaxPct } from "@/lib/erp/purchaseTax";

// Lógica central de compras (ERP Fase A2).
//
// createPurchaseOrder / receivePurchaseOrder corren SIEMPRE dentro de una
// transacción. La recepción usa applyStockMovement (el único camino de
// escritura de inventario de A1): stock + costo promedio se actualizan en
// la misma tx, y el libro (StockMovement.purchaseOrderId) ES el registro
// de recepción — sin modelo aparte.

export class PurchasingError extends Error {
  constructor(
    public code:
      | "supplier_not_found"
      | "ingredient_not_found"
      | "supplier_item_mismatch"
      | "no_lines"
      | "line_invalid"
      | "po_not_found"
      | "wrong_status"
      | "nothing_to_receive",
  ) {
    super(code);
  }
}

// ── Creación ────────────────────────────────────────────────────────────────

export type CreatePoLine = {
  ingredientId: string;
  /** Presentación de la lista de precios (opcional). */
  supplierItemId?: string | null;
  /** # de presentaciones (requerido si hay supplierItemId). */
  presentations?: number | null;
  /** Cantidad en unidad base (requerida si NO hay presentación). */
  qtyBase?: number | null;
  /** Costo NETO (sin IVA) esperado de la línea, en centavos. */
  expectedCostCents: number;
  /** IVA % de la línea (0/5/19 CO, 0/8/16 MX). Default 0. */
  taxPct?: number | null;
};

export async function createPurchaseOrder(
  tx: Prisma.TransactionClient,
  args: {
    restaurantId: string;
    supplierId: string;
    lines: CreatePoLine[];
    notes?: string | null;
    expectedAt?: Date | null;
    createdById?: string | null;
  },
) {
  const { restaurantId, supplierId, lines } = args;
  if (!lines.length) throw new PurchasingError("no_lines");

  const supplier = await tx.supplier.findUnique({
    where: { id: supplierId },
    select: { restaurantId: true, active: true },
  });
  if (!supplier || supplier.restaurantId !== restaurantId || !supplier.active) {
    throw new PurchasingError("supplier_not_found");
  }

  // Resolver y validar cada línea → qtyOrderedBase.
  const resolved: Array<{
    ingredientId: string;
    supplierItemId: string | null;
    presentations: number | null;
    qtyOrderedBase: number;
    expectedCostCents: number;
    taxPct: number;
  }> = [];

  for (const line of lines) {
    if (
      !Number.isInteger(line.expectedCostCents) ||
      line.expectedCostCents < 0 ||
      line.expectedCostCents > 2_000_000_000
    ) {
      throw new PurchasingError("line_invalid");
    }
    const ingredient = await tx.ingredient.findUnique({
      where: { id: line.ingredientId },
      select: { restaurantId: true, active: true },
    });
    if (
      !ingredient ||
      ingredient.restaurantId !== restaurantId ||
      !ingredient.active
    ) {
      throw new PurchasingError("ingredient_not_found");
    }

    if (line.supplierItemId) {
      // Línea desde la lista de precios: qtyBase = n × contenido.
      const si = await tx.supplierIngredient.findUnique({
        where: { id: line.supplierItemId },
        select: { supplierId: true, ingredientId: true, contentQty: true },
      });
      if (
        !si ||
        si.supplierId !== supplierId ||
        si.ingredientId !== line.ingredientId
      ) {
        throw new PurchasingError("supplier_item_mismatch");
      }
      const n = line.presentations ?? 0;
      if (!Number.isInteger(n) || n < 1 || n > 100_000) {
        throw new PurchasingError("line_invalid");
      }
      resolved.push({
        ingredientId: line.ingredientId,
        supplierItemId: line.supplierItemId,
        presentations: n,
        qtyOrderedBase: n * si.contentQty,
        expectedCostCents: line.expectedCostCents,
        taxPct: normalizeTaxPct(line.taxPct ?? 0),
      });
    } else {
      const q = line.qtyBase ?? 0;
      if (!Number.isInteger(q) || q < 1 || q > 2_000_000_000) {
        throw new PurchasingError("line_invalid");
      }
      resolved.push({
        ingredientId: line.ingredientId,
        supplierItemId: null,
        presentations: null,
        qtyOrderedBase: q,
        expectedCostCents: line.expectedCostCents,
        taxPct: normalizeTaxPct(line.taxPct ?? 0),
      });
    }
  }

  // Consecutivo por comercio (max+1 dentro de la tx — spec D7).
  const last = await tx.purchaseOrder.findFirst({
    where: { restaurantId },
    orderBy: { number: "desc" },
    select: { number: true },
  });
  const number = (last?.number ?? 0) + 1;

  return tx.purchaseOrder.create({
    data: {
      restaurantId,
      supplierId,
      number,
      notes: args.notes || null,
      expectedAt: args.expectedAt ?? null,
      createdById: args.createdById ?? null,
      items: { create: resolved },
    },
    include: {
      items: {
        include: {
          ingredient: { select: { id: true, name: true, measureKind: true } },
          supplierItem: {
            select: { id: true, presentationLabel: true, contentQty: true },
          },
        },
      },
      supplier: { select: { id: true, name: true, phone: true, paymentTermsDays: true } },
    },
  });
}

// ── Recepción ───────────────────────────────────────────────────────────────

const RECEIVABLE: PurchaseOrderStatus[] = [
  "draft",
  "sent",
  "partially_received",
];

export type ReceiveLine = {
  itemId: string;
  /** Cantidad recibida en unidad base (> 0). */
  qtyBase: number;
  /** Costo REAL total de lo recibido en esta línea, en centavos. */
  costCents: number;
};

/**
 * Recepción (total o parcial) de una OC. Por cada línea: purchase_in vía
 * applyStockMovement (actualiza stock + promedio), acumula en la línea,
 * actualiza el precio del proveedor + historial cuando la línea viene de
 * la lista de precios, y recalcula el estado. Sobre-recepción permitida.
 */
export async function receivePurchaseOrder(
  tx: Prisma.TransactionClient,
  args: {
    restaurantId: string;
    purchaseOrderId: string;
    lines: ReceiveLine[];
    /** ¿IVA descontable? Decide si el inventario se valora al neto o al bruto. */
    ivaDeductible?: boolean;
    createdById?: string | null;
  },
) {
  const { restaurantId, purchaseOrderId, lines } = args;
  const ivaDeductible = args.ivaDeductible ?? false;
  if (!lines.length) throw new PurchasingError("nothing_to_receive");
  for (const l of lines) {
    if (
      !Number.isInteger(l.qtyBase) ||
      l.qtyBase < 1 ||
      !Number.isInteger(l.costCents) ||
      l.costCents < 0 ||
      l.qtyBase > 2_000_000_000 ||
      l.costCents > 2_000_000_000
    ) {
      throw new PurchasingError("line_invalid");
    }
  }

  // Reclamo race-safe del estado (patrón del cierre de conteos): tocamos
  // updatedAt condicionado al estado recibible; 0 filas = estado inválido
  // o carrera con otra recepción/cancelación.
  const claimed = await tx.purchaseOrder.updateMany({
    where: {
      id: purchaseOrderId,
      restaurantId,
      status: { in: RECEIVABLE },
    },
    data: { updatedAt: new Date() },
  });
  if (claimed.count === 0) {
    const exists = await tx.purchaseOrder.findFirst({
      where: { id: purchaseOrderId, restaurantId },
      select: { id: true },
    });
    throw new PurchasingError(exists ? "wrong_status" : "po_not_found");
  }

  const po = await tx.purchaseOrder.findUniqueOrThrow({
    where: { id: purchaseOrderId },
    include: {
      supplier: { select: { paymentTermsDays: true } },
      items: { include: { supplierItem: { select: { id: true } } } },
    },
  });
  const itemById = new Map(po.items.map((i) => [i.id, i]));

  for (const line of lines) {
    const item = itemById.get(line.itemId);
    if (!item) throw new PurchasingError("line_invalid");

    await applyStockMovement(
      tx,
      {
        restaurantId,
        ingredientId: item.ingredientId,
        kind: "purchase_in",
        qtyBase: line.qtyBase,
        // El inventario se valora al neto (IVA descontable) o al bruto
        // (IVA parte del costo). receivedCostCents y la lista de precios
        // se quedan en NETO — solo el ledger cambia con el ajuste.
        totalCostCents: inventoryCostCents(
          line.costCents,
          item.taxPct,
          ivaDeductible,
        ),
        purchaseOrderId,
        createdById: args.createdById ?? null,
      },
      // La OC pudo armarse antes de que el insumo se desactivara; la
      // mercancía llega igual y hay que registrarla.
      { allowInactive: true },
    );

    await tx.purchaseOrderItem.update({
      where: { id: item.id },
      data: {
        receivedQtyBase: item.receivedQtyBase + line.qtyBase,
        receivedCostCents: item.receivedCostCents + line.costCents,
      },
    });

    // Precio real por presentación → lista de precios + historial (D4).
    if (item.supplierItemId && item.presentations) {
      const si = await tx.supplierIngredient.findUnique({
        where: { id: item.supplierItemId },
        select: { contentQty: true, lastPriceCents: true },
      });
      if (si && si.contentQty > 0) {
        const presentationsReceived = line.qtyBase / si.contentQty;
        if (presentationsReceived > 0) {
          const pricePerPresentation = Math.round(
            line.costCents / presentationsReceived,
          );
          if (
            pricePerPresentation > 0 &&
            pricePerPresentation !== si.lastPriceCents
          ) {
            await tx.supplierIngredient.update({
              where: { id: item.supplierItemId },
              data: { lastPriceCents: pricePerPresentation },
            });
            await tx.supplierPriceHistory.create({
              data: {
                supplierItemId: item.supplierItemId,
                priceCents: pricePerPresentation,
                source: "reception",
                purchaseOrderId,
              },
            });
          }
        }
      }
    }
  }

  // Recalcular estado con los acumulados frescos.
  const freshItems = await tx.purchaseOrderItem.findMany({
    where: { purchaseOrderId },
    select: { qtyOrderedBase: true, receivedQtyBase: true },
  });
  const complete = freshItems.every(
    (i) => i.receivedQtyBase >= i.qtyOrderedBase,
  );
  const now = new Date();
  const updated = await tx.purchaseOrder.update({
    where: { id: purchaseOrderId },
    data: complete
      ? {
          status: "received",
          receivedAt: po.receivedAt ?? now,
          // Vencimiento default: recepción + condiciones del proveedor.
          invoiceDueAt:
            po.invoiceDueAt ??
            (po.supplier.paymentTermsDays != null
              ? new Date(
                  now.getTime() +
                    po.supplier.paymentTermsDays * 86_400_000,
                )
              : now),
        }
      : { status: "partially_received" },
  });

  return { purchaseOrder: updated, complete };
}
