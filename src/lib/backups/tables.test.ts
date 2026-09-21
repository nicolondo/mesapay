import { describe, expect, it } from "vitest";
import { Prisma } from "@prisma/client";
import {
  backupModelNames,
  EXCLUDED_MODELS,
  ownerWhere,
  tenantModel,
  tenantModels,
  topologicalOrder,
} from "./tables";

const names = backupModelNames();

describe("tenant model discovery", () => {
  it("includes every model with a restaurantId that is not excluded", () => {
    for (const m of Prisma.dmmf.datamodel.models) {
      const hasRid = m.fields.some((f) => f.kind === "scalar" && f.name === "restaurantId");
      if (!hasRid || EXCLUDED_MODELS.has(m.name)) continue;
      expect(names, m.name).toContain(m.name);
    }
    expect(names).toEqual(expect.arrayContaining(["Table", "MenuItem", "Order", "JournalEntry", "PurchaseOrder"]));
  });
  it("reaches children through required relations and knows the path to the owner", () => {
    expect(tenantModel("OrderItem")?.ownerPath).toEqual(["order"]);
    expect(tenantModel("JournalLine")?.ownerPath).toEqual(["entry"]);
    expect(tenantModel("PurchaseOrderItem")?.ownerPath).toEqual(["purchaseOrder"]);
    expect(tenantModel("SupplierPriceHistory")?.ownerPath).toEqual(["supplierItem", "supplier"]);
    expect(tenantModel("Order")?.ownerPath).toEqual([]);
  });
  it("leaves out the backup table, the event log, sessions, tokens, access and platform records", () => {
    for (const excluded of [
      "RestaurantBackup",
      "PlatformEvent",
      "DinerSession",
      "DinerMagicLink",
      "PasswordResetToken",
      "PushSubscription",
      "User",
      "MembershipPayment",
      "BillingSubscription",
      "CommissionEntry",
      "CrmLead",
      "AuditEvent",
      "DianConfig",
    ]) {
      expect(names, excluded).not.toContain(excluded);
    }
    // Hijos de un excluido tampoco entran (CrmContact cuelga de CrmLead).
    expect(names).not.toContain("CrmContact");
    expect(names).not.toContain("Restaurant");
  });
  it("never includes a model that is unreachable from a restaurant", () => {
    for (const excluded of ["Translation", "RateLimitBucket", "PlatformConfig", "Group", "CrmCity"]) {
      expect(names).not.toContain(excluded);
    }
  });
  it("builds the where clause from the owner path", () => {
    expect(ownerWhere(tenantModel("Order")!, "r1")).toEqual({ restaurantId: "r1" });
    expect(ownerWhere(tenantModel("OrderItem")!, "r1")).toEqual({ order: { restaurantId: "r1" } });
    expect(ownerWhere(tenantModel("SupplierPriceHistory")!, "r1")).toEqual({
      supplierItem: { supplier: { restaurantId: "r1" } },
    });
  });
  it("every model has a single id column and a camelCase delegate", () => {
    for (const m of tenantModels()) {
      expect(m.idField).toBe("id");
      expect(m.delegate).toBe(m.name[0].toLowerCase() + m.name.slice(1));
    }
  });
});

describe("topological order", () => {
  const order = topologicalOrder();
  it("covers every model exactly once, and delete is the mirror of insert", () => {
    expect([...order.insert].sort()).toEqual([...names].sort());
    expect(order.delete).toEqual([...order.insert].reverse());
  });
  it("places every child after its parents", () => {
    const position = new Map(order.insert.map((n, i) => [n, i]));
    for (const m of tenantModels()) {
      for (const fk of m.foreignKeys) {
        if (!position.has(fk.target) || fk.target === m.name) continue;
        expect(position.get(fk.target)!, `${fk.target} before ${m.name}`).toBeLessThan(position.get(m.name)!);
      }
    }
    expect(position.get("Order")!).toBeLessThan(position.get("OrderItem")!);
    expect(position.get("Table")!).toBeLessThan(position.get("Order")!);
    expect(position.get("JournalEntry")!).toBeLessThan(position.get("JournalLine")!);
  });
});
