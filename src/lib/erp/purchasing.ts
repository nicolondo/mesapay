import type { Prisma, PurchaseOrderStatus } from "@prisma/client";
import { applyStockMovement } from "@/lib/erp/stock";
import { normalizeTaxPct, PURCHASE_LINE_AMOUNTS_SELECT, purchaseLineAmounts, purchaseOrderTotals, receivedPurchaseLineAmounts } from "@/lib/erp/purchaseTax";
import { resolveOrderDiscounts } from "@/lib/erp/purchaseDiscount";
import { lineTaxEditable, PURCHASE_MAX_CENTS, receptionLineTax } from "@/lib/erp/purchaseLineTax";
import {
  purchaseRetentionError,
  retentionTotalCents,
  type PurchaseRetentionTotals,
} from "@/lib/erp/purchaseRetentions";

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
      | "not_pending"
      | "line_invalid"
      | "po_not_found"
      | "wrong_status"
      | "nothing_to_receive"
      // Retenciones de la factura (recepción): una supera su base / entre
      // todas superan el total de la entrega.
      | "retention_exceeds_base"
      | "retention_exceeds_total"
      // El impuesto de una línea ya se fijó con su primera entrega.
      | "line_tax_locked",
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
  /**
   * Costo NETO (sin IVA) de LISTA de la línea, en centavos — lo que digita el
   * operador ANTES de descuentos. Lo que se persiste en expectedCostCents es
   * este valor ya descontado.
   */
  expectedCostCents: number;
  /** IVA % de la línea (0/5/19 CO, 0/8/16 MX). Default 0. */
  taxPct?: number | null;
  /** IVA documental total después de descuentos; null conserva taxPct. */
  expectedTaxCents?: number | null;
  /** Consumo fijo total de la línea, no por unidad. */
  expectedIncCents?: number;
  /** Descuento propio de la línea: % o valor fijo (el % manda). */
  discountPct?: number | null;
  discountCents?: number | null;
};

