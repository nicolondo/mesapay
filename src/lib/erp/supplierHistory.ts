// Lo que un comercio le suele pedir a un proveedor — LÓGICA PURA, sin BD.
//
// Resume las últimas órdenes de compra de UN proveedor por insumo: cuántas
// órdenes lo incluyeron y cómo se pidió la última vez (presentación o
// cantidad suelta, precio de lista, IVA e impuesto al consumo). Con eso
// «Nueva orden» precarga el precio y la presentación de cada insumo y arma
// «Agregar los habituales» sin pedirle nada nuevo a la base: solo lee
// órdenes que ya existen.

export type SupplierHistoryOrderLine = {
  ingredientId: string;
  supplierItemId: string | null;
  presentations: number | null;
  qtyOrderedBase: number;
  /** Neto de lista (antes de descuentos); null en filas sin descuento. */
  listCostCents: number | null;
  /** Neto que se paga (ya descontado). */
  expectedCostCents: number;
  taxPct: number;
  expectedIncCents: number;
  ingredient: { active: boolean };
};

export type SupplierHistoryOrder = {
  createdAt: Date | string;
  items: SupplierHistoryOrderLine[];
};

export type SupplierHistoryItem = {
  ingredientId: string;
  /** En cuántas de las órdenes leídas aparece. */
  orders: number;
  /** Fecha (ISO) de la orden más reciente que lo incluyó. */
  lastOrderedAt: string;
  /** Cómo se pidió la última vez. */
  supplierItemId: string | null;
  presentations: number | null;
  qtyBase: number;
  /** Precio de lista de esa línea, antes de descuentos. */
  listCostCents: number;
  taxPct: number;
  /** Impuesto al consumo de esa línea en % de su neto (2 decimales), o null. */
  incPct: number | null;
};

export type SupplierHistory = {
  /** Órdenes leídas (no anuladas). */
  orderCount: number;
  items: SupplierHistoryItem[];
};

/** % del consumo sobre el neto, con 2 decimales; null si no hay consumo. */
function incPctOf(incCents: number, netCents: number): number | null {
  if (!(incCents > 0) || !(netCents > 0)) return null;
  return Math.round((incCents * 10_000) / netCents) / 100;
}

/**
 * Resume órdenes (de la más reciente a la más vieja) por insumo. Las líneas
 * de insumos inactivos no entran: no se pueden volver a pedir. Orden de
 * salida: los más pedidos primero; a igualdad, el pedido más reciente.
 */
export function summarizeSupplierHistory(
  orders: readonly SupplierHistoryOrder[],
  { limit = 80 }: { limit?: number } = {},
): SupplierHistory {
  const byIngredient = new Map<string, SupplierHistoryItem>();
  const sorted = [...orders].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  );
  for (const order of sorted) {
    const at = new Date(order.createdAt).toISOString();
    const seen = new Set<string>();
    for (const line of order.items) {
      if (!line.ingredient.active || seen.has(line.ingredientId)) continue;
      seen.add(line.ingredientId);
      const prev = byIngredient.get(line.ingredientId);
      if (prev) {
        prev.orders += 1;
        continue;
      }
      byIngredient.set(line.ingredientId, {
        ingredientId: line.ingredientId,
        orders: 1,
        lastOrderedAt: at,
        supplierItemId: line.supplierItemId,
        presentations: line.supplierItemId ? line.presentations : null,
        qtyBase: line.qtyOrderedBase,
        listCostCents: line.listCostCents ?? line.expectedCostCents,
        taxPct: line.taxPct,
        incPct: incPctOf(line.expectedIncCents, line.expectedCostCents),
      });
    }
  }
  const items = [...byIngredient.values()].sort(
    (a, b) => b.orders - a.orders || b.lastOrderedAt.localeCompare(a.lastOrderedAt),
  );
  return { orderCount: sorted.length, items: items.slice(0, limit) };
}

/**
 * «Los habituales» del proveedor: lo que aparece en al menos dos de sus
 * órdenes; si solo hay una orden (o nada se repite), lo de la última.
 * Vacío si nunca se le ha pedido nada.
 */
export function habitualHistoryItems(history: SupplierHistory, max = 40): SupplierHistoryItem[] {
  if (history.items.length === 0) return [];
  const repeated = history.items.filter((i) => i.orders >= 2);
  if (repeated.length > 0) return repeated.slice(0, max);
  const latest = history.items.reduce((m, i) => (i.lastOrderedAt > m ? i.lastOrderedAt : m), "");
  return history.items.filter((i) => i.lastOrderedAt === latest).slice(0, max);
}
