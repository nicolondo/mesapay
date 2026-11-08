/** A purchase cost is the weighted cost of the received quantity of one PO.
 * It is a read model, not a stock revaluation or a replacement manual price. */
export type PurchaseCostDateBasis = "line_received" | "order_received" | "stock_movement" | "order_created";

export type PurchaseCostDTO = {
  purchaseOrderId: string;
  purchaseOrderNumber: number;
  supplierName: string;
  qtyBase: number;
  totalCostCents: number;
  costPerBase: number;
  /** ISO date; dateBasis distinguishes actual receipt evidence from an old PO's creation date. */
  receivedAt: string;
  dateBasis: PurchaseCostDateBasis;
};

/** Aggregation is by PO + ingredient: the ledger has no purchase-line FK. */
export type PurchaseCostAggregate = {
  ingredientId: string;
  purchaseOrderId: string;
  purchaseOrderNumber: number;
  supplierName: string;
  status: string;
  createdAt: Date;
  orderReceivedAt: Date | null;
  lastReceivedAt: Date | null;
  movementReceivedAt: Date | null;
  qtyBase: bigint;
  netCents: bigint;
  nonInventoryNetCents: bigint;
  nonInventoryVatCents: bigint;
  nonInventoryIncCents: bigint;
  movementQtyBase: bigint;
  movementValueCents: bigint;
  invalidLines: boolean;
  invalidMovements: boolean;
};

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const validDate = (date: Date) => Number.isFinite(date.getTime());

/** Missing/contradictory receipt evidence must never turn into a zero cost. */
export function purchaseCostFromAggregate(row: PurchaseCostAggregate): PurchaseCostDTO | null {
  if (row.status !== "received" && row.status !== "partially_received") return null;
  if (row.invalidLines || row.invalidMovements || row.qtyBase <= BigInt(0)) return null;
  const amounts = [row.qtyBase, row.netCents, row.nonInventoryNetCents,
    row.nonInventoryVatCents, row.nonInventoryIncCents, row.movementQtyBase, row.movementValueCents];
  if (amounts.some((value) => value < BigInt(0) || value > MAX_SAFE)) return null;
  if (row.nonInventoryNetCents > row.netCents || row.movementQtyBase > row.qtyBase) return null;
  const trackedNetCents = row.netCents - row.nonInventoryNetCents;
  if ((trackedNetCents > BigInt(0) && row.movementQtyBase === BigInt(0)) || row.movementValueCents < trackedNetCents) return null;
  if (row.movementQtyBase === BigInt(0) && row.movementValueCents !== BigInt(0)) return null;
  if (row.movementQtyBase === row.qtyBase &&
      (row.nonInventoryNetCents > BigInt(0) || row.nonInventoryVatCents > BigInt(0) || row.nonInventoryIncCents > BigInt(0))) return null;

  // Tracked VAT/INC is already capitalized in the ledger. Non-stock VAT/INC
  // was frozen in its line on reception. Current tax settings are irrelevant.
  const totalCost = row.movementValueCents + row.nonInventoryNetCents
    + row.nonInventoryVatCents + row.nonInventoryIncCents;
  if (totalCost > MAX_SAFE) return null;
  const dates = [row.createdAt, row.orderReceivedAt, row.lastReceivedAt, row.movementReceivedAt];
  if (dates.some((date) => date !== null && !validDate(date))) return null;

  let date = row.createdAt;
  let dateBasis: PurchaseCostDateBasis = "order_created";
  if (row.lastReceivedAt) {
    date = row.lastReceivedAt;
    dateBasis = "line_received";
  } else if (row.status === "received" && row.orderReceivedAt) {
    date = row.orderReceivedAt;
    dateBasis = "order_received";
  } else if (row.movementQtyBase === row.qtyBase && row.movementReceivedAt) {
    date = row.movementReceivedAt;
    dateBasis = "stock_movement";
  }

  const qtyBase = Number(row.qtyBase);
  const totalCostCents = Number(totalCost);
  return {
    purchaseOrderId: row.purchaseOrderId,
    purchaseOrderNumber: row.purchaseOrderNumber,
    supplierName: row.supplierName,
    qtyBase, totalCostCents, costPerBase: totalCostCents / qtyBase,
    receivedAt: date.toISOString(), dateBasis,
  };
}