export async function createPurchaseOrder(
  tx: Prisma.TransactionClient,
  args: {
    restaurantId: string;
    supplierId: string;
    lines: CreatePoLine[];
    /** Descuento del pie, sobre el total ya descontado por línea. */
    discountPct?: number | null;
    discountCents?: number | null;
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
    /** Neto de lista digitado (antes de descuentos). */
    listCostCents: number;
    discountPct: number | null;
    discountCents: number | null;
    taxPct: number;
    expectedTaxCents: number | null;
    expectedIncCents: number;
  }> = [];

  for (const line of lines) {
    if (
      !Number.isInteger(line.expectedCostCents) ||
      line.expectedCostCents < 0 ||
      line.expectedCostCents > 2_000_000_000
    ) {
      throw new PurchasingError("line_invalid");
    }
    for (const cents of [line.expectedTaxCents, line.expectedIncCents]) {
      if (cents != null && (!Number.isInteger(cents) || cents < 0 || cents > 2_000_000_000)) {
        throw new PurchasingError("line_invalid");
      }
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
        listCostCents: line.expectedCostCents,
        discountPct: line.discountPct ?? null,
        discountCents: line.discountCents ?? null,
        taxPct: normalizeTaxPct(line.taxPct ?? 0),
        expectedTaxCents: line.expectedTaxCents ?? null,
        expectedIncCents: line.expectedIncCents ?? 0,
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
        listCostCents: line.expectedCostCents,
        discountPct: line.discountPct ?? null,
        discountCents: line.discountCents ?? null,
        taxPct: normalizeTaxPct(line.taxPct ?? 0),
        expectedTaxCents: line.expectedTaxCents ?? null,
        expectedIncCents: line.expectedIncCents ?? 0,
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

  // Descuentos: primero el de cada línea, después el del pie prorrateado
  // sobre lo que quedó. expectedCostCents queda ya descontado — de ahí
  // cuelgan IVA, costo de inventario y CxP sin tratamiento especial.
  const applied = resolveOrderDiscounts(
    resolved.map((r) => ({
      listCents: r.listCostCents,
      discount: { pct: r.discountPct, cents: r.discountCents },
    })),
    { pct: args.discountPct, cents: args.discountCents },
  );

  for (let i = 0; i < resolved.length; i += 1) {
    const line = resolved[i];
    const net = applied.lines[i].netCents;
    if ((net === 0 && (line.expectedTaxCents ?? 0) > 0)
      || purchaseLineAmounts({ ...line, expectedCostCents: net }).totalCents > 2_000_000_000) {
      throw new PurchasingError("line_invalid");
    }
  }
  const allocatedIncCents = resolved.reduce((sum, line) => sum + line.expectedIncCents, 0);
  if (allocatedIncCents > 2_000_000_000) throw new PurchasingError("line_invalid");

  return tx.purchaseOrder.create({
    data: {
      restaurantId,
      supplierId,
      number,
      notes: args.notes || null,
      expectedAt: args.expectedAt ?? null,
      createdById: args.createdById ?? null,
      discountPct: args.discountPct ?? null,
      discountCents: applied.subtotalCents - applied.netCents,
      incCents: allocatedIncCents,
      items: {
        create: resolved.map((r, i) => {
          const a = applied.lines[i]!;
          return {
            ingredientId: r.ingredientId,
            supplierItemId: r.supplierItemId,
            presentations: r.presentations,
            qtyOrderedBase: r.qtyOrderedBase,
            taxPct: r.taxPct,
            expectedTaxCents: r.expectedTaxCents,
            expectedIncCents: r.expectedIncCents,
            expectedCostCents: a.netCents,
            listCostCents: a.listCents,
            discountPct: r.discountPct,
            discountCents: a.lineDiscountCents,
            orderDiscountCents: a.orderDiscountCents,
          };
        }),
      },
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
  /**
   * Impuesto de la línea según la factura, si cambia el de la orden: tarifa
   * de IVA y consumo de ESTA entrega (centavos). Solo en una línea sin nada
   * recibido — después el impuesto queda fijo (las recepciones parciales se
   * reparten con el mismo impuesto documental). Ausente = el de la orden.
   */
  taxPct?: number | null;
  incCents?: number | null;
};

const EMPTY_RETENTIONS: PurchaseRetentionTotals = { retefuenteCents: 0, reteIvaCents: 0, reteIcaCents: 0 };

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
    /**
     * Retenciones que el comercio practica sobre la factura de ESTA entrega.
     * Se validan contra lo recibido (ver purchaseRetentions.ts) y se SUMAN a
     * las de la compra.
     */
    retentions?: PurchaseRetentionTotals | null;
    createdById?: string | null;
  },
) {
  const { restaurantId, purchaseOrderId, lines } = args;
  const ivaDeductible = args.ivaDeductible ?? false;
  const retentions = args.retentions ?? EMPTY_RETENTIONS;
  if (!lines.length) throw new PurchasingError("nothing_to_receive");
  if (new Set(lines.map((line) => line.itemId)).size !== lines.length) {
    throw new PurchasingError("line_invalid");
  }
  const isCents = (n: number | null | undefined) =>
    n == null || (Number.isInteger(n) && n >= 0 && n <= PURCHASE_MAX_CENTS);
  for (const l of lines) {
    if (
      !Number.isInteger(l.qtyBase) ||
      l.qtyBase < 1 ||
      !Number.isInteger(l.costCents) ||
      l.costCents < 0 ||
      l.qtyBase > 2_000_000_000 ||
      l.costCents > 2_000_000_000 ||
      !isCents(l.incCents) ||
      (l.taxPct != null && (!Number.isInteger(l.taxPct) || l.taxPct < 0 || l.taxPct > 100))
    ) {
      throw new PurchasingError("line_invalid");
    }
  }
  if (![retentions.retefuenteCents, retentions.reteIvaCents, retentions.reteIcaCents].every(isCents)) {
    throw new PurchasingError("line_invalid");
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

  // Impuesto de la factura distinto al de la orden (IVA y/o consumo). Se
  // reescribe el impuesto documental de la línea ANTES de registrar, así el
  // inventario, la CxP y el asiento salen del mismo camino de siempre. Solo
  // en líneas sin nada recibido: con una entrega previa el reparto
  // acumulado (acumulado − anterior) ya usó el impuesto de la orden.
  let incDelta = 0;
  for (const line of lines) {
    if (line.taxPct == null && line.incCents == null) continue;
    const item = itemById.get(line.itemId);
    if (!item) throw new PurchasingError("line_invalid");
    const next = receptionLineTax(item, line, line.qtyBase, line.costCents);
    if (!next.changed) continue;
    if (!lineTaxEditable(item)) throw new PurchasingError("line_tax_locked");
    if (next.expectedIncCents > PURCHASE_MAX_CENTS) throw new PurchasingError("line_invalid");
    const data = {
      taxPct: next.taxPct,
      expectedTaxCents: next.expectedTaxCents,
      expectedIncCents: next.expectedIncCents,
    };
    await tx.purchaseOrderItem.update({ where: { id: item.id }, data });
    incDelta += next.expectedIncCents - item.expectedIncCents;
    itemById.set(item.id, { ...item, ...data });
  }
  const headerIncCents = po.incCents + incDelta;
  if (headerIncCents < 0 || headerIncCents > PURCHASE_MAX_CENTS) throw new PurchasingError("line_invalid");

  // Lo que trae ESTA entrega: la base de sus retenciones.
  const reception = { baseCents: 0, ivaCents: 0, incCents: 0 };

  for (const line of lines) {
    const item = itemById.get(line.itemId);
    if (!item) throw new PurchasingError("line_invalid");
    const previous = receivedPurchaseLineAmounts(item);
    const accumulated = purchaseLineAmounts(item, item.receivedCostCents + line.costCents, item.receivedQtyBase + line.qtyBase);
    const receivedTaxCents = accumulated.taxCents - previous.taxCents;
    const receivedIncCents = accumulated.incCents - previous.incCents;
    const inventoryCost = line.costCents + receivedIncCents + (ivaDeductible ? 0 : receivedTaxCents);
    reception.baseCents += line.costCents;
    reception.ivaCents += receivedTaxCents;
    reception.incCents += receivedIncCents;
    if (inventoryCost > 2_000_000_000
      || item.receivedQtyBase + line.qtyBase > 2_000_000_000
      || item.receivedCostCents + line.costCents > 2_000_000_000) {
      throw new PurchasingError("line_invalid");
    }

    const movement = await applyStockMovement(
      tx,
      {
        restaurantId,
        ingredientId: item.ingredientId,
        kind: "purchase_in",
        qtyBase: line.qtyBase,
        // El inventario se valora al neto (IVA descontable) o al bruto
        // (IVA parte del costo). receivedCostCents y la lista de precios
        // se quedan en NETO — solo el ledger cambia con el ajuste.
        totalCostCents: inventoryCost,
        purchaseOrderId,
        createdById: args.createdById ?? null,
      },
      // La OC pudo armarse antes de que el insumo se desactivara; la
      // mercancía llega igual y hay que registrarla.
      { allowInactive: true, skipUntracked: true },
    );

    await tx.purchaseOrderItem.update({
      where: { id: item.id },
      data: {
        receivedQtyBase: item.receivedQtyBase + line.qtyBase,
        receivedCostCents: item.receivedCostCents + line.costCents,
        // Freeze treatment at reception, so future tracking toggles do not
        // rewrite a supplier invoice's historical accounting classification.
        nonInventoryReceivedCostCents: {
          increment: movement === null ? line.costCents : 0,
        },
        nonInventoryReceivedNonDeductibleTaxCents: {
          // Match the supplier invoice's cumulative line rounding. Summing
          // rounded per-reception taxes can otherwise exceed invoice VAT.
          increment: movement === null && !ivaDeductible
            ? receivedTaxCents
            : 0,
        },
        nonInventoryReceivedIncCents: {
          increment: movement === null ? receivedIncCents : 0,
        },
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

  // Retenciones de la factura de esta entrega: sobre lo recibido, y se
  // suman a las de la compra (también a la parte «practicada al recibir»,
  // que la CxP no reparte según el avance).
  const retained = retentionTotalCents(retentions);
  if (retained > 0) {
    const error = purchaseRetentionError(retentions, reception);
    if (error) throw new PurchasingError(error);
  }
  const header = {
    incCents: headerIncCents,
    retefuenteCents: po.retefuenteCents + retentions.retefuenteCents,
    reteIvaCents: po.reteIvaCents + retentions.reteIvaCents,
    reteIcaCents: po.reteIcaCents + retentions.reteIcaCents,
    receptionRetentionCents: po.receptionRetentionCents + retained,
  };
  if (Object.values(header).some((cents) => cents > PURCHASE_MAX_CENTS)) {
    throw new PurchasingError("line_invalid");
  }

  // Recalcular estado con los acumulados frescos.
  const freshItems = await tx.purchaseOrderItem.findMany({
    where: { purchaseOrderId },
    select: PURCHASE_LINE_AMOUNTS_SELECT,
  });
  const complete = freshItems.every(
    (i) => i.receivedQtyBase >= i.qtyOrderedBase,
  );
  const now = new Date();
  const balanceReopened = po.paidAt != null
    && purchaseOrderTotals({ ...header, items: freshItems }, "received").totalCents > po.paidCents;
  const updated = await tx.purchaseOrder.update({
    where: { id: purchaseOrderId },
    data: {
      ...(incDelta !== 0 ? { incCents: header.incCents } : {}),
      ...(retained > 0
        ? {
            retefuenteCents: header.retefuenteCents,
            reteIvaCents: header.reteIvaCents,
            reteIcaCents: header.reteIcaCents,
            receptionRetentionCents: header.receptionRetentionCents,
          }
        : {}),
      // A new receipt can exceed the amount already paid for an earlier
      // partial delivery. Payments stay unchanged; refresh only its cache.
      ...(balanceReopened ? { paidAt: null } : {}),
      ...(complete
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
      : { status: "partially_received" }),
    },
  });

  return { purchaseOrder: updated, complete };
}
