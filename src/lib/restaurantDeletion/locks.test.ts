import { describe, expect, it } from "vitest";
import { tenantModel, tenantModels } from "@/lib/backups/tables";
import { lockStatement, parentModels } from "./locks";

describe("locks del borrado", () => {
  it("bloquea toda fila del comercio que tenga hijos, padres antes que hijos", () => {
    const parents = parentModels().map((m) => m.name);
    for (const name of ["Table", "Order", "Round", "Payment", "MenuItem", "Diner", "Shift", "SimpleInvoice", "CreditNote", "LedgerAccount", "JournalEntry", "Ingredient", "Supplier", "SupplierIngredient", "PurchaseOrder", "Recipe"]) {
      expect(parents, name).toContain(name);
    }
    expect(parents).not.toContain("JournalLine");
    expect(parents.indexOf("Order")).toBeLessThan(parents.indexOf("Round"));
    expect(parents.indexOf("Supplier")).toBeLessThan(parents.indexOf("SupplierIngredient"));
    // Todo destino de una FK entre tablas del comercio está cubierto.
    const names = new Set(tenantModels().map((m) => m.name));
    for (const m of tenantModels()) {
      for (const fk of m.foreignKeys) if (names.has(fk.target)) expect(parents, `${m.name} → ${fk.target}`).toContain(fk.target);
    }
  });

  it("arma el SELECT … FOR UPDATE por restaurantId directo o por la cadena de dueños, con el comercio como parámetro", () => {
    expect(lockStatement(tenantModel("Order")!)).toBe(
      'SELECT count(*) AS n FROM (SELECT 1 FROM "Order" t0 WHERE t0."restaurantId" = $1 FOR UPDATE OF t0) s',
    );
    expect(lockStatement(tenantModel("Round")!)).toBe(
      'SELECT count(*) AS n FROM (SELECT 1 FROM "Round" t0 JOIN "Order" t1 ON t1."id" = t0."orderId" WHERE t1."restaurantId" = $1 FOR UPDATE OF t0) s',
    );
    expect(lockStatement(tenantModel("SupplierPriceHistory")!)).toBe(
      'SELECT count(*) AS n FROM (SELECT 1 FROM "SupplierPriceHistory" t0 JOIN "SupplierIngredient" t1 ON t1."id" = t0."supplierItemId" JOIN "Supplier" t2 ON t2."id" = t1."supplierId" WHERE t2."restaurantId" = $1 FOR UPDATE OF t0) s',
    );
  });

  it("todas las sentencias se pueden armar (ningún identificador raro en el esquema)", () => {
    for (const m of parentModels()) expect(() => lockStatement(m), m.name).not.toThrow();
  });
});
