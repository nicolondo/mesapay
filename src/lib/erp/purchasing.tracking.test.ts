import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Prisma } from "@prisma/client";
const movement = vi.hoisted(() => vi.fn());
vi.mock("@/lib/erp/stock", () => ({ applyStockMovement: movement }));
import { receivePurchaseOrder } from "./purchasing";
function fixture() {
  const tx = {
    purchaseOrder: {
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      findUniqueOrThrow: vi.fn().mockResolvedValue({ supplier: { paymentTermsDays: null }, items: [{ id: "line", ingredientId: "i", taxPct: 19, receivedQtyBase: 0, receivedCostCents: 0, supplierItemId: null }] }),
      update: vi.fn().mockResolvedValue({ id: "po", status: "received" }),
    },
    purchaseOrderItem: { update: vi.fn(), findMany: vi.fn().mockResolvedValue([{ qtyOrderedBase: 1, receivedQtyBase: 1 }]) },
  };
  return { tx, client: tx as unknown as Prisma.TransactionClient };
}
beforeEach(() => { movement.mockReset(); });
describe("frozen non-stock reception values", () => {
  it("rejects duplicate receipt lines before any claims or stock writes", async () => {
    const { tx, client } = fixture();
    await expect(receivePurchaseOrder(client, { restaurantId: "r", purchaseOrderId: "po", lines: [
      { itemId: "line", qtyBase: 1, costCents: 10000 },
      { itemId: "line", qtyBase: 2, costCents: 20000 },
    ] })).rejects.toMatchObject({ code: "line_invalid" });
    expect(tx.purchaseOrder.updateMany).not.toHaveBeenCalled();
    expect(tx.purchaseOrderItem.update).not.toHaveBeenCalled();
    expect(movement).not.toHaveBeenCalled();
  });
  it.each([true, false])("preserves receipt net and freezes non-deductible VAT when deductible=%s", async (ivaDeductible) => {
    const { tx, client } = fixture();
    movement.mockResolvedValue(null);
    await receivePurchaseOrder(client, { restaurantId: "r", purchaseOrderId: "po", ivaDeductible, lines: [{ itemId: "line", qtyBase: 1, costCents: 10000 }] });
    expect(tx.purchaseOrderItem.update).toHaveBeenCalledWith({ where: { id: "line" }, data: {
      receivedQtyBase: 1, receivedCostCents: 10000,
      nonInventoryReceivedCostCents: { increment: 10000 },
      nonInventoryReceivedNonDeductibleTaxCents: { increment: ivaDeductible ? 0 : 1900 },
    } });
  });
  it.each([[3, 3, 1, 0], [2, 2, 0, 1]])("uses cumulative invoice VAT for partial net amounts %i + %i", async (firstCost, secondCost, firstTax, secondTax) => {
    const { tx, client } = fixture();
    movement.mockResolvedValue(null);
    await receivePurchaseOrder(client, { restaurantId: "r", purchaseOrderId: "po", lines: [{ itemId: "line", qtyBase: 1, costCents: firstCost }] });
    const po = await tx.purchaseOrder.findUniqueOrThrow();
    po.items[0].receivedCostCents = firstCost;
    po.items[0].receivedQtyBase = 1;
    await receivePurchaseOrder(client, { restaurantId: "r", purchaseOrderId: "po", lines: [{ itemId: "line", qtyBase: 1, costCents: secondCost }] });
    expect(tx.purchaseOrderItem.update.mock.calls[0][0].data.nonInventoryReceivedNonDeductibleTaxCents.increment).toBe(firstTax);
    expect(tx.purchaseOrderItem.update.mock.calls[1][0].data.nonInventoryReceivedNonDeductibleTaxCents.increment).toBe(secondTax);
    expect(firstTax + secondTax).toBe(Math.round((firstCost + secondCost) * .19));
  });
  it("does not reclassify tracked purchases", async () => {
    const { tx, client } = fixture();
    movement.mockResolvedValue({ movement: { id: "m" } });
    await receivePurchaseOrder(client, { restaurantId: "r", purchaseOrderId: "po", lines: [{ itemId: "line", qtyBase: 1, costCents: 10000 }] });
    expect(tx.purchaseOrderItem.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ nonInventoryReceivedCostCents: { increment: 0 }, nonInventoryReceivedNonDeductibleTaxCents: { increment: 0 } }) }));
  });
});
